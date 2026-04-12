const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Load CMS data once at startup ────────────────────────────
let CMS_RVUS = null;
let CMS_GPCI = null;
let CMS_DRG = null;
let CMS_APC = null;

function loadCMSData() {
  if (CMS_RVUS) return;
  try {
    CMS_RVUS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cms_rvus.json'), 'utf8'));
    CMS_GPCI = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cms_gpci.json'), 'utf8'));
  } catch (err) { console.error('Failed to load CMS RVU/GPCI data:', err.message); }
  try {
    CMS_DRG = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cms_drg.json'), 'utf8'));
  } catch (e) { console.log('No DRG data, continuing without it'); }
  try {
    CMS_APC = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cms_apc.json'), 'utf8'));
  } catch (e) { console.log('No APC data, continuing without it'); }
}

// ── Normalize a code from a hospital bill ────────────────────
function normalizeCode(code) {
  if (!code) return '';
  var c = code.toString().trim().toUpperCase();
  // All zeros = no CPT (drug/supply line)
  if (/^0+$/.test(c)) return '';
  // 6-digit with leading zero: 036600 -> 36600
  if (c.length === 6 && c[0] === '0' && /^\d+$/.test(c)) {
    c = c.slice(1);
  }
  return c;
}

// ── Look up GPCI for a state/city ────────────────────────────
function getGPCI(state, city) {
  if (!CMS_GPCI || !CMS_GPCI.localities || !state) {
    return CMS_RVUS ? CMS_RVUS.national_avg_gpci : { work: 1.02, pe: 1.042, mp: 0.848 };
  }
  var stateUpper = state.toUpperCase().trim();
  var cityUpper = city ? city.toUpperCase().trim() : '';
  var stateLocalities = Object.keys(CMS_GPCI.localities)
    .filter(function(k) { return k.startsWith(stateUpper + '_'); })
    .map(function(k) { return CMS_GPCI.localities[k]; });
  if (stateLocalities.length === 0) return CMS_RVUS.national_avg_gpci;
  if (cityUpper) {
    for (var i = 0; i < stateLocalities.length; i++) {
      if (stateLocalities[i].name && stateLocalities[i].name.indexOf(cityUpper) >= 0) {
        return { work: stateLocalities[i].work, pe: stateLocalities[i].pe, mp: stateLocalities[i].mp };
      }
    }
  }
  var first = stateLocalities[0];
  return { work: first.work, pe: first.pe, mp: first.mp };
}

// ── Look up fair rate for a normalized code ──────────────────
function getFairRate(code, state, city) {
  if (!CMS_RVUS || !code) return null;

  // Check lab rates (national, no locality adjustment)
  if (CMS_RVUS.labs && CMS_RVUS.labs[code]) {
    var lab = CMS_RVUS.labs[code];
    return { rate: lab.r, desc: lab.d, type: 'lab' };
  }

  // Check drug codes (J-codes)
  if (CMS_RVUS.drugs && CMS_RVUS.drugs[code]) {
    var drug = CMS_RVUS.drugs[code];
    return { rate: drug.r, desc: drug.d, dose: drug.dose, type: 'drug' };
  }

  // Check physician RVUs
  if (CMS_RVUS.rvus && CMS_RVUS.rvus[code]) {
    var rvu = CMS_RVUS.rvus[code];
    var gpci = getGPCI(state, city);
    var CF = CMS_RVUS.conversion_factor || 33.4009;
    var rate = Math.round(
      ((rvu.w * gpci.work) + (rvu.p * gpci.pe) + (rvu.m * gpci.mp)) * CF * 100
    ) / 100;
    return { rate: rate, desc: rvu.d, type: 'physician' };
  }

  return null;
}

// ── Detect bill type from extraction ─────────────────────────
function detectBillType(extracted) {
  var text = (extracted.bill_type_text || '').toLowerCase();
  // "inpatient" keyword always wins
  if (text.indexOf('inpatient') >= 0) return 'INPATIENT';
  if (text.indexOf('outpatient') >= 0) return 'OUTPATIENT';
  if (text.indexOf('emergency') >= 0) return 'OUTPATIENT';
  if (text.indexOf('observation') >= 0) return 'OUTPATIENT';

  // Check for ER codes
  var hasER = false;
  (extracted.line_items || []).forEach(function(item) {
    var c = normalizeCode(item.code);
    if (['99281','99282','99283','99284','99285'].indexOf(c) >= 0) hasER = true;
  });
  if (hasER) return 'OUTPATIENT';

  // Check date range
  var dos = extracted.date_of_service || '';
  if (dos.indexOf('-') >= 0 || dos.indexOf('to') >= 0 || dos.indexOf('thru') >= 0) {
    return 'INPATIENT';
  }

  return 'OUTPATIENT'; // default
}

