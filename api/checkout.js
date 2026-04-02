// api/checkout.js — BillXM Stripe Checkout
// Creates Stripe Checkout Sessions for single reports and monthly subscriptions

var Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  var body = req.body || {};
  var tier = body.tier; // 'single_report' or 'monthly'
  var email = body.email || '';

  if (!tier || !email) {
    return res.status(400).json({ error: 'Missing tier or email' });
  }

  // ── Pricing (launch sale) ──
  var now = new Date();
  var saleEnd = new Date('2026-06-30');
  var onSale = now <= saleEnd;

  try {
    if (tier === 'single_report') {
      // One-time payment for a single report
      var session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'BillXM Full Report',
              description: 'Complete bill analysis with overcharges, dispute letter, and phone scripts',
            },
            unit_amount: onSale ? 499 : 999, // $4.99 sale or $9.99 regular
          },
          quantity: 1,
        }],
        metadata: {
          email: email,
          credit_type: 'single_report',
        },
        success_url: (process.env.SITE_URL || 'https://www.billxm.com') + '/#payment-success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: (process.env.SITE_URL || 'https://www.billxm.com') + '/#payment-cancelled',
        allow_promotion_codes: true,
      });

      return res.status(200).json({ url: session.url, session_id: session.id });

    } else if (tier === 'monthly') {
      // Recurring subscription
      var session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'BillXM Unlimited Monthly',
              description: 'Unlimited bill analyses, reports, dispute letters, and phone scripts',
            },
            unit_amount: onSale ? 999 : 1999, // $9.99 sale or $19.99 regular
            recurring: {
              interval: 'month',
            },
          },
          quantity: 1,
        }],
        metadata: {
          email: email,
          credit_type: 'subscription',
        },
        success_url: (process.env.SITE_URL || 'https://www.billxm.com') + '/#payment-success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: (process.env.SITE_URL || 'https://www.billxm.com') + '/#payment-cancelled',
        allow_promotion_codes: true,
      });

      return res.status(200).json({ url: session.url, session_id: session.id });

    } else {
      return res.status(400).json({ error: 'Invalid tier. Use single_report or monthly.' });
    }

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: 'Payment system error. Please try again.' });
  }
};
