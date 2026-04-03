// api/admin.js -- BillXM Admin Dashboard API
// Password-protected. Returns analytics, hospital data, user metrics.
// Access via billxm.com/#admin with password

var ADMIN_PASSWORD = 'billxm_admin_2026'; // Change this to something secure

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var body = req.body || {};
  if (body.password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid password' });

  if (!process.env.KV_REST_API_URL) return res.status(200).json({ error: 'KV not configured', data: {} });

  try {
    var Redis = require('@upstash/redis').Redis;
    var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

    var action = body.action || 'summary';

    if (action === 'summary') {
      var bills = await redis.get('counter:bills_analyzed') || 0;
      var charges = await redis.get('counter:charges_reviewed') || 0;
      var savings = await redis.get('counter:savings_found') || 0;

      // Get recent analyses (scan for analysis: keys)
      var recentKeys = [];
      try {
        var cursor = '0';
        var scanResult = await redis.scan(cursor, { match: 'analysis:*', count: 50 });
        if (scanResult && scanResult[1]) recentKeys = scanResult[1].slice(0, 20);
      } catch(e) { /* scan not supported on all tiers */ }

      var recentAnalyses = [];
      for (var i = 0; i < recentKeys.length; i++) {
        try {
          var data = await redis.get(recentKeys[i]);
          if (data) recentAnalyses.push(typeof data === 'string' ? JSON.parse(data) : data);
        } catch(e) {}
      }

      // Get hospital pricing data
      var hospitalKeys = [];
      try {
        var hScan = await redis.scan('0', { match: 'hospital_pricing:*', count: 100 });
        if (hScan && hScan[1]) hospitalKeys = hScan[1].slice(0, 50);
      } catch(e) {}

      var hospitalData = [];
      for (var j = 0; j < hospitalKeys.length; j++) {
        try {
          var hData = await redis.get(hospitalKeys[j]);
          if (hData) hospitalData.push(typeof hData === 'string' ? JSON.parse(hData) : hData);
        } catch(e) {}
      }

      // Get contact requests
      var contactKeys = [];
      try {
        var cScan = await redis.scan('0', { match: 'contact:*', count: 50 });
        if (cScan && cScan[1]) contactKeys = cScan[1].slice(0, 20);
      } catch(e) {}

      var contacts = [];
      for (var k = 0; k < contactKeys.length; k++) {
        try {
          var cData = await redis.get(contactKeys[k]);
          if (cData) contacts.push(typeof cData === 'string' ? JSON.parse(cData) : cData);
        } catch(e) {}
      }

      // Get user count
      var userKeys = [];
      try {
        var uScan = await redis.scan('0', { match: 'user:*', count: 200 });
        if (uScan && uScan[1]) userKeys = uScan[1];
      } catch(e) {}

      return res.status(200).json({
        counters: {
          bills_analyzed: parseInt(bills),
          charges_reviewed: parseInt(charges),
          savings_found: parseInt(savings),
        },
        user_count: userKeys.length,
        recent_analyses: recentAnalyses.sort(function(a, b) { return (b.month || '').localeCompare(a.month || ''); }).slice(0, 20),
        hospital_pricing: hospitalData,
        contact_requests: contacts.sort(function(a, b) { return (b.timestamp || '').localeCompare(a.timestamp || ''); }),
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Admin error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
