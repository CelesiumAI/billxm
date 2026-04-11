const Anthropic = require('@anthropic-ai/sdk');

// ── Rate limit: 30 chat messages per hour per email ──────────
var chatCounts = {};
function checkRateLimit(email) {
  var now = Date.now();
  var key = (email || 'anon') + ':' + Math.floor(now / 3600000);
  chatCounts[key] = (chatCounts[key] || 0) + 1;
  return chatCounts[key] <= 30;
}

// ── System prompt for the billing advisor agent ───────────────
function buildSystemPrompt(report) {
  var hospitalName = report.hospital || 'the hospital';
  var totalBilled = report.total_billed || 0;
  var commercialSavings = report.commercial_savings || 0;
  var billState = report.bill_state || 'SELF_PAY';
  var issueCount = (report.issues || []).length;

  var stateContext = '';
  if (billState === 'FULLY_RESOLVED') {
    stateContext = 'This bill is fully resolved — the patient owes $0. The insurance has already paid and the contractual adjustment brought the balance to zero.';
  } else if (billState === 'PRE_PAYMENT_INSURED') {
    stateContext = 'Insurance has not yet processed this claim. The total shown is the hospital list price, not what the patient will actually owe.';
  } else if (billState === 'BALANCE_BILL') {
    stateContext = 'The patient may be receiving a balance bill. Federal law (No Surprises Act) may protect them from owing more than their in-network cost-share.';
  } else if (billState === 'COST_SHARE_DISPUTE') {
    stateContext = 'Insurance has processed this claim. The patient is disputing their cost-share portion. Reducing the underlying charges may reduce their balance.';
  } else {
    stateContext = 'This appears to be a self-pay or uninsured situation. The patient has leverage to negotiate against the hospital list price.';
  }

  return 'You are BillXM AI, a friendly and knowledgeable medical billing advisor. You help patients understand their hospital bills and know their rights.\n\n' +
    'BILL SUMMARY:\n' +
    '- Hospital: ' + hospitalName + '\n' +
    '- Total billed (list price): $' + totalBilled.toLocaleString() + '\n' +
    '- Issues found: ' + issueCount + '\n' +
    '- Potential savings vs commercial typical rates: $' + commercialSavings.toLocaleString() + '\n' +
    '- Bill status: ' + stateContext + '\n\n' +
    'FULL REPORT DATA:\n' + JSON.stringify(report, null, 2) + '\n\n' +
    'YOUR ROLE:\n' +
    '- Answer questions about THIS specific bill using the report data above\n' +
    '- Answer general medical billing questions (what is an EOB, how does the No Surprises Act work, what is a CPT code, etc.)\n' +
    '- Give practical, actionable advice patients can use today\n' +
    '- Use plain English. Never use jargon without explaining it. Write like you are talking to a family member.\n' +
    '- Never use the word "chargemaster" — say "list price" instead\n' +
    '- If asked about a specific charge, look it up in the report data and explain it clearly\n' +
    '- If you genuinely cannot answer a question, say so honestly and offer to escalate to the BillXM billing team\n\n' +
    'WHAT YOU MUST NOT DO:\n' +
    '- Give legal advice or act as a lawyer\n' +
    '- Give medical advice about treatments or diagnoses\n' +
    '- Make up CPT codes, rates, or facts not in the report\n' +
    '- Promise specific outcomes ("you will definitely save $X")\n\n' +
    'ESCALATION:\n' +
    'If a question is beyond your scope or requires human review, end your response with exactly this phrase on its own line:\n' +
    'ESCALATE: [one sentence summarizing what the patient needs help with]\n\n' +
    'Keep responses concise — 2-4 sentences for simple questions, up to a short paragraph for complex ones. Use bullet points only when listing multiple items.';
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var messages = body.messages || [];
  var report = body.report || {};
  var email = body.email || '';
  var tier = body.tier || '';

  // Only available to paid tiers
  if (!['report', 'full', 'demo'].includes(tier)) {
    return res.status(403).json({ error: 'Chat is available with paid reports. Upgrade to access.' });
  }

  if (!messages.length) return res.status(400).json({ error: 'No messages provided' });

  // Rate limit
  if (!checkRateLimit(email)) {
    return res.status(429).json({ error: 'Too many messages. Please wait before sending more.' });
  }

  try {
    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    var systemPrompt = buildSystemPrompt(report);

    var response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: messages,
    });

    var text = response.content.map(function(b) { return b.text || ''; }).join('');

    // Check if the response contains an escalation signal
    var escalate = false;
    var escalateReason = '';
    var escalateMatch = text.match(/ESCALATE:\s*(.+)/);
    if (escalateMatch) {
      escalate = true;
      escalateReason = escalateMatch[1].trim();
      // Remove the escalation signal from the visible response
      text = text.replace(/\nESCALATE:.*$/s, '').trim();
    }

    return res.status(200).json({
      content: text,
      escalate: escalate,
      escalate_reason: escalateReason,
    });

  } catch (err) {
    console.error('chat error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
