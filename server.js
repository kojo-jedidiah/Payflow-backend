require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client } = require('dwolla-v2');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== DWOLLA ==========
const dwolla = new Client({
  key: process.env.DWOLLA_KEY,
  secret: process.env.DWOLLA_SECRET,
  environment: 'sandbox' // change to 'production' later
});

// ========== SUPABASE ==========
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ========== MIDDLEWARE ==========
app.use(cors({
  origin: [
    'https://payflow-wqno.onrender.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true
}));
app.use(express.json());

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'PayFlow Backend (Dwolla) is running',
    timestamp: new Date().toISOString()
  });
});

// ========== CREATE CUSTOMER (Resilient) ==========
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
    } catch (dwollaError) {
      console.error('Dwolla create customer failed:', dwollaError.body || dwollaError.message);
      // Still allow account creation even if Dwolla fails
    }

    res.json({
      success: true,
      customerId: customerId || 'pending-' + Date.now(),
      message: customerId ? 'Customer created successfully' : 'Account created (Dwolla pending)'
    });

  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({
      error: error.message || 'Failed to create customer'
    });
  }
});

// ========== ADD FUNDING SOURCE ==========
app.post('/api/add-funding-source', async (req, res) => {
  try {
    const { customerId, routingNumber, accountNumber, bankAccountType, name, userId } = req.body;

    if (!customerId || !routingNumber || !accountNumber) {
      return res.status(400).json({ error: 'Missing required bank details' });
    }

    // If customerId is temporary (pending-...), tell user to try again later
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

    const { data, error } = await supabase
      .from('bank_accounts')
      .insert([{
        user_id: userId || null,
        stripe_payment_method_id: fundingSourceId,
        bank_name: name || 'Linked Bank',
        last4: accountNumber.slice(-4),
        account_type: bankAccountType || 'checking',
        status: 'pending',
        is_default: true
      }])
      .select();

    if (error) console.error('Supabase error:', error);

    res.json({
      success: true,
      fundingSourceId,
      fundingSourceUrl,
      bankAccount: data?.[0] || null
    });
  } catch (error) {
    console.error('Add funding source error:', error);
    res.status(500).json({
      error: error.body?.message || error.message || 'Failed to add funding source'
    });
  }
});

// ========== INITIATE MICRO-DEPOSITS ==========
app.post('/api/initiate-micro-deposits', async (req, res) => {
  try {
    const { fundingSourceId } = req.body;
    if (!fundingSourceId) return res.status(400).json({ error: 'fundingSourceId is required' });

    await dwolla.post(`funding-sources/${fundingSourceId}/micro-deposits`);

    res.json({
      success: true,
      message: 'Micro-deposits initiated. Check the bank account in 1-2 business days.'
    });
  } catch (error) {
    console.error('Micro-deposits error:', error);
    res.status(500).json({ error: error.body?.message || error.message });
  }
});

// ========== VERIFY MICRO-DEPOSITS ==========
app.post('/api/verify-micro-deposits', async (req, res) => {
  try {
    const { fundingSourceId, amount1, amount2 } = req.body;

    if (!fundingSourceId || !amount1 || !amount2) {
      return res.status(400).json({ error: 'fundingSourceId, amount1 and amount2 are required' });
    }

    await dwolla.post(`funding-sources/${fundingSourceId}/micro-deposits`, {
      amount1: { value: amount1, currency: 'USD' },
      amount2: { value: amount2, currency: 'USD' }
    });

    await supabase
      .from('bank_accounts')
      .update({ status: 'verified' })
      .eq('stripe_payment_method_id', fundingSourceId);

    res.json({
      success: true,
      message: 'Bank account verified successfully!'
    });
  } catch (error) {
    console.error('Verify micro-deposits error:', error);
    res.status(500).json({ error: error.body?.message || error.message });
  }
});

// ========== GET USER BANKS ==========
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

// ========== SEND MONEY ==========
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

    const transferUrl = transfer.headers.get('location');
    const transferId = transferUrl.split('/').pop();

    await supabase.from('transactions').insert([{
      user_id: userId,
      type: 'out',
      amount: Number(amount),
      status: 'pending',
      description: note || 'ACH Transfer',
      stripe_id: transferId
    }]);

    res.json({
      success: true,
      transferId,
      message: 'ACH transfer initiated successfully'
    });
  } catch (error) {
    console.error('Transfer error:', error);
    res.status(500).json({
      error: error.body?.message || error.message || 'Failed to create transfer'
    });
  }
});

// ========== RECEIVE MONEY ==========
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

    const transferUrl = transfer.headers.get('location');
    const transferId = transferUrl.split('/').pop();

    await supabase.from('transactions').insert([{
      user_id: userId,
      type: 'in',
      amount: Number(amount),
      status: 'pending',
      description: note || 'Received via ACH',
      stripe_id: transferId
    }]);

    res.json({
      success: true,
      transferId,
      message: 'ACH debit initiated successfully'
    });
  } catch (error) {
    console.error('Receive money error:', error);
    res.status(500).json({
      error: error.body?.message || error.message || 'Failed to initiate receive transfer'
    });
  }
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`PayFlow Backend (Dwolla) running on port ${PORT}`);
});
