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
  if (/^0+$/.test(c)) return '';
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
  if (CMS_RVUS.labs && CMS_RVUS.labs[code]) {
    var lab = CMS_RVUS.labs[code];
    return { rate: lab.r, desc: lab.d, type: 'lab' };
  }
  if (CMS_RVUS.drugs && CMS_RVUS.drugs[code]) {
    var drug = CMS_RVUS.drugs[code];
    return { rate: drug.r, desc: drug.d, dose: drug.dose, type: 'drug' };
  }
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
  if (text.indexOf('inpatient') >= 0) return 'INPATIENT';
  if (text.indexOf('outpatient') >= 0) return 'OUTPATIENT';
  if (text.indexOf('emergency') >= 0) return 'OUTPATIENT';
  if (text.indexOf('observation') >= 0) return 'OUTPATIENT';
  var hasER = false;
  (extracted.line_items || []).forEach(function(item) {
    var c = normalizeCode(item.code);
    if (['99281','99282','99283','99284','99285'].indexOf(c) >= 0) hasER = true;
  });
  if (hasER) return 'OUTPATIENT';
  var dos = extracted.date_of_service || '';
  if (dos.indexOf('-') >= 0 || dos.indexOf('to') >= 0 || dos.indexOf('thru') >= 0) {
    return 'INPATIENT';
  }
  return 'OUTPATIENT';
}

