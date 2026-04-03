// api/checkout.js -- BillXM Stripe Checkout
var Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  var body = req.body || {};
  var tier = body.tier;
  var email = body.email || '';

  if (!tier || !email) return res.status(400).json({ error: 'Missing tier or email' });

  var now = new Date();
  var onSale = now <= new Date('2026-06-30');
  var siteUrl = process.env.SITE_URL || 'https://www.billxm.com';

  try {
    var sessionConfig = null;

    if (tier === 'single_report') {
      // $4.99 (sale) / $9.99 (regular) -- Issues + Line Items only
      sessionConfig = {
        mode: 'payment',
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: 'BillXM Full Report', description: 'Complete bill analysis with overcharges and line item comparison' },
            unit_amount: onSale ? 499 : 999,
          },
          quantity: 1,
        }],
        metadata: { email: email, credit_type: 'single_report' },
        success_url: siteUrl + '/#payment-success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: siteUrl + '/#payment-cancelled',
        allow_promotion_codes: true,
      };
    } else if (tier === 'full_report') {
      // $9.99 (sale) / $19.99 (regular) -- Everything including dispute letter + phone scripts
      sessionConfig = {
        mode: 'payment',
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: 'BillXM Report + Dispute Kit', description: 'Full analysis plus phone scripts and formal dispute letter' },
            unit_amount: onSale ? 999 : 1999,
          },
          quantity: 1,
        }],
        metadata: { email: email, credit_type: 'single_report' },
        success_url: siteUrl + '/#payment-success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: siteUrl + '/#payment-cancelled',
        allow_promotion_codes: true,
      };
    } else if (tier === 'monthly') {
      // Monthly subscription -- unlimited everything
      sessionConfig = {
        mode: 'subscription',
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: 'BillXM Unlimited Monthly', description: 'Unlimited bill analyses, reports, dispute letters, and phone scripts' },
            unit_amount: onSale ? 999 : 1999,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        }],
        metadata: { email: email, credit_type: 'subscription' },
        success_url: siteUrl + '/#payment-success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: siteUrl + '/#payment-cancelled',
        allow_promotion_codes: true,
      };
    } else {
      return res.status(400).json({ error: 'Invalid tier. Use single_report, full_report, or monthly.' });
    }

    var session = await stripe.checkout.sessions.create(sessionConfig);
    return res.status(200).json({ url: session.url, session_id: session.id });

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: 'Payment system error. Please try again.' });
  }
};
