// api/webhook.js — BillXM Stripe Webhook Handler
// Processes payment confirmations and adds credits to user accounts
// 
// SETUP: In Stripe Dashboard -> Developers -> Webhooks:
// 1. Add endpoint URL: https://www.billxm.com/api/webhook
// 2. Select events: checkout.session.completed, customer.subscription.deleted
// 3. Copy the webhook signing secret to Vercel env var: STRIPE_WEBHOOK_SECRET

var Stripe = require('stripe');

// Raw body is needed for webhook signature verification
// Vercel serverless functions need this config
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', function(err) { reject(err); });
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  var rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('Failed to read webhook body:', err.message);
    return res.status(400).json({ error: 'Invalid request body' });
  }

  var sig = req.headers['stripe-signature'];
  var event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log('Stripe webhook event:', event.type);

  // ── Handle checkout.session.completed ──
  if (event.type === 'checkout.session.completed') {
    var session = event.data.object;
    var email = session.metadata.email || session.customer_email || '';
    var creditType = session.metadata.credit_type || 'single_report';

    console.log('Payment completed: ' + creditType + ' for ' + email);

    if (email) {
      // Call our gate to add the credit
      try {
        var gateUrl = (process.env.SITE_URL || 'https://www.billxm.com') + '/api/gate';
        var response = await fetch(gateUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add_credit',
            webhook_secret: process.env.GATE_WEBHOOK_SECRET,
            email: email,
            credit_type: creditType,
            stripe_customer_id: session.customer || null,
          }),
        });
        var result = await response.json();
        console.log('Gate credit added:', result);
      } catch (gateErr) {
        console.error('Failed to add gate credit:', gateErr.message);
        // Don't fail the webhook - Stripe will retry
      }
    }
  }

  // ── Handle subscription cancelled ──
  if (event.type === 'customer.subscription.deleted') {
    var subscription = event.data.object;
    var customerId = subscription.customer;

    console.log('Subscription cancelled for customer:', customerId);

    // Look up customer email from Stripe
    try {
      var customer = await stripe.customers.retrieve(customerId);
      var email = customer.email;

      if (email) {
        var gateUrl = (process.env.SITE_URL || 'https://www.billxm.com') + '/api/gate';
        await fetch(gateUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add_credit',
            webhook_secret: process.env.GATE_WEBHOOK_SECRET,
            email: email,
            credit_type: 'cancel_subscription',
          }),
        });
      }
    } catch (err) {
      console.error('Failed to process cancellation:', err.message);
    }
  }

  // Always return 200 to acknowledge receipt
  return res.status(200).json({ received: true });
};
