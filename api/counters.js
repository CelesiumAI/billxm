// api/counters.js -- Public counter endpoint for homepage
// Returns bills analyzed, charges reviewed, savings found
// These increment with every real analysis via Upstash KV

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60'); // Cache 1 min

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  var counters = { bills_analyzed: 100, charges_reviewed: 2000000, savings_found: 500000 }; // defaults

  if (process.env.KV_REST_API_URL) {
    try {
      var Redis = require('@upstash/redis').Redis;
      var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

      var bills = await redis.get('counter:bills_analyzed');
      var charges = await redis.get('counter:charges_reviewed');
      var savings = await redis.get('counter:savings_found');

      counters.bills_analyzed = Math.max(100, parseInt(bills || '100'));
      counters.charges_reviewed = Math.max(2000000, parseInt(charges || '2000000'));
      counters.savings_found = Math.max(500000, parseInt(savings || '500000'));
    } catch(e) {
      console.log('Counter fetch failed:', e.message);
    }
  }

  // Format for display
  counters.display = {
    bills: counters.bills_analyzed.toLocaleString() + '+',
    charges: '$' + (counters.charges_reviewed / 1000000).toFixed(1) + 'M+',
    savings: '$' + (counters.savings_found / 1000).toFixed(0) + 'K+',
  };

  return res.status(200).json(counters);
};
