const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tier } = req.body;

  const PRICES = {
    report: 499,
    full: 999,
  };

  if (!PRICES[tier]) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: PRICES[tier],
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { tier },
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
    });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};