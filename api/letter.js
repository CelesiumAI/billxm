const Anthropic = require('@anthropic-ai/sdk');

const LETTER_PROMPT = `You are a professional patient billing advocate. Generate a formal dispute letter based on the billing analysis provided.

REQUIREMENTS:
- Standard business letter format
- Use these placeholders: [DATE], [PATIENT NAME], [ACCOUNT NUMBER], [DATE OF SERVICE], [PROVIDER NAME], [PROVIDER ADDRESS], [PATIENT ADDRESS], [PATIENT PHONE]
- Opening paragraph: state purpose, total billed, total disputed
- For EACH issue: cite the CPT code, amount billed, government fair value, rule violated, savings requested
- Closing demand: request written correction within 30 days
- Escalation: state failure to respond will result in complaints to Texas Department of Insurance and Texas Attorney General
- Professional, firm, non-adversarial tone
- Plain text only. No markdown. No asterisks. Numbered lists as "1." "2." etc.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { analysisData } = req.body;

  if (!analysisData) {
    return res.status(400).json({ error: 'Missing analysis data' });
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: LETTER_PROMPT,
      messages: [{
        role: 'user',
        content: `Generate a formal dispute letter for this analysis:\n\n${JSON.stringify(analysisData)}`
      }],
    });

    const letter = response.content
      .map(b => b.text || '')
      .join('')
      .trim();

    return res.status(200).json({ letter });

  } catch (err) {
    console.error('Letter error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};