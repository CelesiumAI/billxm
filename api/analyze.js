const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Load CMS data once at startup ────────────────────────────
var CMS_RVUS = null;
var CMS_GPCI = null;
var CMS_DRG = null;
var CMS_APC = null;
var CMS_JCODES = null; // ── CHANGE 1: J-code drug pricing database

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
  // ── CHANGE 1: Load J-code drug pricing ──
  try {
    CMS_JCODES = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'cms_jcodes.json'), 'utf8'));
    console.log('Loaded J-code database: ' + Object.keys(CMS_JCODES.drugs || {}).length + ' drugs');
  } catch (e) { console.log('No J-code data, continuing without it'); }
}

// ── Normalize a code from a hospital bill ────────────────────
function normalizeCode(code) {
  if (!code) return '';
  var c = code.toString().trim().toUpperCase();
  if (/^0+$/.test(c)) return '';
  if (c.length === 6 && c[0] === '0' && /^\d+$/.test(c)) c = c.slice(1);
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
  // ── CHANGE 2: J-code drug pricing fallback ──
  if (CMS_JCODES && CMS_JCODES.drugs && CMS_JCODES.drugs[code]) {
    var jdrug = CMS_JCODES.drugs[code];
    if (jdrug.r !== null) {
      return { rate: jdrug.r, desc: jdrug.d, dose: jdrug.dose, type: 'drug' };
    }
  }
  if (CMS_RVUS.rvus && CMS_RVUS.rvus[code]) {
    var rvu = CMS_RVUS.rvus[code];
    var gpci = getGPCI(state, city);
    var CF = CMS_RVUS.conversion_factor || 33.4009;
    var rate = Math.round(((rvu.w * gpci.work) + (rvu.p * gpci.pe) + (rvu.m * gpci.mp)) * CF * 100) / 100;
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
  if (dos.indexOf('-') >= 0 || dos.indexOf('to') >= 0 || dos.indexOf('thru') >= 0) return 'INPATIENT';
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
  // Medical DRGs -- only match on actual diagnosis keywords
  if (text.indexOf('pneumonia') >= 0) candidates.push('194', '193', '192');
  if (text.indexOf('heart failure') >= 0) candidates.push('293', '292', '291');
  if (text.indexOf('sepsis') >= 0 || text.indexOf('septicemia') >= 0) candidates.push('872', '871');
  if (text.indexOf('chest pain') >= 0) candidates.push('313');
  if (text.indexOf('copd') >= 0 || text.indexOf('obstructive pulmonary') >= 0 || text.indexOf('bronchitis') >= 0 || text.indexOf('asthma') >= 0) candidates.push('203', '202');
  if (text.indexOf('stroke') >= 0 || text.indexOf('cerebrovascular') >= 0) candidates.push('065', '064');
  if (text.indexOf('hip replacement') >= 0 || text.indexOf('hip arthroplasty') >= 0) candidates.push('470');
  if (text.indexOf('knee replacement') >= 0 || text.indexOf('knee arthroplasty') >= 0) candidates.push('470');
  if (text.indexOf('appendectomy') >= 0 || text.indexOf('appendicitis') >= 0) candidates.push('343', '342');
  if (text.indexOf('cholecystectomy') >= 0 || text.indexOf('gallbladder') >= 0) candidates.push('418', '419');
  if (text.indexOf('cesarean') >= 0 || text.indexOf('c-section') >= 0) candidates.push('788', '787', '786');
  if (text.indexOf('vaginal delivery') >= 0 || text.indexOf('childbirth') >= 0) candidates.push('775', '774');
  if (text.indexOf('kidney') >= 0 && text.indexOf('failure') >= 0) candidates.push('684', '683', '682');
  if (text.indexOf('diabetes') >= 0) candidates.push('640', '639', '638');
  if (text.indexOf('urinary tract infection') >= 0 || text.indexOf('uti') >= 0) candidates.push('690', '689');

  // If no diagnosis match found, do NOT default to pneumonia.
  // Instead, detect if it's a surgical or medical admission from department clues.
  if (candidates.length === 0) {
    var hasSurgical = text.indexOf('or services') >= 0 || text.indexOf('operating room') >= 0 ||
      text.indexOf('surgery') >= 0 || text.indexOf('anesthesia') >= 0 || text.indexOf('recovery room') >= 0;
    // Return null with context about admission type -- no guessing diagnosis
    return {
      code: 'UNKNOWN',
      desc: hasSurgical ? 'Surgical admission (specific procedure unknown -- request itemized bill)' : 'Medical admission (specific diagnosis unknown -- request itemized bill)',
      payment: 0,
      los: 0,
      admission_type: hasSurgical ? 'SURGICAL' : 'MEDICAL'
    };
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

// ── CHANGE 4a: Detect summary bill (no CPT codes) ───────────
function detectSummaryBill(extracted, enrichedItems) {
  if (!extracted.line_items || extracted.line_items.length === 0) return false;
  var totalBilled = extracted.total_billed || 0;
  if (totalBilled < 500) return false;

  // Count items that have a valid CPT/HCPCS code matched to a CMS rate
  var matchedCount = 0;
  var totalItems = enrichedItems.length;
  enrichedItems.forEach(function(item) {
    if (item.fair_rate !== null && item.code) matchedCount++;
  });

  // Summary bill = zero or near-zero code matches on a substantial bill
  // Also check if descriptions look like department categories
  var deptKeywords = [
    // Room & board
    'room and', 'room &', 'bed semi', 'bed priv', 'room-priv', 'room-semi',
    'medical-sur', 'med-sur', 'room and care', 'room and board',
    // Pharmacy & drugs
    'pharmacy', 'drugs req', 'drug charge', 'single source drug',
    // Supplies
    'supplies', 'sterile supply', 'med-sur supplies',
    // Lab departments
    'laboratory', 'chemistry', 'hematology', 'bacteriology', 'microbiology',
    'urology', 'pathology', 'pathology lab', 'lab-',
    // Imaging
    'radiology', 'ct scan', 'mri', 'ultrasound', 'diagnostic-general',
    // Cardio/Pulmonary
    'cardiology', 'pulmonary', 'respiratory', 'ekg', 'ecg', 'eeg',
    'pulmonary function',
    // Surgical
    'or services', 'operating room', 'surgery services', 'recovery room',
    'anesthesia',
    // Emergency
    'emergency room', 'emergency care', 'emerg room',
    // ICU
    'intensive care', 'intermediate care', 'icu',
    // Therapy
    'therapy services', 'physical therapy', 'occupational therapy',
    'respiratory therapy', 'behavioral health', 'rehabilitation',
    'other therapeutic',
    // Other common departments
    'blood', 'special services', 'audiology', 'iv therapy', 'miscellaneous',
    'medical/surgical', 'professional or physician', 'professional fee',
    'extension of', 'room and bed'
  ];
  var deptMatchCount = 0;
  (extracted.line_items || []).forEach(function(item) {
    var desc = (item.description || '').toLowerCase();
    for (var i = 0; i < deptKeywords.length; i++) {
      if (desc.indexOf(deptKeywords[i]) >= 0) { deptMatchCount++; break; }
    }
  });

  // It's a summary bill if: very few CPT matches AND most items look like departments
  var matchRate = totalItems > 0 ? matchedCount / totalItems : 0;
  var deptRate = totalItems > 0 ? deptMatchCount / totalItems : 0;

  // Also check fair value coverage: if matched fair values cover less than 5% of total billed,
  // it's effectively a summary bill even if CPT mapping matched a couple of therapy codes
  var totalFairValue = 0;
  enrichedItems.forEach(function(item) {
    if (item.total_fair) totalFairValue += item.total_fair;
  });
  var fairCoverage = totalBilled > 0 ? totalFairValue / totalBilled : 0;

  if (matchRate < 0.15 && deptRate > 0.4) return true;
  if (fairCoverage < 0.05 && deptRate > 0.4 && totalBilled > 1000) return true;
  return false;
}

// ── CHANGE 4b: Build summary bill response ──────────────────
function buildSummaryBillResponse(extracted, enrichedItems, billType, totalBilled, drgEstimate) {
  var hospital = (extracted.hospital || 'the hospital').trim();
  var state = (extracted.state || '').trim();
  var dos = (extracted.date_of_service || '').trim();

  // Identify department breakdown
  var departments = enrichedItems.map(function(item) {
    return { description: item.description, billed: item.billed };
  }).filter(function(d) { return d.billed > 0; })
  .sort(function(a, b) { return b.billed - a.billed; });

  // Estimate stay length from Room and Care charges
  var roomCharge = 0;
  departments.forEach(function(d) {
    var desc = d.description.toLowerCase();
    if (desc.indexOf('room') >= 0 || desc.indexOf('care') >= 0 || desc.indexOf('bed') >= 0) {
      roomCharge += d.billed;
    }
  });
  var estimatedDays = roomCharge > 0 ? Math.round(roomCharge / 3500) : null;

  // Flag disproportionate departments
  var flags = [];
  departments.forEach(function(d) {
    var pct = totalBilled > 0 ? Math.round(d.billed / totalBilled * 100) : 0;
    var desc = d.description.toLowerCase();
    if (desc.indexOf('pharmacy') >= 0 && pct > 20) {
      flags.push({ department: d.description, amount: d.billed, pct: pct, note: 'Pharmacy charges represent ' + pct + '% of total bill -- unusually high. May include markup on individual drugs.' });
    }
    if (desc.indexOf('respiratory') >= 0 && pct > 15) {
      flags.push({ department: d.description, amount: d.billed, pct: pct, note: 'Respiratory therapy charges represent ' + pct + '% of total bill -- warrants line-item review.' });
    }
    if ((desc.indexOf('supply') >= 0 || desc.indexOf('surgical') >= 0) && pct > 25) {
      flags.push({ department: d.description, amount: d.billed, pct: pct, note: 'Supply/surgical charges at ' + pct + '% is unusually high. Hospitals commonly mark up supplies 5-10x cost.' });
    }
  });

  // DRG context for inpatient
  var drgContext = '';
  if (billType === 'INPATIENT' && drgEstimate) {
    if (drgEstimate.code !== 'UNKNOWN' && drgEstimate.payment > 0) {
      var multiplier = totalBilled > 0 ? (totalBilled / drgEstimate.payment).toFixed(1) : 'N/A';
      drgContext = 'Based on available information, the estimated Medicare DRG payment for this type of admission would be approximately $' +
        drgEstimate.payment.toLocaleString() + ' (DRG ' + drgEstimate.code + '). Your bill of $' +
        totalBilled.toLocaleString() + ' is approximately ' + multiplier + 'x the Medicare benchmark.';
    } else {
      drgContext = 'This appears to be a ' + (drgEstimate.desc || 'hospital admission') +
        '. Without an itemized bill, we cannot determine the exact DRG classification or Medicare benchmark. ' +
        'The itemized bill with procedure codes will allow us to identify the correct DRG and calculate your fair value.';
    }
  }

  // Build summary text
  var summaryParts = ['This is a summary bill showing $' + totalBilled.toLocaleString() + ' in total charges across ' + departments.length + ' service departments.'];
  if (estimatedDays) summaryParts.push('The room charges suggest an estimated ' + estimatedDays + '-day hospital stay.');
  summaryParts.push('This bill does not contain the individual procedure codes (CPT/HCPCS codes) needed for a full line-by-line analysis.');
  if (drgContext) summaryParts.push(drgContext);
  summaryParts.push('To unlock your complete BillXM overcharge analysis, request an itemized bill from ' + hospital + ' using the phone script and letter below.');

  // Phone script
  var phoneScript = 'Hello, I am calling about my account' +
    (dos ? ' for services received on ' + dos : '') +
    ' at ' + hospital + '. ' +
    'I am requesting a fully itemized bill that includes CPT and HCPCS procedure codes, revenue codes, dates of service for each item, and individual charges for every service rendered. ' +
    'Under federal regulations including the No Surprises Act and CMS Conditions of Participation for Medicare-certified hospitals, I am entitled to a detailed itemized statement. ' +
    'Please send this to me within 30 business days. ' +
    'Can you confirm this will be mailed to my address on file? ' +
    'If I do not receive it within 30 days, I will follow up in writing and may file a complaint with my state attorney general and the Centers for Medicare & Medicaid Services.';

  // Request letter
  var requestLetter = 'Dear Billing Department,\n\n' +
    'Re: Request for Itemized Bill\n' +
    (dos ? 'Date of Service: ' + dos + '\n' : '') +
    hospital + '\n\n' +
    'I am writing to formally request a fully itemized statement for my account. The summary bill I received shows total charges of $' + totalBilled.toLocaleString() +
    ' but does not include the detail necessary for me to verify accuracy.\n\n' +
    'Specifically, I am requesting a statement that includes:\n' +
    '1. All CPT and HCPCS procedure codes for each service rendered\n' +
    '2. Revenue codes for each department charge\n' +
    '3. Individual dates of service for each line item\n' +
    '4. Individual charges for each procedure, supply, and medication\n' +
    '5. The quantity and unit price for each item\n\n' +
    'Pursuant to federal law, including the No Surprises Act (Public Law 117-169), 42 CFR 180.60, and CMS Conditions of Participation for Medicare-certified hospitals, ' +
    'I am entitled to receive a complete itemized statement. Many states also have specific statutes requiring hospitals to provide itemized bills upon request.\n\n' +
    'Please provide this itemized statement within 30 days. I also request that any collection activity on this account be suspended until I have had the opportunity to review the itemized charges.\n\n' +
    'Thank you for your prompt attention to this matter.\n\n' +
    'Sincerely,\n[Patient Name]\n[Address]\n[Phone Number]\n[Account Number]';

  // Calculate fair value and savings if DRG was matched
  var estimatedFairValue = null;
  var potentialSavings = null;
  if (drgEstimate && drgEstimate.code !== 'UNKNOWN' && drgEstimate.payment > 0) {
    estimatedFairValue = drgEstimate.payment;
    potentialSavings = Math.max(0, Math.round((totalBilled - drgEstimate.payment) * 100) / 100);
  }

  return {
    bill_type: billType,
    report_type: 'SUMMARY_BILL',
    grade: 'PENDING',
    grade_rationale: 'Full analysis requires an itemized bill with procedure codes. Request one using the tools below.',
    summary: summaryParts.join(' '),
    hospital: hospital,
    state: state,
    date_of_service: dos,
    total_billed: totalBilled,
    estimated_fair_value: estimatedFairValue,
    potential_savings: potentialSavings,
    drg_estimate: drgEstimate ? {
      drg_code: drgEstimate.code,
      drg_description: drgEstimate.desc,
      drg_payment: drgEstimate.payment,
      markup_multiplier: (totalBilled > 0 && drgEstimate.payment > 0 ? (totalBilled / drgEstimate.payment).toFixed(1) + 'x' : 'N/A')
    } : null,
    estimated_stay_days: estimatedDays,
    departments: departments,
    department_flags: flags,
    phone_script: phoneScript,
    request_letter: requestLetter,
    next_steps: [
      'Call ' + hospital + ' billing department and request a fully itemized bill with CPT codes using the phone script above',
      'If calling does not work, mail the request letter via certified mail so you have proof of the request',
      'Once you receive the itemized bill, upload it to BillXM for a complete line-by-line overcharge analysis',
      'Do NOT pay this bill or agree to a payment plan until you have reviewed the itemized charges',
      'If the hospital refuses to provide an itemized bill, file a complaint with your state attorney general and CMS'
    ],
    issues: [],
    line_items: enrichedItems.map(function(item) {
      return {
        code: item.code || '', description: item.description, billed: item.billed,
        quantity: item.quantity, fair_rate: null, total_fair: null,
        markup_pct: 'N/A', status: 'SUMMARY',
        note: 'Department-level charge -- itemized bill needed for analysis'
      };
    }),
    nsa_eligible: false,
    financial_assistance_note: hospital + ' may offer financial assistance or charity care programs. Ask the billing department about income-based discounts.',
    insurance_notes: '',
    appeal_recommended: false
  };
}

// ── Record anonymized analytics ──────────────────────────────
async function recordAnalytics(extracted, enrichedItems, billType, totalBilled, estimatedFairValue, potentialSavings, grade, issueCount, drgEstimate) {
  try {
    // Build anonymized record (NO patient data)
    var hospital = (extracted.hospital || '').trim();
    var state = (extracted.state || '').trim();
    var city = (extracted.city || '').trim();
    if (!hospital) return;

    var record = {
      hospital: hospital,
      state: state,
      city: city,
      bill_type: billType,
      drg: drgEstimate ? drgEstimate.code : null,
      total_billed: totalBilled,
      fair_value: estimatedFairValue,
      savings: potentialSavings,
      grade: grade || 'N/A',
      issue_count: issueCount || 0,
      month: new Date().toISOString().slice(0, 7), // 2026-04 (no exact date)
      codes: enrichedItems
        .filter(function(i) { return i.code && i.billed > 0; })
        .map(function(i) {
          return { code: i.code, billed: i.billed, fair: i.total_fair, type: i.type };
        })
    };

    // Store via Upstash KV if available
    if (process.env.KV_REST_API_URL) {
      var Redis = require('@upstash/redis').Redis;
      var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

      // 1. Store individual analysis record
      var analysisKey = 'analysis:' + Date.now();
      await redis.set(analysisKey, JSON.stringify(record), { ex: 365 * 24 * 60 * 60 }); // 1 year

      // 2. Increment global counters
      await redis.incrby('counter:bills_analyzed', 1);
      await redis.incrby('counter:charges_reviewed', Math.round(totalBilled));
      // ── CHANGE 4c: Only increment savings if we actually found savings ──
      if (potentialSavings && potentialSavings > 0) {
        await redis.incrby('counter:savings_found', Math.round(potentialSavings));
      }

      // 3. Store per-hospital, per-code pricing data
      for (var j = 0; j < record.codes.length; j++) {
        var c = record.codes[j];
        if (!c.code || !c.billed) continue;
        var hKey = 'hospital_pricing:' + hospital.replace(/[^a-zA-Z0-9]/g, '_') + ':' + c.code;
        var existing = await redis.get(hKey);
        var pricing;
        if (existing) {
          pricing = typeof existing === 'string' ? JSON.parse(existing) : existing;
          pricing.count += 1;
          pricing.total_billed += c.billed;
          pricing.avg_billed = Math.round(pricing.total_billed / pricing.count * 100) / 100;
          if (c.billed < pricing.min_billed) pricing.min_billed = c.billed;
          if (c.billed > pricing.max_billed) pricing.max_billed = c.billed;
          if (c.fair) pricing.medicare_rate = c.fair;
        } else {
          pricing = {
            hospital: hospital,
            state: state,
            city: city,
            code: c.code,
            count: 1,
            total_billed: c.billed,
            avg_billed: c.billed,
            min_billed: c.billed,
            max_billed: c.billed,
            medicare_rate: c.fair || null,
            type: c.type
          };
        }
        await redis.set(hKey, JSON.stringify(pricing), { ex: 365 * 24 * 60 * 60 });
      }

      console.log('Analytics recorded: ' + hospital + ', $' + totalBilled.toFixed(2));
    }
  } catch (err) {
    console.log('Analytics recording failed (non-fatal):', err.message);
  }
}

// ── Haiku extraction prompt ──────────────────────────────────
// ── CHANGE 3: Fixed to prefer Total Charges over Amount Due ──
var EXTRACT_PROMPT = 'You are a medical bill data extractor. Extract every charge from this bill into structured JSON.\n\n' +
'Rules:\n' +
'- Include EVERY line item on the bill, even $0.00 items\n' +
'- Preserve the exact code shown on the bill (including leading zeros like 036600)\n' +
'- Use the exact dollar amounts shown on the bill\n' +
'- CRITICAL: total_billed MUST be the TOTAL CHARGES, Total Patient Services, or Total Amount for Hospital Services. This is the FULL undiscounted amount BEFORE any payments, adjustments, insurance, or discounts. Do NOT use "Amount Due", "Balance Due", "Patient Balance", "Please Pay Now", or any post-payment amount. These are completely different numbers.\n' +
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
'CRITICAL: Count all line items from ALL pages and ALL categories. Missing line items is the worst error you can make.\n\n' +
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

// ── Sonnet report prompt (no rate tables) ────────────────────
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
'- DRUG_OVERCHARGE: for J-code drugs, flag when billed > 3x the Medicare ASP+6% payment limit\n' +
'- Do NOT flag NO_CPT items or items without fair rates\n\n' +
'Return ONLY valid JSON. No markdown, no backticks:\n' +
'{\n' +
'  "grade": "A-F",\n' +
'  "grade_rationale": "one sentence",\n' +
'  "summary": "2-3 sentences in plain English with specific dollar examples of overcharges",\n' +
'  "issues": [\n' +
'    {\n' +
'      "type": "EXCESSIVE_MARKUP|DUPLICATE|UPCODED|UNBUNDLED|DRUG_OVERCHARGE",\n' +
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
'  "phone_script": "A word-for-word phone script the patient can read when calling the hospital billing department. Include: who to ask for, what to reference, specific dollar amounts to dispute, and how to escalate if they refuse.",\n' +
'  "dispute_letter": "A formal dispute letter the patient can send to the hospital. Include: date, hospital name, account reference, specific overcharges with CMS citations, request for adjustment, deadline for response, and mention of regulatory rights.",\n' +
'  "next_steps": ["actionable step"],\n' +
'  "nsa_eligible": false,\n' +
'  "financial_assistance_note": "guidance if applicable",\n' +
'  "insurance_notes": "info if relevant",\n' +
'  "appeal_recommended": false\n' +
'}\n\n' +
'CRITICAL: Use the total_billed, estimated_fair_value, and potential_savings exactly as provided. Do not recalculate them.\n' +
'If coverage_note is provided, you MUST include it in your summary. Be transparent: tell the patient which charges were benchmarked and which were not. Never imply the entire bill should cost the estimated_fair_value when facility charges like room/board, progressive care, or observation fees are excluded from the benchmark.\n' +
'Write all descriptions in plain English. No unexplained medical jargon.\n' +
'The phone_script should be conversational and ready to read aloud.\n' +
'The dispute_letter should be formal, professional, and ready to print and mail.';

// ── Grade-only prompt for free tier ──────────────────────────
var GRADE_PROMPT = 'You are BillXM AI. Quickly assess this medical bill data and return a grade.\n\n' +
'Grade based on the overcharge percentage provided:\n' +
'- A = overcharge < 10%\n' +
'- B = overcharge 10-25%\n' +
'- C = overcharge 25-50%\n' +
'- D = overcharge 50-75%\n' +
'- F = overcharge >75% or billing violations\n\n' +
'If potential_savings is $0, grade MUST be A.\n' +
'If unmapped_charges is high (over 50% of total), note in the summary that the grade only reflects benchmarked services and facility charges like room/board were not included in the comparison.\n\n' +
'Return ONLY valid JSON:\n' +
'{"grade":"A-F","grade_rationale":"one sentence","summary":"2 sentences for patient",' +
'"total_billed":0,"estimated_fair_value":0,"potential_savings":0,' +
'"issue_count":0,"high_count":0,"medium_count":0,"low_count":0}';

// ── CPT mapping prompt for unknown codes ─────────────────────
var CPT_MAP_PROMPT = 'You are a medical coding expert. Map each service description to its standard CPT or HCPCS code.\n\n' +
'Return ONLY valid JSON, no markdown:\n' +
'{"mappings": [{"description": "original description", "cpt": "5-digit CPT code", "confidence": "HIGH|MEDIUM|LOW"}]}\n\n' +
'Rules:\n' +
'- Only map if you are confident in the CPT code\n' +
'- If unsure, set cpt to "" and confidence to "LOW"\n' +
'- IGNORE prefixes like "HC " (Hospital Charge) -- focus on the service name\n' +
'- For room/board, progressive care, observation hours, facility fees: set cpt to "" (these are facility charges)\n' +
'- For drugs and IV solutions (SODIUM CHLORIDE, MAGNESIUM SULFATE, INSULIN, DEXTROSE, POTASSIUM CHLORIDE, ONDANSETRON, METOCLOPRAMIDE): map to J-codes if known, otherwise set cpt to ""\n' +
'- Common mappings:\n' +
'  EKG/ECG = 93005, EKG 12 LEAD = 93000, CT HEAD W/O CONTRAST = 70450,\n' +
'  CBC/CBS WITH AUTO DIFF = 85025, CBC = 85027,\n' +
'  BASIC METABOLIC PANEL = 80048, COMP METABOLIC PANEL/COMPREHENSIVE METABOLIC = 80053,\n' +
'  ED CARE LEVEL 4/ED LEVEL IV = 99284, ED CARE LEVEL 5/ED LEVEL V = 99285,\n' +
'  ED CARE LEVEL 3/ED LEVEL III = 99283,\n' +
'  CHEST X-RAY/X-RAY EXAM CHEST 1 VIEW = 71045, CHEST X-RAY 2 VIEW = 71046,\n' +
'  IV INFUSION HYDRATION/HYDRATION 1ST HR = 96360, HYDRATION ADDL HOUR = 96361,\n' +
'  IV PUSH/IVP INJECT = 96374, IV PUSH EA ADDL DRUG = 96375,\n' +
'  BLOOD GAS/ABG = 82803, BLOOD GAS ISTAT = 82803,\n' +
'  BLOOD CULTURE = 87040, LACTIC ACID = 83605,\n' +
'  URINALYSIS = 81003, URINALYSIS BIOCHEMICAL = 81003,\n' +
'  PROFILE LIVER/HEPATIC PANEL = 80076, LIPID PANEL = 80061,\n' +
'  COVID/FLU/RSV PANEL = 87635, B-HYDROXYBUTYRATE = 82010,\n' +
'  THYROID STIMULATING HORMONE = 84443, HCG QUAL = 81025,\n' +
'  MAGNESIUM LEVEL = 83735, AMNIO PH = 83986\n' +
'- Drug J-code mappings:\n' +
'  ONDANSETRON = J2405, METOCLOPRAMIDE = J2765, INSULIN GLARGINE = J1815,\n' +
'  POTASSIUM CHLORIDE = J3480, MAGNESIUM SULFATE = J3475\n';

// ── Cached demo report ───────────────────────────────────────
var CACHED_DEMO_REPORT = {
  bill_type: 'INPATIENT',
  grade: 'C',
  grade_rationale: 'The bill is approximately 46% above Medicare fair value, with multiple services priced well above government rates.',
  summary: 'This 2-day pneumonia hospitalization bill from Jackson Purchase Medical Center is overcharging you by $4,709 (46% of the total). The most egregious overcharges include an arterial puncture billed at $372 when the fair rate is $13, lab tests marked up by over 2,500% (like a basic blood count billed at $221 versus a fair rate of $8), and an EKG charged at $288 when it should cost $6. Your DRG-based fair payment for this pneumonia treatment should be $5,442, not the $10,151 being charged.',
  hospital: 'JACKSON PURCHASE MED CTR',
  state: 'TN',
  city: 'NASHVILLE',
  date_of_service: '10/11/2022-10/12/2022',
  total_billed: 10150.87,
  estimated_fair_value: 5441.93,
  potential_savings: 4708.94,
  drg_estimate: { drg_code: '194', drg_description: 'SIMPLE PNEUMONIA AND PLEURISY WITH CC', drg_payment: 5441.93, markup_multiplier: '1.9x' },
  apc_estimate: null,
  issues: [
    { type: 'EXCESSIVE_MARKUP', severity: 'HIGH', confidence: 95, code: '36600', description: 'Arterial puncture (blood draw from artery) billed at $372.28 when Medicare pays only $13.26.', billed: 372.28, fair_value: 13.26, savings: 359.02, cms_rule: 'CMS Physician Fee Schedule 2026, CPT 36600', dispute_basis: 'Charge exceeds Medicare allowable rate by over 27x' },
    { type: 'EXCESSIVE_MARKUP', severity: 'HIGH', confidence: 95, code: '85025', description: 'Basic blood count (CBC) billed at $220.95 per test when Medicare pays approximately $8.07.', billed: 441.90, fair_value: 16.14, savings: 425.76, cms_rule: 'CMS Clinical Lab Fee Schedule 2026, CPT 85025', dispute_basis: 'Charge exceeds Medicare clinical lab fee schedule rate by over 27x' },
    { type: 'EXCESSIVE_MARKUP', severity: 'HIGH', confidence: 95, code: '93005', description: 'EKG (heart rhythm test) billed at $287.68 when Medicare pays only $6.38.', billed: 287.68, fair_value: 6.38, savings: 281.30, cms_rule: 'CMS Physician Fee Schedule 2026, CPT 93005', dispute_basis: 'Charge exceeds Medicare allowable rate by over 45x' },
    { type: 'EXCESSIVE_MARKUP', severity: 'HIGH', confidence: 92, code: '80048', description: 'Basic metabolic panel (blood chemistry) billed at $286.15 when Medicare pays approximately $8.46.', billed: 286.15, fair_value: 8.46, savings: 277.69, cms_rule: 'CMS Clinical Lab Fee Schedule 2026, CPT 80048', dispute_basis: 'Charge exceeds Medicare clinical lab fee schedule rate by over 33x' }
  ],
  line_items: [
    { code: '', description: 'Room and Care', billed: 1545.34, quantity: 1, fair_rate: null, total_fair: null, markup_pct: 'N/A', status: 'NO_CPT', note: 'Facility charge, covered by DRG' },
    { code: '36600', description: 'Arterial Puncture', billed: 372.28, quantity: 1, fair_rate: 13.26, total_fair: 13.26, markup_pct: '2709%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '36415', description: 'Venipuncture', billed: 69.03, quantity: 1, fair_rate: 3.44, total_fair: 3.44, markup_pct: '1906%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '36415', description: 'Venipuncture', billed: 69.03, quantity: 1, fair_rate: 3.44, total_fair: 3.44, markup_pct: '1906%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '82805', description: 'ABG with Meas O2 Sat', billed: 270.31, quantity: 1, fair_rate: 16.17, total_fair: 16.17, markup_pct: '1572%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '80053', description: 'Comp Metabolic Panel', billed: 434.60, quantity: 1, fair_rate: 10.56, total_fair: 10.56, markup_pct: '4015%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '80048', description: 'Basic Metabolic Panel', billed: 286.15, quantity: 1, fair_rate: 8.46, total_fair: 8.46, markup_pct: '3282%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '85025', description: 'CBC Auto Diff', billed: 220.95, quantity: 1, fair_rate: 8.07, total_fair: 8.07, markup_pct: '2639%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '85025', description: 'CBC Auto Diff', billed: 220.95, quantity: 1, fair_rate: 8.07, total_fair: 8.07, markup_pct: '2639%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '71045', description: 'XR Chest Sgl View', billed: 256.78, quantity: 1, fair_rate: 20.41, total_fair: 20.41, markup_pct: '1158%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '94640', description: 'Inhalation TX', billed: 132.78, quantity: 1, fair_rate: 11.54, total_fair: 11.54, markup_pct: '1051%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '94640', description: 'Hand Held Neb SubQ', billed: 116.55, quantity: 1, fair_rate: 11.54, total_fair: 11.54, markup_pct: '910%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '94668', description: 'Chest Physio SubsQ', billed: 49.68, quantity: 5, fair_rate: 7.65, total_fair: 38.25, markup_pct: '549%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '94640', description: 'MDI SubQ', billed: 116.55, quantity: 1, fair_rate: 11.54, total_fair: 11.54, markup_pct: '910%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '94640', description: 'Hand Held Neb SubQ', billed: 233.10, quantity: 2, fair_rate: 11.54, total_fair: 23.08, markup_pct: '910%', status: 'FLAG', note: 'Exceeds Medicare rate' },
    { code: '', description: 'Albuterol 8.5GM INH', billed: 119.86, quantity: 1, fair_rate: null, total_fair: null, markup_pct: 'N/A', status: 'NO_CPT', note: 'Drug charge' },
    { code: '', description: 'Pot Cl 20MEQ SRT', billed: 6.73, quantity: 2, fair_rate: null, total_fair: null, markup_pct: 'N/A', status: 'NO_CPT', note: 'Drug charge' },
    { code: '', description: 'Fluticasone/Vilant 200/25', billed: 779.93, quantity: 1, fair_rate: null, total_fair: null, markup_pct: 'N/A', status: 'NO_CPT', note: 'Drug charge' },
    { code: '93005', description: 'EKG', billed: 287.68, quantity: 1, fair_rate: 6.38, total_fair: 6.38, markup_pct: '4408%', status: 'FLAG', note: 'Exceeds Medicare rate' }
  ],
  phone_script: 'Hello, I\'m calling about my account for services received on October 11-12, 2022 at Jackson Purchase Medical Center. I\'ve had my bill independently reviewed against U.S. government Medicare rates, and I\'ve found several charges that significantly exceed fair market value. For example, the arterial puncture was billed at $372 when the Medicare rate is only $13, and my basic blood count was charged at $221 when Medicare pays about $8. Overall, my bill of $10,151 is nearly double the Medicare benchmark of $5,442 for this type of pneumonia hospitalization. I\'d like to speak with a billing supervisor about adjusting these charges to a more reasonable level. If we can\'t resolve this, I\'ll need to file a formal written dispute and may contact the Tennessee Department of Health regarding these pricing practices.',
  dispute_letter: 'Dear Billing Department,\n\nRe: Account for services dated October 11-12, 2022\nJackson Purchase Medical Center\n\nI am writing to formally dispute the charges on my hospital bill totaling $10,150.87. An independent analysis comparing each charge against the U.S. government\'s published Medicare rates (CMS Physician Fee Schedule and Clinical Lab Fee Schedule, 2026) has identified significant overcharges totaling approximately $4,709.\n\nSpecific overcharges include:\n- Arterial Puncture (CPT 36600): Billed $372.28 vs Medicare rate $13.26 (2,709% markup)\n- CBC Auto Diff (CPT 85025): Billed $220.95 each vs Medicare rate $8.07 (2,639% markup)\n- EKG (CPT 93005): Billed $287.68 vs Medicare rate $6.38 (4,408% markup)\n- Basic Metabolic Panel (CPT 80048): Billed $286.15 vs Medicare rate $8.46 (3,282% markup)\n\nThe Medicare DRG benchmark for this type of pneumonia hospitalization (DRG 194) is $5,441.93. My total bill of $10,150.87 represents 1.9x the Medicare payment rate.\n\nI request that you review and adjust these charges to reflect fair market rates. Please respond within 30 days. I reserve the right to file complaints with the Tennessee Department of Health and the Centers for Medicare & Medicaid Services if this matter is not resolved.\n\nSincerely,\n[Patient Name]',
  next_steps: [
    'Request an itemized bill with CPT codes if you have not already',
    'Call the hospital billing department and reference the Medicare rates for each overcharged service',
    'Ask about financial assistance programs and charity care policies',
    'File a formal dispute using the dispute letter provided in this report',
    'Contact your insurance company to verify what they paid versus what you were billed'
  ],
  nsa_eligible: false,
  financial_assistance_note: 'Jackson Purchase Medical Center may offer financial assistance or charity care programs. Ask the billing department about income-based discounts.',
  insurance_notes: 'Insurance paid $1,839.41. Remaining patient balance: $8,311.46. Review your EOB to ensure all covered services were applied correctly.',
  appeal_recommended: true
};

// ── Main handler ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var messages = body.messages;
  var tier = body.tier;

  console.log('=== ANALYZE REQUEST ===');
  console.log('Tier:', tier, 'Demo:', !!body.demo);

  if (!messages || !tier) return res.status(400).json({ error: 'Missing messages or tier' });

  // Normalize messages
  if (!Array.isArray(messages)) messages = [{ role: 'user', content: String(messages) }];
  messages = messages.map(function(msg) {
    if (!msg.role) msg.role = 'user';
    if (msg.content === undefined || msg.content === null) msg.content = '';
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) msg.content = JSON.stringify(msg.content);
    return msg;
  });

  try {
    loadCMSData();

    // ── DEMO: Return cached result with artificial delay ──
    if (body.demo === true) {
      console.log('Demo bill -- returning cached result');
      var delay = 10000 + Math.floor(Math.random() * 5000);
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(CACHED_DEMO_REPORT) }] });
    }

    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ════════════════════════════════════════════════════════════
    // STEP 1: Extract structured data with Haiku
    // ════════════════════════════════════════════════════════════
    console.log('Step 1: Extracting bill data with Haiku...');
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
      throw new Error('Bill extraction failed: ' + (apiErr.message || 'API error'));
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
    (extracted.line_items || []).forEach(function(item) { lineItemSum += (item.billed || 0); });
    var totalDiff = Math.abs(lineItemSum - extractedTotal);
    var totalPct = extractedTotal > 0 ? (totalDiff / extractedTotal) : 0;

    if (totalPct > 0.15 && extractedTotal > 0) {
      console.log('WARNING: Items sum $' + lineItemSum.toFixed(2) + ' vs total $' + extractedTotal.toFixed(2) + ' (' + Math.round(totalPct * 100) + '% gap). Retrying...');
      try {
        var retryResponse = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          system: EXTRACT_PROMPT + '\n\nPREVIOUS ATTEMPT MISSED LINE ITEMS. Bill total is $' + extractedTotal.toFixed(2) + ' but only $' + lineItemSum.toFixed(2) + ' captured. Include ALL items from ALL pages.',
          messages: messages,
        });
        var retryRaw = retryResponse.content.map(function(b) { return b.text || ''; }).join('');
        retryRaw = retryRaw.replace(/```json|```/g, '').trim();
        var rs = retryRaw.indexOf('{');
        var re2 = retryRaw.lastIndexOf('}');
        if (rs !== -1 && re2 !== -1) {
          var retryExtracted = JSON.parse(retryRaw.slice(rs, re2 + 1));
          var retrySum = 0;
          (retryExtracted.line_items || []).forEach(function(item) { retrySum += (item.billed || 0); });
          if (Math.abs(retrySum - (retryExtracted.total_billed || extractedTotal)) < totalDiff) {
            console.log('Retry improved: $' + retrySum.toFixed(2));
            extracted = retryExtracted;
            extractedTotal = extracted.total_billed || extractedTotal;
          }
        }
      } catch (retryErr) { console.log('Retry failed, keeping original'); }
    }

    // ════════════════════════════════════════════════════════════
    // STEP 1b: Net charge/reversal pairs
    // ════════════════════════════════════════════════════════════
    if (extracted.line_items && extracted.line_items.length > 0) {
      var grouped = {};
      extracted.line_items.forEach(function(item) {
        var key = (item.description || '').trim().toUpperCase() + '|' + (item.date || '');
        if (!grouped[key]) grouped[key] = { items: [], netAmount: 0 };
        grouped[key].items.push(item);
        grouped[key].netAmount += (item.billed || 0);
      });
      var hasReversals = false;
      Object.keys(grouped).forEach(function(key) {
        var g = grouped[key];
        if (g.items.length > 1) {
          var hasPos = g.items.some(function(i) { return (i.billed || 0) > 0; });
          var hasNeg = g.items.some(function(i) { return (i.billed || 0) < 0; });
          if (hasPos && hasNeg) hasReversals = true;
        }
      });
      if (hasReversals) {
        console.log('Charge/reversal pairs detected. Netting...');
        var netted = [];
        Object.keys(grouped).forEach(function(key) {
          var g = grouped[key];
          var netAmount = Math.round(g.netAmount * 100) / 100;
          if (Math.abs(netAmount) > 0.01) {
            var rep = JSON.parse(JSON.stringify(g.items[0]));
            rep.billed = netAmount;
            rep.quantity = 1;
            netted.push(rep);
          }
        });
        console.log('Netted: ' + extracted.line_items.length + ' -> ' + netted.length + ' items');
        extracted.line_items = netted;
        if (!extractedTotal || extractedTotal <= 0) {
          var nettedSum = 0;
          netted.forEach(function(item) { nettedSum += (item.billed || 0); });
          extractedTotal = nettedSum;
          extracted.total_billed = nettedSum;
        }
      }
    }

    // ════════════════════════════════════════════════════════════
    // STEP 2: JavaScript enrichment
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
      if (!code) { status = 'NO_CPT'; }
      else if (markupPct !== null && markupPct > 0) {
        if (markupPct > 300) { status = 'FLAG'; highCount++; }
        else if (markupPct > 150) { status = 'FLAG'; medCount++; }
        else if (markupPct > 100) { status = 'FLAG'; lowCount++; }
      }
      return {
        code: code, original_code: item.code || '', description: item.description || '',
        billed: billed, quantity: qty, fair_rate: fairRate, total_fair: totalFairItem,
        markup_pct: markupPct !== null ? markupPct + '%' : 'N/A', savings: savings,
        status: status, type: lookup ? lookup.type : (code ? 'unknown' : 'no_code'),
        date: item.date || '', category: item.category || ''
      };
    });

    // ════════════════════════════════════════════════════════════
    // STEP 2b: CPT mapping fallback for unrecognized codes
    // ════════════════════════════════════════════════════════════
    var unmatchedItems = enrichedItems.filter(function(item) {
      return item.fair_rate === null && item.billed > 0 && item.description.length > 3;
    });
    var unmatchedValue = 0;
    unmatchedItems.forEach(function(item) { unmatchedValue += item.billed; });

    if (unmatchedItems.length >= 2 && unmatchedValue > totalBilled * 0.3) {
      console.log('Step 2b: ' + unmatchedItems.length + ' items unmatched. Mapping descriptions to CPT...');
      try {
        var descriptionsToMap = unmatchedItems.map(function(item) { return item.description; });
        var mapResponse = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: CPT_MAP_PROMPT,
          messages: [{ role: 'user', content: 'Map these: ' + JSON.stringify(descriptionsToMap) }],
        });
        var mapRaw = mapResponse.content.map(function(b) { return b.text || ''; }).join('');
        mapRaw = mapRaw.replace(/```json|```/g, '').trim();
        var ms = mapRaw.indexOf('{');
        var me = mapRaw.lastIndexOf('}');
        if (ms !== -1 && me !== -1) {
          var mapped = JSON.parse(mapRaw.slice(ms, me + 1));
          var mappedCount = 0;
          if (mapped.mappings) {
            mapped.mappings.forEach(function(m) {
              if (!m.cpt || m.cpt.length < 4) return;
              var cptCode = m.cpt.trim().toUpperCase();
              var lookup = getFairRate(cptCode, state, city);
              if (!lookup) return;
              enrichedItems.forEach(function(item) {
                if (item.fair_rate !== null) return;
                var d1 = (item.description || '').toUpperCase();
                var d2 = (m.description || '').toUpperCase();
                if (d1 === d2 || d1.indexOf(d2) >= 0 || d2.indexOf(d1) >= 0) {
                  var qty = item.quantity || 1;
                  item.code = cptCode;
                  item.fair_rate = lookup.rate;
                  item.total_fair = Math.round(lookup.rate * qty * 100) / 100;
                  item.savings = item.billed > item.total_fair ? Math.round((item.billed - item.total_fair) * 100) / 100 : 0;
                  item.markup_pct = item.total_fair > 0 ? Math.round((item.billed / item.total_fair - 1) * 100) + '%' : 'N/A';
                  item.type = lookup.type;
                  item.status = 'OK';
                  totalFairCPT += item.total_fair;
                  var mPct = item.total_fair > 0 ? Math.round((item.billed / item.total_fair - 1) * 100) : 0;
                  if (mPct > 300) { item.status = 'FLAG'; highCount++; }
                  else if (mPct > 150) { item.status = 'FLAG'; medCount++; }
                  else if (mPct > 100) { item.status = 'FLAG'; lowCount++; }
                  mappedCount++;
                }
              });
            });
          }
          console.log('Mapped ' + mappedCount + ' items to CPT codes');
        }
      } catch (mapErr) { console.log('CPT mapping failed (non-fatal):', mapErr.message); }
    }

    // ════════════════════════════════════════════════════════════
    // STEP 2c: Summary bill detection (CHANGE 4)
    // ════════════════════════════════════════════════════════════
    if (detectSummaryBill(extracted, enrichedItems)) {
      console.log('SUMMARY BILL DETECTED -- routing to summary response');
      var summaryDRG = billType === 'INPATIENT' ? estimateDRG(extracted) : null;
      var summaryResult = buildSummaryBillResponse(extracted, enrichedItems, billType, totalBilled, summaryDRG);

      // Record analytics based on whether we found a DRG benchmark
      var hasDRGMatch = summaryDRG && summaryDRG.code !== 'UNKNOWN' && summaryDRG.payment > 0;
      var analyticsCharges = hasDRGMatch ? totalBilled : 0;
      var analyticsFairValue = hasDRGMatch ? summaryDRG.payment : 0;
      var analyticsSavings = hasDRGMatch ? Math.max(0, totalBilled - summaryDRG.payment) : 0;
      recordAnalytics(extracted, enrichedItems, billType, analyticsCharges, analyticsFairValue, analyticsSavings, 'PENDING', 0, summaryDRG);

      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(summaryResult) }] });
    }

    // ── Re-detect bill type after CPT mapping (mapped ER codes now available) ──
    var hasERCode = enrichedItems.some(function(item) { return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0; });
    var hasObservation = enrichedItems.some(function(item) { return (item.description || '').toLowerCase().indexOf('observation') >= 0; });
    if (hasERCode && billType === 'INPATIENT') {
      billType = 'OUTPATIENT';
      console.log('Bill type corrected to OUTPATIENT (ER code found after CPT mapping)');
    }

    // ── Determine fair value based on bill type ──
    var estimatedFairValue = 0;
    var drgEstimate = null;
    var apcEstimate = null;

    if (billType === 'INPATIENT') {
      var drg = estimateDRG(extracted);
      if (drg && drg.code !== 'UNKNOWN' && drg.payment > 0) {
        estimatedFairValue = drg.payment;
        var drgMarkup = totalBilled > 0 && drg.payment > 0 ? (totalBilled / drg.payment).toFixed(1) : '0';
        drgEstimate = { drg_code: drg.code, drg_description: drg.desc, drg_payment: drg.payment, markup_multiplier: drgMarkup + 'x' };
        console.log('DRG ' + drg.code + ': $' + drg.payment.toFixed(2) + ' (' + drgMarkup + 'x)');
        // Mark room/board/facility items as covered by DRG
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0) {
            var desc = (item.description || '').toLowerCase();
            if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('care unit') >= 0 ||
                desc.indexOf('nursing') >= 0 || desc.indexOf('progressive') >= 0 || desc.indexOf('icu') >= 0) {
              item.status = 'DRG_COVERED';
              item.type = 'facility_drg';
            }
          }
        });
      } else {
        estimatedFairValue = totalFairCPT;
      }
    } else {
      estimatedFairValue = totalFairCPT;

      // ER facility fee APC
      var erFeeAdded = false;
      if (CMS_APC && CMS_APC.apcs) {
        var erLevel = enrichedItems.find(function(item) { return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0; });
        if (erLevel) {
          var apcMap = { '99285': '5025', '99284': '5024', '99283': '5023', '99282': '5022', '99281': '5021' };
          var apcCode = apcMap[erLevel.code];
          if (apcCode && CMS_APC.apcs[apcCode]) {
            var apc = CMS_APC.apcs[apcCode];
            var apcPayment = apc.payment || apc.r || 0;
            estimatedFairValue += apcPayment;
            apcEstimate = { apc_description: (apc.desc || apc.d || 'ER facility fee') + ' (APC ' + apcCode + ')', apc_payment: apcPayment };
            erFeeAdded = true;
            console.log('APC ' + apcCode + ' (ER facility): $' + apcPayment.toFixed(2));
          }
        }

        // Observation APC (8011 = comprehensive observation)
        if (hasObservation && CMS_APC.apcs['8011']) {
          var obsApc = CMS_APC.apcs['8011'];
          var obsPayment = obsApc.payment || obsApc.r || 0;
          estimatedFairValue += obsPayment;
          if (apcEstimate) {
            apcEstimate.observation_apc = 'Comprehensive Observation Services (APC 8011)';
            apcEstimate.observation_payment = obsPayment;
            apcEstimate.apc_payment += obsPayment;
          } else {
            apcEstimate = { apc_description: 'Comprehensive Observation Services (APC 8011)', apc_payment: obsPayment, observation_payment: obsPayment };
          }
          console.log('APC 8011 (observation): $' + obsPayment.toFixed(2));
        }
      }

      // Even without CMS_APC data, provide hardcoded APC estimates for common ER levels
      if (!erFeeAdded && hasERCode) {
        // CMS 2026 national APC payment rates (approximate)
        var erCode = enrichedItems.find(function(item) { return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0; });
        if (erCode) {
          var hardcodedAPC = { '99285': 814, '99284': 531, '99283': 330, '99282': 188, '99281': 79 };
          var hcApcPayment = hardcodedAPC[erCode.code] || 531;
          estimatedFairValue += hcApcPayment;
          apcEstimate = { apc_description: 'ER facility fee estimate (ED Level ' + erCode.code.slice(-1) + ')', apc_payment: hcApcPayment };
          erFeeAdded = true;
          console.log('Hardcoded APC (ER facility): $' + hcApcPayment);
        }
      }

      // Hardcoded observation APC if CMS_APC not loaded
      if (hasObservation && !(apcEstimate && apcEstimate.observation_payment)) {
        var hcObsPayment = 2846; // CMS 2026 APC 8011 approximate
        estimatedFairValue += hcObsPayment;
        if (apcEstimate) {
          apcEstimate.observation_apc = 'Comprehensive Observation Services (estimated)';
          apcEstimate.observation_payment = hcObsPayment;
          apcEstimate.apc_payment += hcObsPayment;
        } else {
          apcEstimate = { apc_description: 'Comprehensive Observation Services (estimated)', apc_payment: hcObsPayment, observation_payment: hcObsPayment };
        }
        console.log('Hardcoded APC (observation): $' + hcObsPayment);
      }

      // Mark facility charges as covered by APC (room/board during ER+observation are packaged)
      if (erFeeAdded || hasObservation) {
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0) {
            var desc = (item.description || '').toLowerCase();
            if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('care unit') >= 0 ||
                desc.indexOf('progressive') >= 0 || desc.indexOf('observation') >= 0 || desc.indexOf('nursing') >= 0) {
              item.status = 'APC_COVERED';
              item.type = 'facility_apc';
            }
          }
        });
      }
    }

    var potentialSavings = Math.max(0, Math.round((totalBilled - estimatedFairValue) * 100) / 100);
    var overchargePct = totalBilled > 0 ? Math.round((potentialSavings / totalBilled) * 100) : 0;
    var issueCount = highCount + medCount + lowCount;

    console.log('Summary: Billed $' + totalBilled.toFixed(2) + ', Fair $' + estimatedFairValue.toFixed(2) + ', Savings $' + potentialSavings.toFixed(2) + ' (' + overchargePct + '%)');

    // ════════════════════════════════════════════════════════════
    // STEP 3a: Free grade (Haiku)
    // ════════════════════════════════════════════════════════════
    if (tier === 'grade') {
      console.log('Step 3a: Free grade with Haiku...');
      var gradeInput = {
        bill_type: billType, total_billed: totalBilled, estimated_fair_value: estimatedFairValue,
        potential_savings: potentialSavings, overcharge_pct: overchargePct,
        issue_count: issueCount, high_count: highCount, medium_count: medCount, low_count: lowCount,
        hospital: extracted.hospital || '',
        unmapped_charges: (function() { var u = 0; enrichedItems.forEach(function(i) { if (i.fair_rate === null && i.billed > 0) u += i.billed; }); return u; })(),
        top_overcharges: enrichedItems.filter(function(i) { return i.status === 'FLAG'; }).slice(0, 5)
          .map(function(i) { return i.description + ': billed $' + i.billed + ' vs fair $' + (i.total_fair || 'N/A'); })
      };
      var gradeResponse = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: GRADE_PROMPT,
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

      // Record analytics even for grade-only
      recordAnalytics(extracted, enrichedItems, billType, totalBilled, estimatedFairValue, potentialSavings, grade.grade, issueCount, drgEstimate);

      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(grade) }] });
    }

    // ════════════════════════════════════════════════════════════
    // STEP 3b: Full report (Sonnet)
    // ════════════════════════════════════════════════════════════
    console.log('Step 3b: Generating report with Sonnet...');

    // Calculate unmapped charges (items with no fair rate benchmark)
    var unmappedCharges = 0;
    var unmappedDescriptions = [];
    enrichedItems.forEach(function(item) {
      if (item.fair_rate === null && item.billed > 0) {
        unmappedCharges += item.billed;
        unmappedDescriptions.push(item.description + ': $' + item.billed.toFixed(2));
      }
    });
    var benchmarkedCharges = totalBilled - unmappedCharges;

    var reportInput = {
      bill_type: billType, hospital: extracted.hospital || '', state: state, city: city,
      date_of_service: extracted.date_of_service || '', total_billed: totalBilled,
      estimated_fair_value: estimatedFairValue, potential_savings: potentialSavings,
      overcharge_pct: overchargePct, drg_estimate: drgEstimate, apc_estimate: apcEstimate,
      line_items: enrichedItems,
      issue_counts: { high: highCount, medium: medCount, low: lowCount, total: issueCount },
      unmapped_charges: unmappedCharges,
      benchmarked_charges: benchmarkedCharges,
      unmapped_descriptions: unmappedDescriptions.slice(0, 10),
      coverage_note: unmappedCharges > 0 ? 'IMPORTANT: $' + unmappedCharges.toFixed(2) + ' in charges (' + Math.round(unmappedCharges / totalBilled * 100) + '% of total) could not be benchmarked because they lack CPT codes. These include facility fees like room and board, progressive care, and observation charges. The fair value of $' + estimatedFairValue.toFixed(2) + ' only covers the $' + benchmarkedCharges.toFixed(2) + ' in services that could be benchmarked against CMS rates. The actual total overcharge may be different.' : ''
    };

    var reportResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 8000, system: REPORT_PROMPT,
      messages: [{ role: 'user', content: 'Write the analysis report:\n\n' + JSON.stringify(reportInput, null, 2) }],
    });

    var reportRaw = reportResponse.content.map(function(b) { return b.text || ''; }).join('');
    reportRaw = reportRaw.replace(/```json|```/g, '').trim();
    var rStart = reportRaw.indexOf('{');
    var rEnd = reportRaw.lastIndexOf('}');
    if (rStart === -1 || rEnd === -1) throw new Error('No JSON in report response');
    var report = JSON.parse(reportRaw.slice(rStart, rEnd + 1));

    // ── Enforce calculated values ──
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
        code: item.code, description: item.description, billed: item.billed,
        quantity: item.quantity, fair_rate: item.fair_rate, total_fair: item.total_fair,
        markup_pct: item.markup_pct, status: item.status,
        note: item.type === 'facility_drg' ? 'Facility charge -- covered by DRG benchmark' :
              item.type === 'facility_apc' ? 'Facility charge -- covered by APC benchmark' :
              item.type === 'no_code' ? 'Facility charge, no CPT code' :
              item.type === 'drug' ? 'Drug charge -- Medicare ASP+6% benchmark' :
              item.type === 'unknown' ? 'Code not found in CMS database' :
              item.status === 'FLAG' ? 'Exceeds Medicare rate' : 'Within expected range'
      };
    });

    // Record analytics
    recordAnalytics(extracted, enrichedItems, billType, totalBilled, estimatedFairValue, potentialSavings, report.grade, issueCount, drgEstimate);

    return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(report) }] });

  } catch (err) {
    console.error('analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