// ── Estimate DRG from services on the bill ───────────────────
function estimateDRG(extracted) {
  if (!CMS_DRG || !CMS_DRG.drgs) return null;

  var text = '';
  (extracted.line_items || []).forEach(function(item) {
    text += ' ' + (item.description || '').toLowerCase();
    text += ' ' + (item.category || '').toLowerCase();
  });

  // Simple keyword matching for common DRGs
  var candidates = [];
  if (text.indexOf('pneumonia') >= 0 || (text.indexOf('respiratory') >= 0 && text.indexOf('inhalation') >= 0)) {
    candidates.push('194', '193', '192'); // Pneumonia/respiratory
  }
  if (text.indexOf('heart failure') >= 0 || text.indexOf('cardiac') >= 0) {
    candidates.push('293', '292', '291');
  }
  if (text.indexOf('sepsis') >= 0 || text.indexOf('septicemia') >= 0) {
    candidates.push('872', '871');
  }
  if (text.indexOf('chest pain') >= 0) {
    candidates.push('313');
  }
  if (text.indexOf('copd') >= 0 || text.indexOf('obstructive pulmonary') >= 0 || text.indexOf('bronchitis') >= 0 || text.indexOf('asthma') >= 0) {
    candidates.push('192', '193', '194', '203', '202');
  }

  // Default to respiratory if we see respiratory therapy codes but no specific diagnosis
  if (candidates.length === 0 && (text.indexOf('inhalation') >= 0 || text.indexOf('nebuliz') >= 0 || text.indexOf('chest physio') >= 0)) {
    candidates.push('194', '193', '192');
  }

  // Default to a general medical DRG if nothing matches
  if (candidates.length === 0) {
    candidates.push('194'); // Simple pneumonia w/ CC as a safe default for respiratory-type stays
  }

  // Return first match found in our DRG table
  for (var i = 0; i < candidates.length; i++) {
    var drg = CMS_DRG.drgs[candidates[i]];
    if (drg) {
      return {
        code: candidates[i],
        desc: drg.desc || drg.d || '',
        payment: drg.national_payment || drg.n || 0,
        los: drg.geo_los || drg.l || 0
      };
    }
  }
  return null;
}

// ── Haiku extraction prompt ──────────────────────────────────
var EXTRACT_PROMPT = 'You are a medical bill data extractor. Extract every charge from this bill into structured JSON.\n\n' +
'Rules:\n' +
'- Include EVERY line item on the bill, even $0.00 items\n' +
'- Preserve the exact code shown on the bill (including leading zeros like 036600)\n' +
'- Use the exact dollar amounts shown on the bill\n' +
'- Your total_billed MUST equal the bill\'s stated total. Look for "Total Amount for Hospital Services", "Total Charges", "Amount You Owe", "Total", or similar\n' +
'- If the bill shows subtotals by category, make sure all items from every category are included\n' +
'- Count line items carefully. If a service appears multiple times on different dates, each is a separate line item\n' +
'- Identify bill type: look for the words "INPATIENT" or "OUTPATIENT" printed on the bill\n' +
'- For drugs with code 00000, set code to "" and include the drug name in description\n' +
'- Include adjustments/discounts if shown on the bill\n\n' +
'Return ONLY valid JSON, no markdown, no explanation:\n' +
'{\n' +
'  "hospital": "hospital name",\n' +
'  "state": "2-letter state code",\n' +
'  "city": "city name",\n' +
'  "date_of_service": "date or date range",\n' +
'  "bill_type_text": "exact text from bill describing patient type, e.g. INPATIENT SERVICES",\n' +
'  "line_items": [\n' +
'    {"code": "036600", "description": "ARTERIAL PUNCTURE", "quantity": 1, "billed": 372.28, "date": "10/10/22", "category": "LABORATORY"}\n' +
'  ],\n' +
'  "adjustments": 0,\n' +
'  "total_before_adjustments": 0,\n' +
'  "total_billed": 0\n' +
'}\n\n' +
'CRITICAL: Count all line items from ALL pages and ALL categories. The sum of all line item billed amounts should approximately equal total_before_adjustments. Missing line items is the worst error you can make.\n\n' +
'MULTI-PAGE BILLS: Hospital bills often span 3-5 pages with categories like:\n' +
'- Room and Care (rev code 0110)\n' +
'- Laboratory (rev codes 0300-0319)\n' +
'- Lab-Chemistry (rev code 0301)\n' +
'- Lab-Hematology (rev code 0305)\n' +
'- Radiology/Diagnostic (rev codes 0320-0329)\n' +
'- Respiratory/Respiratory SVC (rev codes 0410-0419)\n' +
'- Drugs/Pharmacy (rev codes 0250-0259, 0636-0637)\n' +
'- EKG/EEG (rev codes 0730-0739)\n' +
'- Other/Convenience items (rev code 0999)\n' +
'You MUST scan every page and capture items from every category.';

