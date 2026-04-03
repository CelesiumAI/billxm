// api/webhook.js -- Stripe webhook handler
var Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Read raw body for signature verification
  var chunks = [];
  await new Promise(function(resolve, reject) {
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', resolve);
    req.on('error', reject);
  });
  var rawBody = Buffer.concat(chunks);

  var sig = req.headers['stripe-signature'];
  var event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook sig failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log('Stripe event:', event.type);
  var siteUrl = process.env.SITE_URL || 'https://www.billxm.com';

  if (event.type === 'checkout.session.completed') {
    var session = event.data.object;
    var email = session.metadata.email || session.customer_email || '';
    var creditType = session.metadata.credit_type || 'single_report';
    console.log('Payment: ' + creditType + ' for ' + email);
    if (email) {
      try {
        await fetch(siteUrl + '/api/gate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add_credit', webhook_secret: process.env.GATE_WEBHOOK_SECRET, email: email, credit_type: creditType, stripe_customer_id: session.customer || null }),
        });
      } catch (e) { console.error('Gate credit failed:', e.message); }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    var customerId = event.data.object.customer;
    try {
      var customer = await stripe.customers.retrieve(customerId);
      if (customer.email) {
        await fetch(siteUrl + '/api/gate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add_credit', webhook_secret: process.env.GATE_WEBHOOK_SECRET, email: customer.email, credit_type: 'cancel_subscription' }),
        });
      }
    } catch (e) { console.error('Subscription cancel failed:', e.message); }
  }

  return res.status(200).json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
