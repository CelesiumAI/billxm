// api/counters.js — Public endpoint for live platform stats
// Returns formatted display values for the website hero section

module.exports = async function handler(req, res) {
  // Allow GET for simple fetch
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    var bills = 200;
    var charges = 4500000;
    var savings = 2600000;

    // Try to load live values from Upstash KV
    if (process.env.KV_REST_API_URL) {
      try {
        var Redis = require('@upstash/redis').Redis;
        var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
        var liveBills = await redis.get('counter:bills_analyzed');
        var liveCharges = await redis.get('counter:charges_reviewed');
        var liveSavings = await redis.get('counter:savings_found');
        if (liveBills && liveBills > 0) bills = liveBills;
        if (liveCharges && liveCharges > 0) charges = liveCharges;
        if (liveSavings && liveSavings > 0) savings = liveSavings;
      } catch (e) {
        console.log('KV read failed, using defaults:', e.message);
      }
    }

    // Format numbers for display
    function formatCount(n) {
      if (n >= 1000) return Math.floor(n / 100) * 100 + '+';
      if (n >= 100) return Math.floor(n / 10) * 10 + '+';
      return n + '+';
    }

    function formatDollars(n) {
      if (n >= 1000000) {
        var millions = n / 1000000;
        // Show one decimal if not a round number
        if (millions % 1 === 0) return '$' + millions.toFixed(0) + 'M+';
        return '$' + millions.toFixed(1) + 'M+';
      }
      if (n >= 1000) {
        var thousands = Math.floor(n / 1000);
        return '$' + thousands.toLocaleString() + 'K+';
      }
      return '$' + n.toLocaleString() + '+';
    }

    return res.status(200).json({
      raw: { bills: bills, charges: charges, savings: savings },
      display: {
        bills: formatCount(bills),
        charges: formatDollars(charges),
        savings: formatDollars(savings)
      }
    });
  } catch (err) {
    console.error('Counters error:', err.message);
    return res.status(200).json({
      display: { bills: '200+', charges: '$4.5M+', savings: '$2.6M+' }
    });
  }
};
