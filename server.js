require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client } = require('dwolla-v2');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== DWOLLA CLIENT ==========
const dwolla = new Client({
  key: process.env.DWOLLA_KEY,
  secret: process.env.DWOLLA_SECRET,
  environment: 'sandbox' // Change to 'production' when ready
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

// ========== CREATE DWOLLA CUSTOMER ==========
app.post('/api/create-customer', async (req, res) => {
  try {
    const { firstName, lastName, email } = req.body;

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'firstName, lastName and email are required' });
    }

    const customer = await dwolla.post('customers', {
      firstName,
      lastName,
      email,
      type: 'unverified'
    });

    const customerUrl = customer.headers.get('location');
    const customerId = customerUrl.split('/').pop();

    res.json({
      success: true,
      customerId,
      customerUrl
    });
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({
      error: error.body?.message || error.message || 'Failed to create customer'
    });
  }
});

// ========== ADD FUNDING SOURCE (Bank Account) ==========
app.post('/api/add-funding-source', async (req, res) => {
  try {
    const { customerId, routingNumber, accountNumber, bankAccountType, name, userId } = req.body;

    if (!customerId || !routingNumber || !accountNumber) {
      return res.status(400).json({ error: 'Missing required bank details' });
    }

    const fundingSource = await dwolla.post(`customers/${customerId}/funding-sources`, {
      routingNumber,
      accountNumber,
      bankAccountType: bankAccountType || 'checking',
      name: name || 'Bank Account'
    });

    const fundingSourceUrl = fundingSource.headers.get('location');
    const fundingSourceId = fundingSourceUrl.split('/').pop();

    // Save to Supabase
    const { data, error } = await supabase
      .from('bank_accounts')
      .insert([{
        user_id: userId || null,
        stripe_payment_method_id: fundingSourceId, // storing Dwolla funding source ID
        bank_name: name || 'Linked Bank',
        last4: accountNumber.slice(-4),
        account_type: bankAccountType || 'checking',
        status: 'pending',
        is_default: true
      }])
      .select();

    if (error) {
      console.error('Supabase error:', error);
    }

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

    if (!fundingSourceId) {
      return res.status(400).json({ error: 'fundingSourceId is required' });
    }

    await dwolla.post(`funding-sources/${fundingSourceId}/micro-deposits`);

    res.json({
      success: true,
      message: 'Micro-deposits initiated. Check the bank account in 1-2 business days.'
    });
  } catch (error) {
    console.error('Micro-deposits error:', error);
    res.status(500).json({
      error: error.body?.message || error.message
    });
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

    // Update status in Supabase
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
    res.status(500).json({
      error: error.body?.message || error.message
    });
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

// ========== CREATE ACH TRANSFER (Send Money) ==========
app.post('/api/create-transfer', async (req, res) => {
  try {
    const { 
      sourceFundingSourceId,
      amount, 
      userId,
      note 
    } = req.body;

    if (!sourceFundingSourceId || !amount) {
      return res.status(400).json({ error: 'sourceFundingSourceId and amount are required' });
    }

    // In Sandbox we can transfer from the funding source to itself for testing
    // In production you would transfer to another customer's funding source
    // or to your platform's funding source.

    const transfer = await dwolla.post('transfers', {
      _links: {
        source: {
          href: `https://api-sandbox.dwolla.com/funding-sources/${sourceFundingSourceId}`
        },
        destination: {
          href: `https://api-sandbox.dwolla.com/funding-sources/${sourceFundingSourceId}`
        }
      },
      amount: {
        currency: 'USD',
        value: Number(amount).toFixed(2)
      },
      metadata: {
        userId: userId || '',
        note: note || 'PayFlow ACH Transfer'
      }
    });

    const transferUrl = transfer.headers.get('location');
    const transferId = transferUrl.split('/').pop();

    // Save transaction to Supabase
    try {
      await supabase.from('transactions').insert([{
        user_id: userId,
        type: 'out',
        amount: Number(amount),
        status: 'pending',
        description: note || 'ACH Transfer',
        stripe_id: transferId
      }]);
    } catch (dbError) {
      console.error('Failed to save transaction:', dbError);
    }

    res.json({
      success: true,
      transferId,
      transferUrl,
      message: 'ACH transfer initiated successfully'
    });

  } catch (error) {
    console.error('Transfer error:', error);
    res.status(500).json({
      error: error.body?.message || error.message || 'Failed to create transfer'
    });
  }
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`PayFlow Backend (Dwolla) running on port ${PORT}`);
});