// ── Sonnet report prompt (NO rate tables - data is pre-enriched) ──
var REPORT_PROMPT = 'You are BillXM AI, a medical billing analyst.\n\n' +
'You will receive pre-analyzed medical bill data. Each line item already has its government fair rate looked up. ' +
'The bill type (INPATIENT or OUTPATIENT) is already determined. If inpatient, a DRG benchmark is provided.\n\n' +
'Your job is to write the analysis report. The data work is done. You focus on:\n' +
'1. Writing a clear, patient-friendly summary with specific dollar examples\n' +
'2. Identifying issues (overcharges, duplicates, suspicious patterns)\n' +
'3. Assigning a grade based on the overcharge data provided\n' +
'4. Providing actionable next steps\n\n' +
'GRADING (based on potential_savings / total_billed):\n' +
'- A = savings < 10% of billed (reasonable bill)\n' +
'- B = savings 10-25%\n' +
'- C = savings 25-50%\n' +
'- D = savings 50-75%\n' +
'- F = savings >75% OR definitive coding violations\n\n' +
'ISSUES - only flag items where billed significantly exceeds fair rate:\n' +
'- EXCESSIVE_MARKUP: billed > 2x fair rate. Severity: HIGH if >300%, MEDIUM if 150-300%, LOW if 100-150%\n' +
'- DUPLICATE: same code on same date without justification\n' +
'- Do NOT flag NO_CPT items or items without fair rates\n\n' +
'Return ONLY valid JSON. No markdown, no backticks:\n' +
'{\n' +
'  "grade": "A-F",\n' +
'  "grade_rationale": "one sentence",\n' +
'  "summary": "2-3 sentences in plain English with specific dollar examples of overcharges",\n' +
'  "issues": [\n' +
'    {\n' +
'      "type": "EXCESSIVE_MARKUP|DUPLICATE|UPCODED|UNBUNDLED",\n' +
'      "severity": "HIGH|MEDIUM|LOW",\n' +
'      "confidence": 95,\n' +
'      "code": "CPT code",\n' +
'      "description": "plain English explanation",\n' +
'      "billed": 0,\n' +
'      "fair_value": 0,\n' +
'      "savings": 0,\n' +
'      "cms_rule": "fee schedule citation",\n' +
'      "dispute_basis": "grounds for dispute"\n' +
'    }\n' +
'  ],\n' +
'  "next_steps": ["actionable step"],\n' +
'  "nsa_eligible": false,\n' +
'  "financial_assistance_note": "guidance if applicable",\n' +
'  "insurance_notes": "info if relevant",\n' +
'  "appeal_recommended": false\n' +
'}\n\n' +
'CRITICAL: Use the total_billed, estimated_fair_value, and potential_savings exactly as provided. Do not recalculate them.\n' +
'Write in plain English a patient can understand.';

// ── Grade-only prompt for free tier ──────────────────────────
var GRADE_PROMPT = 'You are BillXM AI. Quickly assess this medical bill data and return a grade.\n\n' +
'Grade based on the overcharge percentage provided:\n' +
'- A = overcharge < 10%\n' +
'- B = overcharge 10-25%\n' +
'- C = overcharge 25-50%\n' +
'- D = overcharge 50-75%\n' +
'- F = overcharge >75% or billing violations\n\n' +
'If potential_savings is $0, grade MUST be A.\n\n' +
'Return ONLY valid JSON:\n' +
'{"grade":"A-F","grade_rationale":"one sentence","summary":"2 sentences for patient",' +
'"total_billed":0,"estimated_fair_value":0,"potential_savings":0,' +
'"issue_count":0,"high_count":0,"medium_count":0,"low_count":0}';

