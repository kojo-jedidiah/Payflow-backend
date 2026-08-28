require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

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
    message: 'PayFlow Backend is running',
    timestamp: new Date().toISOString()
  });
});

// ========== CREATE SETUP INTENT (Bank Linking) ==========
// This is the main endpoint for linking a bank account
app.post('/api/create-setup-intent', async (req, res) => {
  try {
    const { userId, email } = req.body;

    // Create or retrieve a Stripe Customer
    let customerId = null;

    if (email) {
      const existingCustomers = await stripe.customers.list({
        email: email,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        customerId = existingCustomers.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: email,
          metadata: { userId: userId || '' }
        });
        customerId = customer.id;
      }
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId || undefined,
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          verification_method: 'automatic', // Instant first, then micro-deposit fallback
        },
      },
      metadata: {
        userId: userId || '',
      },
    });

    res.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      customerId: customerId
    });

  } catch (error) {
    console.error('Error creating SetupIntent:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== SAVE LINKED BANK ACCOUNT ==========
app.post('/api/save-bank-account', async (req, res) => {
  try {
    const { userId, paymentMethodId, customerId } = req.body;

    if (!paymentMethodId) {
      return res.status(400).json({ error: 'paymentMethodId is required' });
    }

    // Retrieve the PaymentMethod from Stripe to get bank details
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

    const bankDetails = paymentMethod.us_bank_account || {};

    // Save to Supabase
    const { data, error } = await supabase
      .from('bank_accounts')
      .insert([
        {
          user_id: userId,
          stripe_payment_method_id: paymentMethodId,
          stripe_customer_id: customerId,
          bank_name: bankDetails.bank_name || 'Unknown Bank',
          last4: bankDetails.last4 || null,
          account_type: bankDetails.account_type || null,
          status: 'verified',
          is_default: true
        }
      ])
      .select();

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      success: true,
      bankAccount: data[0]
    });

  } catch (error) {
    console.error('Error saving bank account:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== GET USER'S LINKED BANKS ==========
app.get('/api/bank-accounts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ banks: data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== CREATE PAYOUT / WITHDRAWAL (Example) ==========
app.post('/api/create-payout', async (req, res) => {
  try {
    const { amount, currency = 'usd', paymentMethodId, userId } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Note: For real payouts to external bank accounts you usually need
    // Stripe Connect or Treasury. This is a simplified example.
    // In production you would create a Transfer or Payout carefully.

    res.json({
      message: 'Payout endpoint ready – implement with Stripe Connect or Treasury',
      received: { amount, currency, paymentMethodId, userId }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`PayFlow Backend running on port ${PORT}`);
});
