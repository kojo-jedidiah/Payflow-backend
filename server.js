require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// Supabase admin client (uses service_role key)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({
  origin: 'https://payflow-wqno.onrender.com' // your frontend URL
}));
app.use(express.json());

// Simple test route
app.get('/', (req, res) => {
  res.json({ message: 'PayFlow Backend is running' });
});

// Example: Create SetupIntent for bank linking
app.post('/api/create-setup-intent', async (req, res) => {
  try {
    const setupIntent = await stripe.setupIntents.create({
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          verification_method: 'automatic', // instant + micro-deposit fallback
        },
      },
    });

    res.json({ clientSecret: setupIntent.client_secret });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