// ── Main handler ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var messages = body.messages;
  var tier = body.tier;

  // Debug logging
  console.log('=== REQUEST RECEIVED ===');
  console.log('Body keys:', Object.keys(body));
  console.log('Tier:', tier);
  console.log('Messages type:', typeof messages, 'isArray:', Array.isArray(messages));
  if (messages && messages[0]) {
    console.log('First msg role:', messages[0].role);
    console.log('First msg content type:', typeof messages[0].content, 'isArray:', Array.isArray(messages[0].content));
    if (Array.isArray(messages[0].content) && messages[0].content[0]) {
      console.log('First content block type:', messages[0].content[0].type);
    }
  }

  if (!messages || !tier) return res.status(400).json({ error: 'Missing messages or tier' });

  // Normalize messages to ensure valid Anthropic API format
  if (!Array.isArray(messages)) {
    messages = [{ role: 'user', content: String(messages) }];
  }
  // Ensure each message has role and content
  messages = messages.map(function(msg) {
    if (!msg.role) msg.role = 'user';
    if (msg.content === undefined || msg.content === null) msg.content = '';
    // If content is a string, keep as string
    // If content is an array, keep as array (content blocks)
    // If content is something else, stringify it
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      msg.content = JSON.stringify(msg.content);
    }
    return msg;
  });

  try {
    loadCMSData();
    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ════════════════════════════════════════════════════════════
    // STEP 1: Extract structured data with Haiku
    // ════════════════════════════════════════════════════════════
    console.log('Step 1: Extracting bill data with Haiku...');
    console.log('Sending ' + messages.length + ' message(s) to Haiku');

    var extractResponse;
    try {
      extractResponse = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: EXTRACT_PROMPT,
        messages: messages,
      });
    } catch (apiErr) {
      console.error('Haiku API error:', apiErr.status, apiErr.message);
      console.error('Messages sent:', JSON.stringify(messages).slice(0, 500));
      throw new Error(apiErr.status + ' ' + JSON.stringify(apiErr.error || apiErr.message));
    }

    var extracted;
    try {
      var raw = extractResponse.content.map(function(b) { return b.text || ''; }).join('');
      raw = raw.replace(/```json|```/g, '').trim();
      var s = raw.indexOf('{');
      var e = raw.lastIndexOf('}');
      if (s === -1 || e === -1) throw new Error('No JSON found');
      extracted = JSON.parse(raw.slice(s, e + 1));
    } catch (err) {
      throw new Error('Failed to parse bill extraction: ' + err.message);
    }

    var extractedTotal = extracted.total_billed || 0;
    var itemCount = (extracted.line_items || []).length;
    console.log('Extracted: ' + itemCount + ' items, total: $' + extractedTotal.toFixed(2));

    // ── Validate: do line items sum match stated total? ──
    var lineItemSum = 0;
    (extracted.line_items || []).forEach(function(item) {
      lineItemSum += (item.billed || 0);
    });
    var totalDiff = Math.abs(lineItemSum - extractedTotal);
    var totalPct = extractedTotal > 0 ? (totalDiff / extractedTotal) : 0;

    if (totalPct > 0.15 && extractedTotal > 0) {
      console.log('WARNING: Items sum $' + lineItemSum.toFixed(2) + ' vs total $' + extractedTotal.toFixed(2) + ' (gap ' + Math.round(totalPct * 100) + '%). Retrying...');
      var retryResponse = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: EXTRACT_PROMPT + '\n\nPREVIOUS ATTEMPT MISSED LINE ITEMS. Bill total is $' + extractedTotal.toFixed(2) + ' but only $' + lineItemSum.toFixed(2) + ' captured. Include ALL items from ALL pages and ALL categories.',
        messages: messages,
      });
      try {
        var retryRaw = retryResponse.content.map(function(b) { return b.text || ''; }).join('');
        retryRaw = retryRaw.replace(/```json|```/g, '').trim();
        var rs = retryRaw.indexOf('{');
        var re2 = retryRaw.lastIndexOf('}');
        if (rs !== -1 && re2 !== -1) {
          var retryExtracted = JSON.parse(retryRaw.slice(rs, re2 + 1));
          var retrySum = 0;
          (retryExtracted.line_items || []).forEach(function(item) { retrySum += (item.billed || 0); });
          var retryDiff = Math.abs(retrySum - (retryExtracted.total_billed || extractedTotal));
          if (retryDiff < totalDiff) {
            console.log('Retry improved: $' + retrySum.toFixed(2) + ' (was $' + lineItemSum.toFixed(2) + ')');
            extracted = retryExtracted;
            extractedTotal = extracted.total_billed || extractedTotal;
          }
        }
      } catch (retryErr) { console.log('Retry parse failed, keeping original'); }
    }

    // ════════════════════════════════════════════════════════════
    // STEP 1b: Net charge/reversal pairs
    // ════════════════════════════════════════════════════════════
    // Hospital bills sometimes show charge + reversal + re-charge for the same service.
    // Example: CT HEAD $4,906 then -$4,906 then $4,906 again. Net = $4,906 (one charge).
    // We group by description+date and sum the amounts.
    if (extracted.line_items && extracted.line_items.length > 0) {
      var grouped = {};
      extracted.line_items.forEach(function(item) {
        var key = (item.description || '').trim().toUpperCase() + '|' + (item.date || '');
        if (!grouped[key]) {
          grouped[key] = { items: [], netAmount: 0 };
        }
        grouped[key].items.push(item);
        grouped[key].netAmount += (item.billed || 0);
      });

      // Check if any group has charge+reversal pairs (positive and negative amounts)
      var hasReversals = false;
      Object.keys(grouped).forEach(function(key) {
        var g = grouped[key];
        if (g.items.length > 1) {
          var hasPositive = g.items.some(function(i) { return (i.billed || 0) > 0; });
          var hasNegative = g.items.some(function(i) { return (i.billed || 0) < 0; });
          if (hasPositive && hasNegative) hasReversals = true;
        }
      });

      if (hasReversals) {
        console.log('Charge/reversal pairs detected. Netting...');
        var netted = [];
        Object.keys(grouped).forEach(function(key) {
          var g = grouped[key];
          var netAmount = Math.round(g.netAmount * 100) / 100;
          if (Math.abs(netAmount) > 0.01) {
            // Keep one representative item with the netted amount
            var rep = JSON.parse(JSON.stringify(g.items[0]));
            rep.billed = netAmount;
            rep.quantity = 1;
            netted.push(rep);
          }
          // If net is $0 or near $0, drop the entire group (fully reversed)
        });
        console.log('Netted: ' + extracted.line_items.length + ' items -> ' + netted.length + ' items');
        extracted.line_items = netted;

        // Recalculate total from netted items
        var nettedSum = 0;
        netted.forEach(function(item) { nettedSum += (item.billed || 0); });
        console.log('Netted total: $' + nettedSum.toFixed(2) + ' (original stated: $' + extractedTotal.toFixed(2) + ')');
        // Keep the bill's stated total if available; otherwise use netted sum
        if (!extractedTotal || extractedTotal <= 0) {
          extractedTotal = nettedSum;
          extracted.total_billed = nettedSum;
        }
      }
    }

    // ════════════════════════════════════════════════════════════
    // STEP 2: JavaScript enrichment — normalize codes, look up rates
    // ════════════════════════════════════════════════════════════
    console.log('Step 2: Looking up CMS rates...');
    var state = extracted.state || '';
    var city = extracted.city || '';
    var billType = detectBillType(extracted);
    console.log('Bill type: ' + billType);

    var totalBilled = extractedTotal;
    var totalFairCPT = 0; // sum of individual CPT fair rates
    var highCount = 0, medCount = 0, lowCount = 0;

    var enrichedItems = (extracted.line_items || []).map(function(item) {
      var code = normalizeCode(item.code);
      var qty = item.quantity || 1;
      var billed = item.billed || 0;
      var lookup = code ? getFairRate(code, state, city) : null;
      var fairRate = lookup ? lookup.rate : null;
      var totalFairItem = fairRate ? Math.round(fairRate * qty * 100) / 100 : null;
      var savings = (fairRate && billed > totalFairItem) ? Math.round((billed - totalFairItem) * 100) / 100 : 0;
      var markupPct = (totalFairItem && totalFairItem > 0) ? Math.round((billed / totalFairItem - 1) * 100) : null;

      if (totalFairItem) totalFairCPT += totalFairItem;

      // Classify severity
      var status = 'OK';
      if (!code) {
        status = 'NO_CPT';
      } else if (markupPct !== null && markupPct > 0) {
        if (markupPct > 300) { status = 'FLAG'; highCount++; }
        else if (markupPct > 150) { status = 'FLAG'; medCount++; }
        else if (markupPct > 100) { status = 'FLAG'; lowCount++; }
      }

      return {
        code: code,
        original_code: item.code || '',
        description: item.description || '',
        billed: billed,
        quantity: qty,
        fair_rate: fairRate,
        total_fair: totalFairItem,
        markup_pct: markupPct !== null ? markupPct + '%' : 'N/A',
        savings: savings,
        status: status,
        type: lookup ? lookup.type : (code ? 'unknown' : 'no_code'),
        date: item.date || '',
        category: item.category || ''
      };
    });

    // ════════════════════════════════════════════════════════════
    // STEP 2b: Haiku fallback — map unrecognized descriptions to CPT
    // ════════════════════════════════════════════════════════════
    // If many items have no fair rate, ask Haiku to map their descriptions to standard CPT codes
    var unmatchedItems = enrichedItems.filter(function(item) {
      return item.fair_rate === null && item.billed > 0 && item.description.length > 3;
    });
    var unmatchedValue = 0;
    unmatchedItems.forEach(function(item) { unmatchedValue += item.billed; });

    if (unmatchedItems.length >= 2 && unmatchedValue > totalBilled * 0.3) {
      console.log('Step 2b: ' + unmatchedItems.length + ' items ($' + unmatchedValue.toFixed(2) + ') unmatched. Asking Haiku to map descriptions to CPT codes...');

      var mapPrompt = 'You are a medical coding expert. Map each service description to its standard CPT code.\n\n' +
        'Return ONLY valid JSON, no markdown:\n' +
        '{"mappings": [{"description": "original description", "cpt": "5-digit CPT code", "confidence": "HIGH|MEDIUM|LOW"}]}\n\n' +
        'Rules:\n' +
        '- Only map if you are confident in the CPT code\n' +
        '- If unsure, set cpt to "" and confidence to "LOW"\n' +
        '- Common mappings: EKG 12 LEAD = 93000, CT HEAD W/O CONTRAST = 70450, CBC WITH AUTO DIFF = 85025,\n' +
        '  BASIC METABOLIC PANEL = 80048, COMP METABOLIC PANEL = 80053, ED LEVEL IV = 99284, ED LEVEL V = 99285,\n' +
        '  ED LEVEL III = 99283, CHEST X-RAY = 71046, IV INFUSION HYDRATION = 96360, HCG QUAL = 81025,\n' +
        '  THYROID STIMULATING HORMONE = 84443, URINALYSIS = 81003, LIPID PANEL = 80061\n' +
        '- For drugs (ACETAMINOPHEN, SODIUM CHLORIDE, etc.) set cpt to "" — drugs use J-codes not CPT\n';

      var descriptionsToMap = unmatchedItems.map(function(item) {
        return item.description;
      });

      try {
        var mapResponse = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: mapPrompt,
          messages: [{ role: 'user', content: 'Map these service descriptions to CPT codes:\n' + JSON.stringify(descriptionsToMap) }],
        });

        var mapRaw = mapResponse.content.map(function(b) { return b.text || ''; }).join('');
        mapRaw = mapRaw.replace(/```json|```/g, '').trim();
        var ms = mapRaw.indexOf('{');
        var me = mapRaw.lastIndexOf('}');
        if (ms !== -1 && me !== -1) {
          var mapped = JSON.parse(mapRaw.slice(ms, me + 1));
          var mappedCount = 0;

          if (mapped.mappings && Array.isArray(mapped.mappings)) {
            mapped.mappings.forEach(function(m) {
              if (!m.cpt || m.cpt.length < 4) return; // skip empty/invalid
              var cptCode = m.cpt.trim().toUpperCase();
              var lookup = getFairRate(cptCode, state, city);
              if (!lookup) return;

              // Find matching enriched item(s) by description
              enrichedItems.forEach(function(item) {
                if (item.fair_rate !== null) return; // already has rate
                var descUpper = (item.description || '').toUpperCase();
                var mapDescUpper = (m.description || '').toUpperCase();
                if (descUpper === mapDescUpper || descUpper.indexOf(mapDescUpper) >= 0 || mapDescUpper.indexOf(descUpper) >= 0) {
                  var qty = item.quantity || 1;
                  item.code = cptCode;
                  item.fair_rate = lookup.rate;
                  item.total_fair = Math.round(lookup.rate * qty * 100) / 100;
                  item.savings = item.billed > item.total_fair ? Math.round((item.billed - item.total_fair) * 100) / 100 : 0;
                  item.markup_pct = item.total_fair > 0 ? Math.round((item.billed / item.total_fair - 1) * 100) + '%' : 'N/A';
                  item.type = lookup.type;
                  item.status = 'OK';
                  item.note = 'CPT mapped from description';

                  totalFairCPT += item.total_fair;

                  // Update severity counts
                  var mPct = item.total_fair > 0 ? Math.round((item.billed / item.total_fair - 1) * 100) : 0;
                  if (mPct > 300) { item.status = 'FLAG'; highCount++; }
                  else if (mPct > 150) { item.status = 'FLAG'; medCount++; }
                  else if (mPct > 100) { item.status = 'FLAG'; lowCount++; }

                  mappedCount++;
                }
              });
            });
          }
          console.log('Haiku mapped ' + mappedCount + ' items to CPT codes. New CPT fair total: $' + totalFairCPT.toFixed(2));
        }
      } catch (mapErr) {
        console.log('CPT mapping fallback failed (non-fatal):', mapErr.message);
      }
    }

    // ── Determine fair value based on bill type ──
    var estimatedFairValue = 0;
    var drgEstimate = null;
    var apcEstimate = null;

    if (billType === 'INPATIENT') {
      // For inpatient: DRG payment IS the fair value (bundled payment)
      var drg = estimateDRG(extracted);
      if (drg) {
        estimatedFairValue = drg.payment;
        var drgMarkup = totalBilled > 0 && drg.payment > 0 ? (totalBilled / drg.payment).toFixed(1) : '0';
        drgEstimate = {
          drg_code: drg.code,
          drg_description: drg.desc,
          drg_payment: drg.payment,
          markup_multiplier: drgMarkup + 'x'
        };
        console.log('DRG ' + drg.code + ': $' + drg.payment.toFixed(2) + ' (hospital billed $' + totalBilled.toFixed(2) + ' = ' + drgMarkup + 'x)');
      } else {
        // Fallback if no DRG match: use CPT sum
        estimatedFairValue = totalFairCPT;
        console.log('No DRG match, using CPT sum: $' + totalFairCPT.toFixed(2));
      }
    } else {
      // For outpatient: sum of CPT fair rates + APC
      estimatedFairValue = totalFairCPT;
      // Add APC if available (placeholder - would need APC code matching)
      if (CMS_APC && CMS_APC.apcs) {
        // Try to match ER APC
        var hasER = enrichedItems.some(function(item) {
          return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0;
        });
        if (hasER) {
          var erLevel = enrichedItems.find(function(item) {
            return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0;
          });
          // APC for ER visits
          var apcCode = null;
          if (erLevel && erLevel.code === '99285') apcCode = '5025';
          else if (erLevel && erLevel.code === '99284') apcCode = '5024';
          else if (erLevel && erLevel.code === '99283') apcCode = '5023';
          else if (erLevel && erLevel.code === '99282') apcCode = '5022';
          else if (erLevel && erLevel.code === '99281') apcCode = '5021';

          if (apcCode && CMS_APC.apcs[apcCode]) {
            var apc = CMS_APC.apcs[apcCode];
            var apcPayment = apc.payment || apc.r || 0;
            estimatedFairValue += apcPayment;
            apcEstimate = {
              apc_description: (apc.desc || apc.d || 'ER facility fee') + ' (APC ' + apcCode + ')',
              apc_payment: apcPayment
            };
          }
        }
      }
      console.log('Outpatient fair value (CPT + APC): $' + estimatedFairValue.toFixed(2));
    }

    var potentialSavings = Math.max(0, Math.round((totalBilled - estimatedFairValue) * 100) / 100);
    var overchargePct = totalBilled > 0 ? Math.round((potentialSavings / totalBilled) * 100) : 0;
    var issueCount = highCount + medCount + lowCount;

    console.log('Summary: Billed $' + totalBilled.toFixed(2) + ', Fair $' + estimatedFairValue.toFixed(2) + ', Savings $' + potentialSavings.toFixed(2) + ' (' + overchargePct + '%), Issues: ' + issueCount);

    // ════════════════════════════════════════════════════════════
    // STEP 3a: Free grade (Haiku)
    // ════════════════════════════════════════════════════════════
    if (tier === 'grade') {
      console.log('Step 3a: Free grade with Haiku...');
      var gradeInput = {
        bill_type: billType,
        total_billed: totalBilled,
        estimated_fair_value: estimatedFairValue,
        potential_savings: potentialSavings,
        overcharge_pct: overchargePct,
        issue_count: issueCount,
        high_count: highCount,
        medium_count: medCount,
        low_count: lowCount,
        hospital: extracted.hospital || '',
        top_overcharges: enrichedItems
          .filter(function(i) { return i.status === 'FLAG'; })
          .slice(0, 5)
          .map(function(i) { return i.description + ': billed $' + i.billed + ' vs fair $' + (i.total_fair || 'N/A'); })
      };

      var gradeResponse = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: GRADE_PROMPT,
        messages: [{ role: 'user', content: 'Grade this bill:\n' + JSON.stringify(gradeInput) }],
      });

      var gradeRaw = gradeResponse.content.map(function(b) { return b.text || ''; }).join('');
      gradeRaw = gradeRaw.replace(/```json|```/g, '').trim();
      var gs = gradeRaw.indexOf('{');
      var ge = gradeRaw.lastIndexOf('}');
      var grade = JSON.parse(gradeRaw.slice(gs, ge + 1));

      // Enforce calculated values
      grade.total_billed = totalBilled;
      grade.estimated_fair_value = estimatedFairValue;
      grade.potential_savings = potentialSavings;

      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(grade) }] });
    }

    // ════════════════════════════════════════════════════════════
    // STEP 3b: Full report (Sonnet — no rate tables needed)
    // ════════════════════════════════════════════════════════════
    console.log('Step 3b: Generating report with Sonnet...');

    var reportInput = {
      bill_type: billType,
      hospital: extracted.hospital || '',
      state: state,
      city: city,
      date_of_service: extracted.date_of_service || '',
      total_billed: totalBilled,
      estimated_fair_value: estimatedFairValue,
      potential_savings: potentialSavings,
      overcharge_pct: overchargePct,
      drg_estimate: drgEstimate,
      apc_estimate: apcEstimate,
      line_items: enrichedItems,
      issue_counts: { high: highCount, medium: medCount, low: lowCount, total: issueCount },
    };

    var reportResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: REPORT_PROMPT,
      messages: [{
        role: 'user',
        content: 'Write the analysis report for this pre-analyzed bill data:\n\n' + JSON.stringify(reportInput, null, 2)
      }],
    });

    var reportRaw = reportResponse.content.map(function(b) { return b.text || ''; }).join('');
    reportRaw = reportRaw.replace(/```json|```/g, '').trim();
    var rStart = reportRaw.indexOf('{');
    var rEnd = reportRaw.lastIndexOf('}');
    if (rStart === -1 || rEnd === -1) throw new Error('No JSON in report response');
    var report = JSON.parse(reportRaw.slice(rStart, rEnd + 1));

    // ── Enforce calculated values (Sonnet cannot override these) ──
    report.bill_type = billType;
    report.total_billed = totalBilled;
    report.estimated_fair_value = estimatedFairValue;
    report.potential_savings = potentialSavings;
    report.hospital = extracted.hospital || report.hospital;
    report.state = state || report.state;
    report.city = city || report.city;
    report.date_of_service = extracted.date_of_service || report.date_of_service;

    // Enforce DRG/APC data
    if (drgEstimate) report.drg_estimate = drgEstimate;
    if (apcEstimate) report.apc_estimate = apcEstimate;

    // Merge line items from our enrichment (Sonnet may rewrite descriptions but we keep the numbers)
    report.line_items = enrichedItems.map(function(item) {
      return {
        code: item.code,
        description: item.description,
        billed: item.billed,
        quantity: item.quantity,
        fair_rate: item.fair_rate,
        total_fair: item.total_fair,
        markup_pct: item.markup_pct,
        status: item.status,
        note: item.type === 'no_code' ? 'Facility charge, no CPT code' :
              item.type === 'unknown' ? 'Code not found in CMS database' :
              item.status === 'FLAG' ? 'Exceeds Medicare rate' : 'Within expected range'
      };
    });

    return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(report) }] });

  } catch (err) {
    console.error('analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
