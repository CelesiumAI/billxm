const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Load CMS data once at startup ────────────────────────────
let CMS_RVUS = null;
let CMS_GPCI = null;

function loadCMSData() {
  if (CMS_RVUS && CMS_GPCI) return;
  try {
    const rvuData  = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cms_rvus.json'),  'utf8'));
    const gpciData = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cms_gpci.json'), 'utf8'));
    CMS_RVUS = rvuData;
    CMS_GPCI = gpciData.localities;
  } catch (err) {
    console.error('Failed to load CMS data:', err.message);
  }
}

// ── Look up GPCI for a state/city ────────────────────────────
function getGPCI(state, city) {
  if (!CMS_GPCI || !state) return CMS_RVUS ? CMS_RVUS.national_avg_gpci : { work: 1.02, pe: 1.042, mp: 0.848 };

  const stateUpper = state.toUpperCase().trim();
  const cityUpper  = city ? city.toUpperCase().trim() : '';

  // Find all localities for this state
  const stateLocalities = Object.keys(CMS_GPCI)
    .filter(function(k) { return k.startsWith(stateUpper + '_'); })
    .map(function(k) { return CMS_GPCI[k]; });

  if (stateLocalities.length === 0) return CMS_RVUS.national_avg_gpci;

  // Try to match by city name
  if (cityUpper) {
    for (var i = 0; i < stateLocalities.length; i++) {
      const loc = stateLocalities[i];
      if (loc.name && loc.name.indexOf(cityUpper) >= 0) {
        return { work: loc.work, pe: loc.pe, mp: loc.mp };
      }
    }
  }

  // Fall back to first locality in state (usually statewide)
  const first = stateLocalities[0];
  return { work: first.work, pe: first.pe, mp: first.mp };
}

// ── Calculate fair rate for a CPT code ───────────────────────
function getFairRate(code, state, city) {
  if (!CMS_RVUS) return null;

  const trimmed = (code || '').trim().toUpperCase();

  // Check lab rates first (national, no locality adjustment)
  if (CMS_RVUS.labs && CMS_RVUS.labs[trimmed]) {
    const lab = CMS_RVUS.labs[trimmed];
    return { rate: lab.r, desc: lab.d, type: 'lab' };
  }

  // Check drug codes (J-codes, etc.)
  if (CMS_RVUS.drugs && CMS_RVUS.drugs[trimmed]) {
    const drug = CMS_RVUS.drugs[trimmed];
    return { rate: drug.r, desc: drug.d, dose: drug.dose, type: 'drug' };
  }

  // Check physician RVUs
  if (CMS_RVUS.rvus && CMS_RVUS.rvus[trimmed]) {
    const rvu  = CMS_RVUS.rvus[trimmed];
    const gpci = getGPCI(state, city);
    const CF   = CMS_RVUS.conversion_factor || 33.4009;
    const rate = Math.round(
      ((rvu.w * gpci.work) + (rvu.p * gpci.pe) + (rvu.m * gpci.mp)) * CF * 100
    ) / 100;
    return { rate: rate, desc: rvu.d, type: 'physician', gpci: gpci };
  }

  return null;
}

// ── Haiku prompt: extract codes from bill ────────────────────
const EXTRACT_PROMPT = `You are a medical billing code extractor.
Extract every CPT/HCPCS code and charge from this medical bill.
Return ONLY valid JSON, no markdown, no explanation:
{
  "hospital": "hospital name",
  "state": "2-letter state code e.g. TX",
  "city": "city name",
  "date_of_service": "date or date range",
  "patient_name": "patient name if visible",
  "line_items": [
    {"code": "CPT code", "description": "service description", "quantity": 1, "billed": 0.00}
  ],
  "total_billed": 0.00
}
If a line item has no CPT code, still include it with code as "".
Be precise with dollar amounts.`;

