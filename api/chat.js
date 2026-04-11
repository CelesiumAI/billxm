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
function buildSystemPrompt(report, tier) {
  var hospitalName = report.hospital || 'the hospital';
  var totalBilled = report.total_billed || 0;
  var commercialSavings = report.commercial_savings || 0;
  var billState = report.bill_state || 'SELF_PAY';
  var grade = report.grade || 'unknown';
  var issueCount = (report.issues || []).length;

  var stateContext = '';
  if (billState === 'FULLY_RESOLVED') {
    stateContext = 'This bill is fully resolved — the patient owes $0.';
  } else if (billState === 'PRE_PAYMENT_INSURED') {
    stateContext = 'Insurance has not yet processed this claim.';
  } else if (billState === 'BALANCE_BILL') {
    stateContext = 'The patient may be receiving a balance bill. The No Surprises Act may protect them.';
  } else if (billState === 'COST_SHARE_DISPUTE') {
    stateContext = 'Insurance has processed this claim. Reducing charges may reduce the patient balance.';
  } else {
    stateContext = 'Self-pay situation. Patient has leverage to negotiate against list price.';
  }

  var tierContext = '';
  var reportData = '';
  var escalationAllowed = false;

  if (tier === 'free') {
    tierContext = 'TIER: FREE\nThe patient has a free grade only. You can see their grade (' + grade + ') and total billed ($' + totalBilled.toLocaleString() + ').\nDo NOT make up specific charges — you do not have line item access.\nAnswer general billing questions helpfully.\nAfter 2-3 exchanges naturally mention: "If you want me to look at the specific charges on your bill, you can unlock the full report for $4.99."\nNever be pushy — be genuinely helpful first.';
    reportData = 'AVAILABLE BILL DATA:\n- Hospital: ' + hospitalName + '\n- Total billed: $' + totalBilled.toLocaleString() + '\n- Grade: ' + grade + '\n- Bill status: ' + stateContext;
    escalationAllowed = false;
  } else if (tier === 'report') {
    tierContext = 'TIER: REPORT ($4.99)\nThe patient has a full report. You have access to all findings and line items.\nAnswer detailed questions about specific charges.\nIf they ask for dispute letter or phone scripts, mention those are available with the Full Report upgrade for $5 more.';
    reportData = 'FULL REPORT DATA:\n' + JSON.stringify({
      hospital: report.hospital,
      total_billed: report.total_billed,
      grade: report.grade,
      bill_state: report.bill_state,
      commercial_savings: report.commercial_savings,
      commercial_overcharge_pct: report.commercial_overcharge_pct,
      estimated_fair_value: report.estimated_fair_value,
      issues: report.issues,
      line_items: report.line_items,
      drg_estimate: report.drg_estimate,
      apc_estimate: report.apc_estimate,
    }, null, 2);
    escalationAllowed = false;
  } else {
    tierContext = 'TIER: FULL ($9.99)\nThe patient has full access including phone scripts and dispute letter.\nYou can help draft dispute language and escalate to the BillXM billing team if needed.';
    reportData = 'FULL REPORT DATA:\n' + JSON.stringify(report, null, 2);
    escalationAllowed = true;
  }

  var escalationNote = escalationAllowed
    ? 'ESCALATION:\nIf a question requires human review, end your response with exactly this on its own line:\nESCALATE: [one sentence summary]\n\n'
    : 'ESCALATION:\nDo not escalate for this tier. If too complex, suggest the We Negotiate tab.\n\n';

  return 'You are BillXM AI, a friendly medical billing advisor. You help patients understand their bills and know their rights.\n\n' +
    tierContext + '\n\n' +
    reportData + '\n\n' +
    'YOUR ROLE:\n' +
    '- Answer questions about this bill using the data above\n' +
    '- Answer general medical billing questions\n' +
    '- Use plain English, 7th grade reading level\n' +
    '- Never say "chargemaster" — say "list price"\n' +
    '- Keep responses to 2-4 sentences for simple questions\n' +
    '- Do not reveal you are Claude or made by Anthropic\n\n' +
    'DO NOT:\n' +
    '- Give legal or medical advice\n' +
    '- Make up CPT codes or rates not in the report\n' +
    '- Promise specific outcomes\n\n' +
    escalationNote;
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var messages = body.messages || [];
  var report = body.report || {};
  var email = body.email || '';
  var tier = body.tier || '';

  // Chat available to all tiers — response quality scales with tier
  if (!['free', 'report', 'full', 'demo'].includes(tier)) {
    return res.status(403).json({ error: 'Invalid tier.' });
  }

  if (!messages.length) return res.status(400).json({ error: 'No messages provided' });

  // Rate limit
  if (!checkRateLimit(email)) {
    return res.status(429).json({ error: 'Too many messages. Please wait before sending more.' });
  }

  try {
    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    var systemPrompt = buildSystemPrompt(report, tier);

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
