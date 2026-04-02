// Anthropic API proxy for image-heavy chunk requests.
// Uses raw-body to read the request without Vercel's body parser,
// then forwards the exact bytes to Anthropic. No JSON parse/stringify on the server.

const getRawBody = require('raw-body');

module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Read raw bytes — no JSON parsing, no possible corruption
    const body = await getRawBody(req, { limit: '10mb', encoding: 'utf-8' });
    console.log('Chunk proxy: forwarding ' + (body.length / 1024).toFixed(0) + ' KB');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: body,
    });

    console.log('Anthropic responded: ' + response.status);

    // Stream the response back without parsing
    const responseText = await response.text();
    res.setHeader('Content-Type', 'application/json');
    res.status(response.status).send(responseText);
  } catch (err) {
    console.error('Chunk proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