// ── Sonnet prompt: generate full report ──────────────────────
const REPORT_PROMPT = `You are BillXM AI, an expert medical billing analyst.
You have been given a medical bill with pre-calculated government fair rates for each charge.
Your job is to analyze the overcharges and generate a clear consumer report.

For each line item you will receive:
- The CPT code and description
- What the hospital billed
- The U.S. government published fair rate (already calculated from official CMS data)
- The markup percentage

Generate a complete analysis report. Return ONLY valid JSON, no markdown:
{
  "grade": "A-F",
  "grade_rationale": "one sentence",
  "summary": "2-3 friendly sentences a patient can understand",
  "total_billed": 0,
  "estimated_fair_value": 0,
  "potential_savings": 0,
  "issues": [
    {
      "type": "EXCESSIVE_MARKUP|DUPLICATE|UPCODED|UNBUNDLED|UNWARRANTED|WRONG_QUANTITY",
      "severity": "HIGH|MEDIUM|LOW",
      "confidence": 95,
      "code": "CPT code",
      "description": "plain English explanation a patient can understand",
      "billed": 0,
      "fair_value": 0,
      "savings": 0,
      "cms_rule": "rule citation",
      "dispute_basis": "legal grounds for dispute"
    }
  ],
  "line_items": [
    {
      "code": "code",
      "description": "service name",
      "billed": 0,
      "quantity": 1,
      "fair_rate": 0,
      "total_fair": 0,
      "markup_pct": "Xx",
      "status": "OK|FLAG|ERROR|NO_CPT",
      "note": "explanation"
    }
  ],
  "next_steps": ["actionable step for the patient"],
  "nsa_eligible": false,
  "financial_assistance_note": "guidance if applicable",
  "insurance_notes": "insurance info if relevant",
  "appeal_recommended": false
}

Common drug (J-code) reference rates (CMS ASP, per unit):
J1100 Dexamethasone 1mg = $0.11
J2270 Morphine 10mg = $4.45
J0696 Ceftriaxone 250mg = $0.43
J1642 Heparin 10 units = $0.018
J2785 Regadenoson 0.1mg = $2.90
J0881 Darbepoetin 1mcg = $3.07
J0129 Abatacept 10mg = $44.72

Facility charges without CPT codes:
Line items like room and board, OR/recovery room fees, pharmacy charges, and supply charges
typically have no CPT code. These are standard facility charges. List them with status "NO_CPT"
and do NOT flag them as issues. Include them in totals but note that fair rate is not available
for facility-only charges.

Severity guidelines:
HIGH = markup over 300% OR definitive coding violation
MEDIUM = markup 150-300% OR likely error
LOW = markup 100-150% OR suspicious pattern

Only flag items where the billed amount significantly exceeds the fair rate.
Write in plain English a patient can understand.`;

// ── Haiku prompt for free grade only ────────────────────────
const GRADE_PROMPT = `You are a medical billing analyst.
Given this bill analysis data (codes extracted and fair rates calculated), 
assign an overall grade and provide a brief summary.
Return ONLY valid JSON, no markdown:
{
  "grade": "A-F",
  "grade_rationale": "one sentence",
  "summary": "2 sentences max for the patient",
  "total_billed": 0,
  "estimated_fair_value": 0,
  "potential_savings": 0,
  "issue_count": 0,
  "high_count": 0,
  "medium_count": 0,
  "low_count": 0
}
Grade: A=clean, B=minor <10% over, C=moderate 10-20% over, D=significant >20% over, F=severe violations.`;

