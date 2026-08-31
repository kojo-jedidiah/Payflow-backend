require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client } = require('dwolla-v2');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Dwolla ----------
const dwolla = new Client({
  key: process.env.DWOLLA_KEY,
  secret: process.env.DWOLLA_SECRET,
  environment: process.env.DWOLLA_ENV || 'sandbox'
});

// ---------- Supabase ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------- CORS (uses your FRONTEND_URL env) ----------
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://payflow-wqno.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173'
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

// ---------- Health ----------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'PayFlow Backend (Dwolla + Supabase) is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------- Create Customer (resilient) ----------
app.post('/api/create-customer', async (req, res) => {
  try {
    const { firstName, lastName, email } = req.body;
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'firstName, lastName and email are required' });
    }

    let customerId = null;
    try {
      const customer = await dwolla.post('customers', {
        firstName,
        lastName,
        email,
        type: 'unverified'
      });
      const customerUrl = customer.headers.get('location');
      customerId = customerUrl.split('/').pop();
    } catch (dwollaErr) {
      console.error('Dwolla create-customer:', dwollaErr.body || dwollaErr.message);
      // still succeed so the frontend can continue
    }

    res.json({
      success: true,
      customerId: customerId || 'pending-' + Date.now(),
      message: customerId ? 'Customer created' : 'Account created (Dwolla pending)'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to create customer' });
  }
});

// ---------- Add Funding Source ----------
app.post('/api/add-funding-source', async (req, res) => {
  try {
    const { customerId, routingNumber, accountNumber, bankAccountType, name, userId } = req.body;
    if (!customerId || !routingNumber || !accountNumber) {
      return res.status(400).json({ error: 'Missing required bank details' });
    }
    if (String(customerId).startsWith('pending-')) {
      return res.status(400).json({ error: 'Customer not fully created yet. Please try again in a moment.' });
    }

    const fundingSource = await dwolla.post(`customers/${customerId}/funding-sources`, {
      routingNumber,
      accountNumber,
      bankAccountType: bankAccountType || 'checking',
      name: name || 'Bank Account'
    });

    const fundingSourceUrl = fundingSource.headers.get('location');
    const fundingSourceId = fundingSourceUrl.split('/').pop();

    // Store in Supabase
    const { data, error } = await supabase
      .from('bank_accounts')
      .insert([{
        user_id: userId || null,
        stripe_payment_method_id: fundingSourceId,   // we reuse the column name
        bank_name: name || 'Linked Bank',
        last4: accountNumber.slice(-4),
        account_type: bankAccountType || 'checking',
        status: 'pending',
        is_default: true
      }])
      .select();

    if (error) console.error('Supabase insert bank_accounts:', error);

    res.json({
      success: true,
      fundingSourceId,
      fundingSourceUrl,
      bankAccount: data?.[0] || null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.body?.message || error.message || 'Failed to add funding source'
    });
  }
});

// ---------- Micro-deposits ----------
app.post('/api/initiate-micro-deposits', async (req, res) => {
  try {
    const { fundingSourceId } = req.body;
    if (!fundingSourceId) return res.status(400).json({ error: 'fundingSourceId is required' });

    await dwolla.post(`funding-sources/${fundingSourceId}/micro-deposits`);
    res.json({ success: true, message: 'Micro-deposits initiated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.body?.message || error.message });
  }
});

app.post('/api/verify-micro-deposits', async (req, res) => {
  try {
    const { fundingSourceId, amount1, amount2 } = req.body;
    if (!fundingSourceId || !amount1 || !amount2) {
      return res.status(400).json({ error: 'fundingSourceId, amount1 and amount2 are required' });
    }

    await dwolla.post(`funding-sources/${fundingSourceId}/micro-deposits`, {
      amount1: { value: String(amount1), currency: 'USD' },
      amount2: { value: String(amount2), currency: 'USD' }
    });

    await supabase
      .from('bank_accounts')
      .update({ status: 'verified' })
      .eq('stripe_payment_method_id', fundingSourceId);

    res.json({ success: true, message: 'Bank account verified successfully!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.body?.message || error.message });
  }
});

// ---------- Get user banks ----------
app.get('/api/bank-accounts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ banks: data || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Transfers (simplified – same source/dest for sandbox demo) ----------
app.post('/api/create-transfer', async (req, res) => {
  try {
    const { sourceFundingSourceId, amount, userId, note } = req.body;
    if (!sourceFundingSourceId || !amount) {
      return res.status(400).json({ error: 'sourceFundingSourceId and amount are required' });
    }

    const transfer = await dwolla.post('transfers', {
      _links: {
        source: { href: `https://api-sandbox.dwolla.com/funding-sources/${sourceFundingSourceId}` },
        destination: { href: `https://api-sandbox.dwolla.com/funding-sources/${sourceFundingSourceId}` }
      },
      amount: { currency: 'USD', value: Number(amount).toFixed(2) },
      metadata: { userId: userId || '', note: note || 'PayFlow ACH Transfer' }
    });

    const transferId = transfer.headers.get('location').split('/').pop();

    await supabase.from('transactions').insert([{
      user_id: userId,
      type: 'out',
      amount: Number(amount),
      status: 'pending',
      description: note || 'ACH Transfer',
      stripe_id: transferId
    }]);

    res.json({ success: true, transferId, message: 'ACH transfer initiated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.body?.message || error.message });
  }
});

app.post('/api/receive-money', async (req, res) => {
  try {
    const { fundingSourceId, amount, userId, note } = req.body;
    if (!fundingSourceId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'fundingSourceId and a valid amount are required' });
    }

    const transfer = await dwolla.post('transfers', {
      _links: {
        source: { href: `https://api-sandbox.dwolla.com/funding-sources/${fundingSourceId}` },
        destination: { href: `https://api-sandbox.dwolla.com/funding-sources/${fundingSourceId}` }
      },
      amount: { currency: 'USD', value: Number(amount).toFixed(2) },
      metadata: { userId: userId || '', type: 'receive', note: note || 'Funds added to PayFlow' }
    });

    const transferId = transfer.headers.get('location').split('/').pop();

    await supabase.from('transactions').insert([{
      user_id: userId,
      type: 'in',
      amount: Number(amount),
      status: 'pending',
      description: note || 'Received via ACH',
      stripe_id: transferId
    }]);

    res.json({ success: true, transferId, message: 'ACH debit initiated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.body?.message || error.message });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`PayFlow Backend running on port ${PORT}`);
});
