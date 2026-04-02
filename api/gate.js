// api/gate.js — BillXM user gate and usage tracking
// Flow:
//   Demo bill: no email, no limits, full report visible (handled in frontend)
//   Upload own bill: email required before upload
//   First full report: FREE (one per email)
//   Grade (A-F + summary): always free, unlimited (after email captured)
//   Second full report onward: paid ($4.99 single / $9.99 monthly)
//   CENTENE2026: bypasses everything (handled in frontend)
//   Failed analysis: captures email + description, sends to contact.billxm@gmail.com

var memoryStore = {}; // Fallback in-memory store. For production, use Vercel KV.

// ── Storage abstraction ──────────────────────────────────────
async function getUser(email) {
  var key = 'user:' + email.toLowerCase().trim();
  if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
    try {
      var kv = require('@vercel/kv');
      return await kv.get(key) || null;
    } catch (e) { /* fall through */ }
  }
  return memoryStore[key] || null;
}

async function setUser(email, data) {
  var key = 'user:' + email.toLowerCase().trim();
  if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
    try {
      var kv = require('@vercel/kv');
      await kv.set(key, data, { ex: 180 * 24 * 60 * 60 }); // 180 days
      return;
    } catch (e) { /* fall through */ }
  }
  memoryStore[key] = data;
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

// ── Pricing ──────────────────────────────────────────────────
var PRICING = {
  launch_sale: true,
  launch_sale_end: '2026-06-30',
  single_report: { regular: 999, sale: 499 },     // cents
  monthly:       { regular: 1999, sale: 999 },     // cents
  negotiate:     { price: 9900 },                   // $99
};

function isLaunchSale() {
  if (!PRICING.launch_sale) return false;
  return new Date() <= new Date(PRICING.launch_sale_end);
}

function getPricing() {
  var onSale = isLaunchSale();
  return {
    launch_sale: onSale,
    single_report: {
      price: onSale ? PRICING.single_report.sale : PRICING.single_report.regular,
      display: onSale ? '$4.99' : '$9.99',
      original: onSale ? '$9.99' : null,
    },
    monthly: {
      price: onSale ? PRICING.monthly.sale : PRICING.monthly.regular,
      display: onSale ? '$9.99/mo' : '$19.99/mo',
      original: onSale ? '$19.99/mo' : null,
    },
    negotiate: {
      price: PRICING.negotiate.price,
      display: '$99',
    },
  };
}

// ── Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: return pricing
  if (req.method === 'GET') {
    return res.status(200).json({ pricing: getPricing() });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var action = body.action;

  // ── register: capture email when user wants to upload own bill ──
  if (action === 'register') {
    var email = (body.email || '').toLowerCase().trim();
    if (!email || email.indexOf('@') < 1 || email.indexOf('.') < 3) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    var existing = await getUser(email);
    if (existing) {
      return res.status(200).json({
        status: 'existing',
        email: email,
        tier: existing.tier,
        free_report_used: existing.free_report_used || false,
        grades_used: existing.grades_used || 0,
        reports_purchased: existing.reports_purchased || 0,
        pricing: getPricing(),
      });
    }

    var newUser = {
      email: email,
      tier: 'free',
      free_report_used: false,     // one free full report per email
      grades_used: 0,              // unlimited grades (tracked for analytics)
      reports_purchased: 0,
      created: new Date().toISOString(),
      subscription: null,
    };
    await setUser(email, newUser);

    return res.status(200).json({
      status: 'registered',
      email: email,
      tier: 'free',
      free_report_used: false,
      grades_used: 0,
      reports_purchased: 0,
      pricing: getPricing(),
    });
  }

  // ── check: can user perform this action? ──
  if (action === 'check') {
    var email = (body.email || '').toLowerCase().trim();
    var requestedTier = body.tier || 'grade'; // 'grade' or 'report'

    if (!email) {
      return res.status(200).json({ allowed: false, gate: 'email_required' });
    }

    var user = await getUser(email);
    if (!user) {
      return res.status(200).json({ allowed: false, gate: 'email_required' });
    }

    // Rate limit check
    var ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ allowed: false, gate: 'rate_limit', error: 'Too many requests. Please wait a few minutes.' });
    }

    // Grade: always allowed (free, unlimited after email)
    if (requestedTier === 'grade') {
      return res.status(200).json({ allowed: true, tier: user.tier });
    }

    // Full report check
    if (requestedTier === 'report') {
      // Subscribers: unlimited
      if (user.tier === 'subscriber') {
        return res.status(200).json({ allowed: true, tier: 'subscriber' });
      }
      // First free report not yet used
      if (!user.free_report_used) {
        return res.status(200).json({ allowed: true, tier: 'free_report', message: 'Your first full report is free!' });
      }
      // Has purchased report credits
      if ((user.reports_purchased || 0) > 0) {
        return res.status(200).json({ allowed: true, tier: 'purchased' });
      }
      // Must pay
      return res.status(200).json({
        allowed: false,
        gate: 'payment_required',
        message: 'Your free report has been used. Unlock additional reports starting at ' + getPricing().single_report.display + '.',
        pricing: getPricing(),
      });
    }

    return res.status(400).json({ error: 'Invalid tier' });
  }

  // ── use_grade: track grade usage (analytics, always allowed) ──
  if (action === 'use_grade') {
    var email = (body.email || '').toLowerCase().trim();
    var user = await getUser(email);
    if (!user) return res.status(200).json({ ok: true }); // silently ok if no user
    user.grades_used = (user.grades_used || 0) + 1;
    user.last_used = new Date().toISOString();
    await setUser(email, user);
    return res.status(200).json({ grades_used: user.grades_used });
  }

  // ── use_free_report: mark free report as consumed ──
  if (action === 'use_free_report') {
    var email = (body.email || '').toLowerCase().trim();
    var user = await getUser(email);
    if (!user) return res.status(400).json({ error: 'User not found' });
    user.free_report_used = true;
    user.last_used = new Date().toISOString();
    await setUser(email, user);
    return res.status(200).json({ free_report_used: true });
  }

  // ── use_report: decrement purchased report credit ──
  if (action === 'use_report') {
    var email = (body.email || '').toLowerCase().trim();
    var user = await getUser(email);
    if (!user) return res.status(400).json({ error: 'User not found' });
    if (user.tier !== 'subscriber' && (user.reports_purchased || 0) <= 0) {
      return res.status(400).json({ error: 'No report credits', gate: 'payment_required' });
    }
    if (user.tier !== 'subscriber') {
      user.reports_purchased = (user.reports_purchased || 0) - 1;
    }
    user.last_used = new Date().toISOString();
    await setUser(email, user);
    return res.status(200).json({ success: true });
  }

  // ── add_credit: called by Stripe webhook ──
  if (action === 'add_credit') {
    var secret = body.webhook_secret;
    if (secret !== process.env.GATE_WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    var email = (body.email || '').toLowerCase().trim();
    var creditType = body.credit_type;
    var user = await getUser(email);
    if (!user) {
      user = {
        email: email, tier: 'free', free_report_used: false,
        grades_used: 0, reports_purchased: 0,
        created: new Date().toISOString(), subscription: null,
      };
    }
    if (creditType === 'single_report') {
      user.reports_purchased = (user.reports_purchased || 0) + 1;
    } else if (creditType === 'subscription') {
      user.tier = 'subscriber';
      user.subscription = {
        started: new Date().toISOString(),
        stripe_customer_id: body.stripe_customer_id || null,
      };
    } else if (creditType === 'cancel_subscription') {
      user.tier = 'free';
      user.subscription = null;
    }
    await setUser(email, user);
    return res.status(200).json({ success: true });
  }

  // ── contact_request: failed analysis or We Negotiate inquiry ──
  if (action === 'contact_request') {
    var email = (body.email || '').toLowerCase().trim();
    var requestType = body.request_type || 'failed_analysis'; // 'failed_analysis' or 'negotiate'
    var description = body.description || '';
    var billSummary = body.bill_summary || '';

    console.log('=== CONTACT REQUEST ===');
    console.log('Type:', requestType);
    console.log('Email:', email);
    console.log('Description:', description);
    console.log('Bill summary:', billSummary);

    // Store the request for now (future: send actual email via SendGrid/Nodemailer)
    var requestKey = 'contact:' + Date.now() + ':' + email;
    var requestData = {
      email: email,
      type: requestType,
      description: description,
      bill_summary: billSummary,
      timestamp: new Date().toISOString(),
      status: 'pending',
    };

    if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
      try {
        var kv = require('@vercel/kv');
        await kv.set(requestKey, requestData, { ex: 90 * 24 * 60 * 60 });
      } catch (e) { /* fall through */ }
    }
    memoryStore[requestKey] = requestData;

    return res.status(200).json({
      success: true,
      message: requestType === 'negotiate'
        ? 'Thank you! Our team will contact you within 24 hours to discuss your bill.'
        : 'Thank you! Our team will review your bill and get back to you within 24 hours.',
    });
  }

  // ── save_report: store report JSON only (no bill data) ──
  if (action === 'save_report') {
    var accessToken = body.access_token;
    var reportData = body.report;
    if (!reportData || !accessToken) {
      return res.status(400).json({ error: 'Missing report or token' });
    }
    var reportKey = 'report:' + accessToken;
    var record = {
      email: (body.email || '').toLowerCase().trim(),
      report: reportData,
      created: new Date().toISOString(),
    };
    if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
      try {
        var kv = require('@vercel/kv');
        await kv.set(reportKey, record, { ex: 30 * 24 * 60 * 60 });
      } catch (e) { /* fall through */ }
    }
    memoryStore[reportKey] = record;
    return res.status(200).json({ success: true, access_token: accessToken });
  }

  // ── get_report: retrieve saved report ──
  if (action === 'get_report') {
    var token = body.access_token;
    var reportKey = 'report:' + token;
    var record = null;
    if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
      try {
        var kv = require('@vercel/kv');
        record = await kv.get(reportKey);
      } catch (e) { /* fall through */ }
    }
    if (!record) record = memoryStore[reportKey] || null;
    if (!record) return res.status(404).json({ error: 'Report not found or expired' });
    return res.status(200).json({ report: record.report });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