// ── Estimate DRG from services on the bill ───────────────────
function estimateDRG(extracted) {
  if (!CMS_DRG || !CMS_DRG.drgs) return null;
  var text = '';
  (extracted.line_items || []).forEach(function(item) {
    text += ' ' + (item.description || '').toLowerCase();
    text += ' ' + (item.category || '').toLowerCase();
  });
  var candidates = [];
  if (text.indexOf('pneumonia') >= 0 || (text.indexOf('respiratory') >= 0 && text.indexOf('inhalation') >= 0)) {
    candidates.push('194', '193', '192');
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
  if (candidates.length === 0 && (text.indexOf('inhalation') >= 0 || text.indexOf('nebuliz') >= 0 || text.indexOf('chest physio') >= 0)) {
    candidates.push('194', '193', '192');
  }
  if (candidates.length === 0) {
    candidates.push('194');
  }
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

// ── Prompts ──────────────────────────────────────────────────
var EXTRACT_PROMPT = 'You are a medical bill data extractor. Extract every charge from this bill into structured JSON.\n\nRules:\n- Include EVERY line item on the bill, even $0.00 items\n- Preserve the exact code shown on the bill (including leading zeros like 036600)\n- Use the exact dollar amounts shown on the bill\n- Your total_billed MUST equal the bill\'s stated total. Look for "Total Amount for Hospital Services", "Total Charges", "Amount You Owe", "Total", or similar\n- If the bill shows subtotals by category, make sure all items from every category are included\n- Count line items carefully. If a service appears multiple times on different dates, each is a separate line item\n- Identify bill type: look for the words "INPATIENT" or "OUTPATIENT" printed on the bill\n- For drugs with code 00000, set code to "" and include the drug name in description\n- Include adjustments/discounts if shown on the bill\n\nReturn ONLY valid JSON, no markdown, no explanation:\n{\n  "hospital": "hospital name",\n  "state": "2-letter state code",\n  "city": "city name",\n  "date_of_service": "date or date range",\n  "bill_type_text": "exact text from bill describing patient type, e.g. INPATIENT SERVICES",\n  "line_items": [\n    {"code": "036600", "description": "ARTERIAL PUNCTURE", "quantity": 1, "billed": 372.28, "date": "10/10/22", "category": "LABORATORY"}\n  ],\n  "adjustments": 0,\n  "total_before_adjustments": 0,\n  "total_billed": 0\n}\n\nCRITICAL: Count all line items from ALL pages and ALL categories. The sum of all line item billed amounts should approximately equal total_before_adjustments. Missing line items is the worst error you can make.\n\nMULTI-PAGE BILLS: Hospital bills often span 3-5 pages with categories like:\n- Room and Care (rev code 0110)\n- Laboratory (rev codes 0300-0319)\n- Lab-Chemistry (rev code 0301)\n- Lab-Hematology (rev code 0305)\n- Radiology/Diagnostic (rev codes 0320-0329)\n- Respiratory/Respiratory SVC (rev codes 0410-0419)\n- Drugs/Pharmacy (rev codes 0250-0259, 0636-0637)\n- EKG/EEG (rev codes 0730-0739)\n- Other/Convenience items (rev code 0999)\nYou MUST scan every page and capture items from every category.';

var REPORT_PROMPT = 'You are BillXM AI, a medical billing analyst.\n\nYou will receive pre-analyzed medical bill data. Each line item already has its government fair rate looked up. The bill type (INPATIENT or OUTPATIENT) is already determined. If inpatient, a DRG benchmark is provided.\n\nYour job is to write the analysis report. The data work is done. You focus on:\n1. Writing a clear, patient-friendly summary with specific dollar examples\n2. Identifying issues (overcharges, duplicates, suspicious patterns)\n3. Assigning a grade based on the overcharge data provided\n4. Providing actionable next steps\n\nGRADING (based on potential_savings / total_billed):\n- A = savings < 10% of billed (reasonable bill)\n- B = savings 10-25%\n- C = savings 25-50%\n- D = savings 50-75%\n- F = savings >75% OR definitive coding violations\n\nISSUES - only flag items where billed significantly exceeds fair rate:\n- EXCESSIVE_MARKUP: billed > 2x fair rate. Severity: HIGH if >300%, MEDIUM if 150-300%, LOW if 100-150%\n- DUPLICATE: same code on same date without justification\n- Do NOT flag NO_CPT items or items without fair rates\n\nReturn ONLY valid JSON. No markdown, no backticks:\n{\n  "grade": "A-F",\n  "grade_rationale": "one sentence",\n  "summary": "2-3 sentences in plain English with specific dollar examples of overcharges",\n  "issues": [\n    {\n      "type": "EXCESSIVE_MARKUP|DUPLICATE|UPCODED|UNBUNDLED",\n      "severity": "HIGH|MEDIUM|LOW",\n      "confidence": 95,\n      "code": "CPT code",\n      "description": "plain English explanation",\n      "billed": 0,\n      "fair_value": 0,\n      "savings": 0,\n      "cms_rule": "fee schedule citation",\n      "dispute_basis": "grounds for dispute"\n    }\n  ],\n  "next_steps": ["actionable step"],\n  "nsa_eligible": false,\n  "financial_assistance_note": "guidance if applicable",\n  "insurance_notes": "info if relevant",\n  "appeal_recommended": false\n}\n\nCRITICAL: Use the total_billed, estimated_fair_value, and potential_savings exactly as provided. Do not recalculate them.\nWrite in plain English a patient can understand.';

var GRADE_PROMPT = 'You are BillXM AI. Quickly assess this medical bill data and return a grade.\n\nGrade based on the overcharge percentage provided:\n- A = overcharge < 10%\n- B = overcharge 10-25%\n- C = overcharge 25-50%\n- D = overcharge 50-75%\n- F = overcharge >75% or billing violations\n\nIf potential_savings is $0, grade MUST be A.\n\nReturn ONLY valid JSON:\n{"grade":"A-F","grade_rationale":"one sentence","summary":"2 sentences for patient","total_billed":0,"estimated_fair_value":0,"potential_savings":0,"issue_count":0,"high_count":0,"medium_count":0,"low_count":0}';

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

  if (!tier) return res.status(400).json({ error: 'Missing tier' });
  if (!messages && tier !== 'merge') return res.status(400).json({ error: 'Missing messages' });

  // Handle merge requests — skip extraction, go straight to enrichment + report
  if (tier === 'merge' && body.mergeData) {
    // Fall through to the main try block but skip Step 1
  }

  // Normalize messages to ensure valid Anthropic API format
  if (!Array.isArray(messages)) {
    messages = [{ role: 'user', content: String(messages) }];
  }
  messages = messages.map(function(msg) {
    if (!msg.role) msg.role = 'user';
    if (msg.content === undefined || msg.content === null) msg.content = '';
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      msg.content = JSON.stringify(msg.content);
    }
    return msg;
  });

  try {
    loadCMSData();
    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ════════════════════════════════════════════════════════════
    // STEP 1: Extract structured data with Haiku (or use merge data)
    // ════════════════════════════════════════════════════════════
    var extracted;
    var extractedTotal;

    if (tier === 'merge' && body.mergeData) {
      // Skip Haiku — use pre-extracted data from chunking
      console.log('Step 1: Using merge data (' + (body.mergeData.line_items || []).length + ' items)');
      extracted = {
        hospital: body.mergeData.hospital || '',
        state: body.mergeData.state || '',
        city: body.mergeData.city || '',
        date_of_service: body.mergeData.date_of_service || '',
        bill_type_text: body.mergeData.bill_type_text || '',
        line_items: body.mergeData.line_items || [],
        total_billed: 0,
      };
      (extracted.line_items).forEach(function(item) { extracted.total_billed += (item.billed || 0); });
      extractedTotal = extracted.total_billed;
    } else {
      // Normal path — extract with Haiku
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
        throw new Error(apiErr.status + ' ' + JSON.stringify(apiErr.error || apiErr.message));
      }

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

      extractedTotal = extracted.total_billed || 0;
    }

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
    // STEP 2: JavaScript enrichment — normalize codes, look up rates
    // ════════════════════════════════════════════════════════════
    console.log('Step 2: Looking up CMS rates...');
    var state = extracted.state || '';
    var city = extracted.city || '';
    var billType = detectBillType(extracted);
    console.log('Bill type: ' + billType);

    var totalBilled = extractedTotal;
    var totalFairCPT = 0;
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

    // ── Determine fair value based on bill type ──
    var estimatedFairValue = 0;
    var drgEstimate = null;
    var apcEstimate = null;

    if (billType === 'INPATIENT') {
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
        console.log('DRG ' + drg.code + ': $' + drg.payment.toFixed(2) + ' (billed $' + totalBilled.toFixed(2) + ' = ' + drgMarkup + 'x)');
      } else {
        estimatedFairValue = totalFairCPT;
        console.log('No DRG match, using CPT sum: $' + totalFairCPT.toFixed(2));
      }
    } else {
      estimatedFairValue = totalFairCPT;
      if (CMS_APC && CMS_APC.apcs) {
        var hasER = enrichedItems.some(function(item) {
          return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0;
        });
        if (hasER) {
          var erLevel = enrichedItems.find(function(item) {
            return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0;
          });
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

    report.bill_type = billType;
    report.total_billed = totalBilled;
    report.estimated_fair_value = estimatedFairValue;
    report.potential_savings = potentialSavings;
    report.hospital = extracted.hospital || report.hospital;
    report.state = state || report.state;
    report.city = city || report.city;
    report.date_of_service = extracted.date_of_service || report.date_of_service;
    if (drgEstimate) report.drg_estimate = drgEstimate;
    if (apcEstimate) report.apc_estimate = apcEstimate;

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
