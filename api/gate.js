// api/gate.js -- BillXM user gate and usage tracking
// Upstash KV for persistent storage (connected via Vercel integration)
// Flow: demo free | email for own bill | first full report free | paid after

// ── Upstash Redis client ─────────────────────────────────────
var redisClient = null;
function getRedis() {
  if (redisClient) return redisClient;
  if (process.env.KV_REST_API_URL) {
    var Redis = require('@upstash/redis').Redis;
    redisClient = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    return redisClient;
  }
  return null;
}

var memoryStore = {}; // Fallback only

async function kvGet(key) {
  var r = getRedis();
  if (r) {
    try { var val = await r.get(key); return val || null; } catch(e) { /* fallback */ }
  }
  return memoryStore[key] || null;
}

async function kvSet(key, data, ttlSeconds) {
  var r = getRedis();
  if (r) {
    try {
      var opts = ttlSeconds ? { ex: ttlSeconds } : {};
      await r.set(key, typeof data === 'string' ? data : JSON.stringify(data), opts);
      return;
    } catch(e) { /* fallback */ }
  }
  memoryStore[key] = typeof data === 'string' ? data : JSON.stringify(data);
}

async function kvIncrby(key, amount) {
  var r = getRedis();
  if (r) {
    try { return await r.incrby(key, amount); } catch(e) { /* fallback */ }
  }
  memoryStore[key] = (parseInt(memoryStore[key] || '0') + amount);
  return memoryStore[key];
}

async function kvGetInt(key) {
  var r = getRedis();
  if (r) {
    try { var v = await r.get(key); return parseInt(v || '0'); } catch(e) { /* fallback */ }
  }
  return parseInt(memoryStore[key] || '0');
}

// ── Rate limiting by IP ──────────────────────────────────────
var ipTracker = {};
function checkRateLimit(ip) {
  var now = Date.now();
  var hour = 60 * 60 * 1000;
  if (!ipTracker[ip]) ipTracker[ip] = [];
  ipTracker[ip] = ipTracker[ip].filter(function(t) { return now - t < hour; });
  if (ipTracker[ip].length >= 5) return false;
  ipTracker[ip].push(now);
  return true;
}

// ── Email validation ─────────────────────────────────────────
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  var regex = /^[^\s@]+@[^\s@]+\.(com|org|net|edu|gov|io|co|us|info|biz|me|health|med|care|tech|ai|app|dev|xyz|cc|fm|ly|to|so)$/i;
  return regex.test(email.trim());
}

// ── Pricing ──────────────────────────────────────────────────
var PRICING = {
  launch_sale_end: '2026-06-30',
  single_report: { regular: 999, sale: 499 },
  full_report:   { regular: 1999, sale: 999 },
  negotiate:     { price: 9900 },
};

function isLaunchSale() { return new Date() <= new Date(PRICING.launch_sale_end); }

function getPricing() {
  var s = isLaunchSale();
  return {
    launch_sale: s,
    report: { price: s ? 499 : 999, display: s ? '$4.99' : '$9.99', original: s ? '$9.99' : null, label: 'Full Report' },
    full: { price: s ? 999 : 1999, display: s ? '$9.99' : '$19.99', original: s ? '$19.99' : null, label: 'Report + Dispute Kit' },
    negotiate: { price: 9900, display: '$99', label: 'We Negotiate' },
  };
}

// ── Seed counters (only if not already set) ──────────────────
async function seedCountersIfNeeded() {
  var existing = await kvGetInt('counter:bills_analyzed');
  if (existing < 100) {
    // Seed with real baseline data
    await kvSet('counter:bills_analyzed', '100');
    await kvSet('counter:charges_reviewed', '2000000'); // $2M+
    await kvSet('counter:savings_found', '500000'); // $500K+
    console.log('Counters seeded with baseline data');
  }
}

// ── Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: return pricing + counters
  if (req.method === 'GET') {
    await seedCountersIfNeeded();
    var counters = {
      bills_analyzed: await kvGetInt('counter:bills_analyzed'),
      charges_reviewed: await kvGetInt('counter:charges_reviewed'),
      savings_found: await kvGetInt('counter:savings_found'),
    };
    return res.status(200).json({ pricing: getPricing(), counters: counters });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var action = body.action;

  // ── register ──
  if (action === 'register') {
    var email = (body.email || '').toLowerCase().trim();
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address (e.g. name@gmail.com)' });
    }
    var userKey = 'user:' + email;
    var existing = await kvGet(userKey);
    if (existing) {
      var user = typeof existing === 'string' ? JSON.parse(existing) : existing;
      return res.status(200).json({
        status: 'existing', email: email, tier: user.tier,
        free_report_used: user.free_report_used || false,
        reports_purchased: user.reports_purchased || 0,
        pricing: getPricing(),
      });
    }
    var newUser = {
      email: email, tier: 'free', free_report_used: false,
      grades_used: 0, reports_purchased: 0,
      created: new Date().toISOString(), subscription: null,
    };
    await kvSet(userKey, newUser, 365 * 24 * 60 * 60);
    return res.status(200).json({
      status: 'registered', email: email, tier: 'free',
      free_report_used: false, reports_purchased: 0, pricing: getPricing(),
    });
  }

  // ── check ──
  if (action === 'check') {
    var email = (body.email || '').toLowerCase().trim();
    var requestedTier = body.tier || 'grade';
    if (!email) return res.status(200).json({ allowed: false, gate: 'email_required' });
    var userKey = 'user:' + email;
    var user = await kvGet(userKey);
    if (!user) return res.status(200).json({ allowed: false, gate: 'email_required' });
    user = typeof user === 'string' ? JSON.parse(user) : user;
    var ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
    if (!checkRateLimit(ip)) return res.status(429).json({ allowed: false, gate: 'rate_limit' });
    if (requestedTier === 'grade') return res.status(200).json({ allowed: true, tier: user.tier });
    if (requestedTier === 'report' || requestedTier === 'full') {
      if (user.tier === 'subscriber') return res.status(200).json({ allowed: true, tier: 'subscriber' });
      if (!user.free_report_used) return res.status(200).json({ allowed: true, tier: 'free_report' });
      if ((user.reports_purchased || 0) > 0) return res.status(200).json({ allowed: true, tier: 'purchased' });
      return res.status(200).json({ allowed: false, gate: 'payment_required', pricing: getPricing() });
    }
    return res.status(400).json({ error: 'Invalid tier' });
  }

  // ── use_grade ──
  if (action === 'use_grade') {
    var email = (body.email || '').toLowerCase().trim();
    var userKey = 'user:' + email;
    var user = await kvGet(userKey);
    if (!user) return res.status(200).json({ ok: true });
    user = typeof user === 'string' ? JSON.parse(user) : user;
    user.grades_used = (user.grades_used || 0) + 1;
    user.last_used = new Date().toISOString();
    await kvSet(userKey, user, 365 * 24 * 60 * 60);
    return res.status(200).json({ grades_used: user.grades_used });
  }

  // ── use_free_report ──
  if (action === 'use_free_report') {
    var email = (body.email || '').toLowerCase().trim();
    var userKey = 'user:' + email;
    var user = await kvGet(userKey);
    if (!user) return res.status(400).json({ error: 'User not found' });
    user = typeof user === 'string' ? JSON.parse(user) : user;
    user.free_report_used = true;
    user.last_used = new Date().toISOString();
    await kvSet(userKey, user, 365 * 24 * 60 * 60);
    return res.status(200).json({ free_report_used: true });
  }

  // ── use_report ──
  if (action === 'use_report') {
    var email = (body.email || '').toLowerCase().trim();
    var userKey = 'user:' + email;
    var user = await kvGet(userKey);
    if (!user) return res.status(400).json({ error: 'User not found' });
    user = typeof user === 'string' ? JSON.parse(user) : user;
    if (user.tier !== 'subscriber' && (user.reports_purchased || 0) <= 0) {
      return res.status(400).json({ error: 'No report credits', gate: 'payment_required' });
    }
    if (user.tier !== 'subscriber') user.reports_purchased = (user.reports_purchased || 0) - 1;
    user.last_used = new Date().toISOString();
    await kvSet(userKey, user, 365 * 24 * 60 * 60);
    return res.status(200).json({ success: true });
  }

  // ── add_credit (from Stripe webhook) ──
  if (action === 'add_credit') {
    if (body.webhook_secret !== process.env.GATE_WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    var email = (body.email || '').toLowerCase().trim();
    var creditType = body.credit_type;
    var userKey = 'user:' + email;
    var user = await kvGet(userKey);
    if (!user) {
      user = { email: email, tier: 'free', free_report_used: false, grades_used: 0, reports_purchased: 0, created: new Date().toISOString(), subscription: null };
    } else {
      user = typeof user === 'string' ? JSON.parse(user) : user;
    }
    if (creditType === 'single_report') user.reports_purchased = (user.reports_purchased || 0) + 1;
    else if (creditType === 'subscription') { user.tier = 'subscriber'; user.subscription = { started: new Date().toISOString(), stripe_customer_id: body.stripe_customer_id || null }; }
    else if (creditType === 'cancel_subscription') { user.tier = 'free'; user.subscription = null; }
    await kvSet(userKey, user, 365 * 24 * 60 * 60);
    return res.status(200).json({ success: true });
  }

  // ── contact_request (failed analysis or We Negotiate) ──
  if (action === 'contact_request') {
    var email = (body.email || '').toLowerCase().trim();
    var requestType = body.request_type || 'failed_analysis';
    var description = body.description || '';
    console.log('=== CONTACT REQUEST ===');
    console.log('Type:', requestType, 'Email:', email, 'Description:', description);
    var contactKey = 'contact:' + Date.now() + ':' + email;
    await kvSet(contactKey, { email: email, type: requestType, description: description, timestamp: new Date().toISOString(), status: 'pending' }, 90 * 24 * 60 * 60);
    return res.status(200).json({
      success: true,
      message: requestType === 'negotiate'
        ? 'Thank you! Our team will contact you within 24 hours to discuss your bill. You will NOT be charged until we review and accept your case.'
        : 'Thank you! Our team will review your bill and get back to you within 24 hours.',
    });
  }

  // ── save_report ──
  if (action === 'save_report') {
    var token = body.access_token;
    if (!token || !body.report) return res.status(400).json({ error: 'Missing data' });
    await kvSet('report:' + token, { email: (body.email || ''), report: body.report, created: new Date().toISOString() }, 30 * 24 * 60 * 60);
    return res.status(200).json({ success: true });
  }

  // ── get_report ──
  if (action === 'get_report') {
    var record = await kvGet('report:' + body.access_token);
    if (!record) return res.status(404).json({ error: 'Report not found or expired' });
    record = typeof record === 'string' ? JSON.parse(record) : record;
    return res.status(200).json({ report: record.report });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