// ── Main handler ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, tier } = req.body;
  if (!messages || !tier) return res.status(400).json({ error: 'Missing messages or tier' });

  try {
    loadCMSData();
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── STEP 1: Extract CPT codes with Haiku ─────────────────
    console.log('Step 1: Extracting codes with Haiku...');
    const extractResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: EXTRACT_PROMPT,
      messages: messages,
    });

    let extracted;
    try {
      let raw = extractResponse.content.map(function(b) { return b.text || ''; }).join('');
      raw = raw.replace(/```json|```/g, '').trim();
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      extracted = JSON.parse(raw.slice(s, e + 1));
    } catch (err) {
      throw new Error('Failed to parse bill extraction: ' + err.message);
    }

    const state = extracted.state || '';
    const city  = extracted.city  || '';
    console.log('Extracted: ' + (extracted.line_items || []).length + ' line items from ' + city + ', ' + state);

    // ── STEP 2: Look up fair rates from CMS database ──────────
    console.log('Step 2: Looking up CMS rates...');
    let totalFair = 0;
    let totalBilled = 0;
    let highCount = 0, medCount = 0, lowCount = 0;

    const enrichedItems = (extracted.line_items || []).map(function(item) {
      const qty     = item.quantity || 1;
      const billed  = item.billed   || 0;
      const lookup  = item.code ? getFairRate(item.code, state, city) : null;
      const fairRate = lookup ? lookup.rate : null;
      const totalFairItem = fairRate ? Math.round(fairRate * qty * 100) / 100 : null;
      const savings = (fairRate && billed > totalFairItem) ? Math.round((billed - totalFairItem) * 100) / 100 : 0;
      const markupPct = (fairRate && fairRate > 0) ? Math.round((billed / totalFairItem - 1) * 100) : null;

      totalBilled += billed;
      if (totalFairItem) totalFair += totalFairItem;

      // Classify severity
      let status = 'OK';
      if (markupPct !== null) {
        if (markupPct > 300) { status = 'FLAG'; highCount++; }
        else if (markupPct > 150) { status = 'FLAG'; medCount++; }
        else if (markupPct > 100) { status = 'FLAG'; lowCount++; }
      }

      return {
        code: item.code || '',
        description: item.description || '',
        billed: billed,
        quantity: qty,
        fair_rate: fairRate,
        total_fair: totalFairItem,
        markup_pct: markupPct !== null ? markupPct + '%' : 'N/A',
        savings: savings,
        status: status,
        type: lookup ? lookup.type : 'unknown',
      };
    });

    const overallSavings = Math.max(0, Math.round((totalBilled - totalFair) * 100) / 100);
    const issueCount = highCount + medCount + lowCount;

    // ── STEP 3a: Free grade — use Haiku only ─────────────────
    if (tier === 'grade') {
      console.log('Step 3a: Generating free grade with Haiku...');
      const gradeInput = {
        total_billed: totalBilled,
        estimated_fair_value: totalFair,
        potential_savings: overallSavings,
        issue_count: issueCount,
        high_count: highCount,
        medium_count: medCount,
        low_count: lowCount,
        line_item_summary: enrichedItems.map(function(i) {
          return { code: i.code, billed: i.billed, fair_rate: i.fair_rate, markup_pct: i.markup_pct, status: i.status };
        }),
      };

      const gradeResponse = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: GRADE_PROMPT,
        messages: [{ role: 'user', content: 'Grade this bill: ' + JSON.stringify(gradeInput) }],
      });

      let gradeRaw = gradeResponse.content.map(function(b) { return b.text || ''; }).join('');
      gradeRaw = gradeRaw.replace(/```json|```/g, '').trim();
      const gs = gradeRaw.indexOf('{'), ge = gradeRaw.lastIndexOf('}');
      const grade = JSON.parse(gradeRaw.slice(gs, ge + 1));

      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(grade) }] });
    }

    // ── STEP 3b: Full report — use Sonnet ────────────────────
    console.log('Step 3b: Generating full report with Sonnet...');
    const reportInput = {
      hospital: extracted.hospital || '',
      state: state,
      city: city,
      date_of_service: extracted.date_of_service || '',
      total_billed: totalBilled,
      estimated_fair_value: totalFair,
      potential_savings: overallSavings,
      line_items: enrichedItems,
      locality_used: state ? (city + ', ' + state) : 'National Average',
    };

    const reportResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: REPORT_PROMPT,
      messages: [{ role: 'user', content: 'Generate a full billing analysis report for this data: ' + JSON.stringify(reportInput) }],
    });

    let reportRaw = reportResponse.content.map(function(b) { return b.text || ''; }).join('');
    reportRaw = reportRaw.replace(/```json|```/g, '').trim();
    const rs = reportRaw.indexOf('{'), re = reportRaw.lastIndexOf('}');
    const report = JSON.parse(reportRaw.slice(rs, re + 1));

    return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(report) }] });

  } catch (err) {
    console.error('analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
