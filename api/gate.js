// api/gate.js — BillXM email gate and usage tracking
// Uses Vercel KV if available, falls back to in-memory (resets on cold start)
// For production, set up Vercel KV: https://vercel.com/docs/storage/vercel-kv

var memoryStore = {}; // Fallback in-memory store

// ── Simple storage abstraction ───────────────────────────────
async function getUser(email) {
  var key = 'user:' + email.toLowerCase().trim();
  // Try Vercel KV first
  if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
    try {
      var kv = require('@vercel/kv');
      var data = await kv.get(key);
      return data || null;
    } catch (e) { /* fall through to memory */ }
  }
  return memoryStore[key] || null;
}

async function setUser(email, data) {
  var key = 'user:' + email.toLowerCase().trim();
  if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
    try {
      var kv = require('@vercel/kv');
      await kv.set(key, data, { ex: 90 * 24 * 60 * 60 }); // expire in 90 days
      return;
    } catch (e) { /* fall through to memory */ }
  }
  memoryStore[key] = data;
}

// ── Rate limiting by IP ──────────────────────────────────────
var ipTracker = {};

function checkRateLimit(ip) {
  var now = Date.now();
  var hour = 60 * 60 * 1000;
  if (!ipTracker[ip]) ipTracker[ip] = [];
  // Remove entries older than 1 hour
  ipTracker[ip] = ipTracker[ip].filter(function(t) { return now - t < hour; });
  if (ipTracker[ip].length >= 5) {
    return false; // Over limit: 5 per hour
  }
  ipTracker[ip].push(now);
  return true;
}

// ── Pricing ──────────────────────────────────────────────────
var PRICING = {
  launch_sale: true,
  launch_sale_end: '2026-06-30', // sale runs through June 2026
  single_report: {
    regular: 999,   // $9.99 in cents
    sale: 499,       // $4.99 launch sale
  },
  monthly: {
    regular: 1999,  // $19.99/month in cents
    sale: 999,       // $9.99/month launch sale
  },
};

function isLaunchSale() {
  if (!PRICING.launch_sale) return false;
  var now = new Date();
  var end = new Date(PRICING.launch_sale_end);
  return now <= end;
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
  };
}

// ── Free tier limits ─────────────────────────────────────────
var FREE_GRADE_LIMIT = 3; // total free grades per email, ever

// ── Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: Return pricing info ──
  if (req.method === 'GET') {
    return res.status(200).json({
      pricing: getPricing(),
      free_grade_limit: FREE_GRADE_LIMIT,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var action = body.action;

  // ── ACTION: register — capture email ──
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
        free_grades_used: existing.free_grades_used || 0,
        free_grades_remaining: Math.max(0, FREE_GRADE_LIMIT - (existing.free_grades_used || 0)),
        reports_purchased: existing.reports_purchased || 0,
        pricing: getPricing(),
      });
    }

    var newUser = {
      email: email,
      tier: 'free',
      free_grades_used: 0,
      reports_purchased: 0,
      created: new Date().toISOString(),
      subscription: null,
    };
    await setUser(email, newUser);

    return res.status(200).json({
      status: 'registered',
      email: email,
      tier: 'free',
      free_grades_used: 0,
      free_grades_remaining: FREE_GRADE_LIMIT,
      reports_purchased: 0,
      pricing: getPricing(),
    });
  }

  // ── ACTION: check — verify if user can analyze ──
  if (action === 'check') {
    var email = (body.email || '').toLowerCase().trim();
    var requestedTier = body.tier || 'grade'; // 'grade' or 'report'

    if (!email) {
      return res.status(400).json({ error: 'Email required', gate: 'email_required' });
    }

    var user = await getUser(email);
    if (!user) {
      return res.status(400).json({ error: 'Email not registered', gate: 'email_required' });
    }

    // Check IP rate limit
    var ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.', gate: 'rate_limit' });
    }

    // Free grade check
    if (requestedTier === 'grade') {
      if (user.tier === 'subscriber') {
        // Subscribers get unlimited grades
        return res.status(200).json({ allowed: true, tier: user.tier });
      }
      if ((user.free_grades_used || 0) >= FREE_GRADE_LIMIT) {
        return res.status(200).json({
          allowed: false,
          gate: 'free_limit_reached',
          message: 'You have used all ' + FREE_GRADE_LIMIT + ' free bill grades. Unlock a full report for ' + getPricing().single_report.display + '.',
          pricing: getPricing(),
        });
      }
      return res.status(200).json({ allowed: true, tier: 'free', grades_remaining: FREE_GRADE_LIMIT - user.free_grades_used });
    }

    // Full report check
    if (requestedTier === 'report') {
      if (user.tier === 'subscriber') {
        return res.status(200).json({ allowed: true, tier: 'subscriber' });
      }
      // Check if they have a purchased report credit
      if ((user.reports_purchased || 0) > 0) {
        return res.status(200).json({ allowed: true, tier: 'purchased' });
      }
      return res.status(200).json({
        allowed: false,
        gate: 'payment_required',
        message: 'Unlock your full report with detailed overcharges, dispute letter, and phone scripts.',
        pricing: getPricing(),
      });
    }

    return res.status(400).json({ error: 'Invalid tier' });
  }

  // ── ACTION: use_grade — decrement free grade count ──
  if (action === 'use_grade') {
    var email = (body.email || '').toLowerCase().trim();
    var user = await getUser(email);
    if (!user) return res.status(400).json({ error: 'User not found' });

    user.free_grades_used = (user.free_grades_used || 0) + 1;
    user.last_used = new Date().toISOString();
    await setUser(email, user);

    return res.status(200).json({
      free_grades_used: user.free_grades_used,
      free_grades_remaining: Math.max(0, FREE_GRADE_LIMIT - user.free_grades_used),
    });
  }

  // ── ACTION: use_report — decrement report credit ──
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

  // ── ACTION: add_credit — called by Stripe webhook after payment ──
  if (action === 'add_credit') {
    // This should only be called from your Stripe webhook, not from frontend
    var secret = body.webhook_secret;
    if (secret !== process.env.GATE_WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    var email = (body.email || '').toLowerCase().trim();
    var creditType = body.credit_type; // 'single_report' or 'subscription'

    var user = await getUser(email);
    if (!user) {
      // Create user if they paid without registering first
      user = {
        email: email,
        tier: 'free',
        free_grades_used: 0,
        reports_purchased: 0,
        created: new Date().toISOString(),
        subscription: null,
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
    return res.status(200).json({ success: true, user: user });
  }

  // ── ACTION: save_report — store report JSON (no bill data) ──
  if (action === 'save_report') {
    var email = (body.email || '').toLowerCase().trim();
    var reportData = body.report; // The analysis report JSON only
    var accessToken = body.access_token;

    if (!reportData || !accessToken) {
      return res.status(400).json({ error: 'Missing report or access token' });
    }

    // Store report with access token (30 day expiry)
    var reportKey = 'report:' + accessToken;
    var reportRecord = {
      email: email,
      report: reportData,
      created: new Date().toISOString(),
      // NO bill data stored — only the analysis output
    };

    if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
      try {
        var kv = require('@vercel/kv');
        await kv.set(reportKey, reportRecord, { ex: 30 * 24 * 60 * 60 }); // 30 days
      } catch (e) { /* fall through to memory */ }
    } else {
      memoryStore[reportKey] = reportRecord;
    }

    return res.status(200).json({ success: true, access_token: accessToken });
  }

  // ── ACTION: get_report — retrieve saved report by token ──
  if (action === 'get_report') {
    var token = body.access_token;
    var reportKey = 'report:' + token;

    var record = null;
    if (typeof process !== 'undefined' && process.env.KV_REST_API_URL) {
      try {
        var kv = require('@vercel/kv');
        record = await kv.get(reportKey);
      } catch (e) { /* fall through */ }
    } else {
      record = memoryStore[reportKey] || null;
    }

    if (!record) {
      return res.status(404).json({ error: 'Report not found or expired' });
    }
    return res.status(200).json({ report: record.report });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
