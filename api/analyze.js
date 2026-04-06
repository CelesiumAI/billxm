const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Load CMS data once at startup ────────────────────────────
var CMS_RVUS = null;
var CMS_GPCI = null;
var CMS_DRG = null;
var CMS_APC = null;
var CMS_JCODES = null;

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
  // "EMERGENCY-IP" means ER admission to inpatient
  if (text.indexOf('emergency-ip') >= 0 || text.indexOf('emergency ip') >= 0) return 'INPATIENT';
  if (text.indexOf('observation') >= 0) return 'OUTPATIENT';

  // Check for ER codes and ER department descriptions
  var hasER = false;
  var hasMultiDayRoom = false;
  var hasERDept = false;
  var roomCount = 0;

  (extracted.line_items || []).forEach(function(item) {
    var c = normalizeCode(item.code);
    if (['99281','99282','99283','99284','99285'].indexOf(c) >= 0) hasER = true;
    var desc = (item.description || '').toLowerCase();
    // Check for ER department-level charges
    if (desc.indexOf('emerg') >= 0 || desc.indexOf('emergency') >= 0 || desc.indexOf('ed care') >= 0 || desc.indexOf('ed visit') >= 0 || desc.indexOf('ed level') >= 0) hasERDept = true;
    // Check for room/board charges (each line = ~1 day)
    if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('bed') >= 0 ||
        desc.indexOf('r&b') >= 0 || desc.indexOf('r & b') >= 0 || desc.indexOf('nursing') >= 0) {
      roomCount++;
      if (roomCount >= 2) hasMultiDayRoom = true;
    }
  });

  // Multi-day date range = likely inpatient
  var dos = extracted.date_of_service || '';
  var hasDateRange = dos.indexOf('-') >= 0 || dos.indexOf('to') >= 0 || dos.indexOf('thru') >= 0;

  // ER-to-inpatient: ER charges + multi-day room OR date range
  if ((hasER || hasERDept) && (hasMultiDayRoom || hasDateRange)) {
    return 'INPATIENT';
  }

  // Pure ER visit (no multi-day stay)
  if (hasER || hasERDept) return 'OUTPATIENT';
  // Pure outpatient with ER text
  if (text.indexOf('outpatient') >= 0 || text.indexOf('emergency') >= 0) return 'OUTPATIENT';
  // Date range without ER = inpatient
  if (hasDateRange) return 'INPATIENT';
  return 'OUTPATIENT';
}

// ── Estimate DRG from services on the bill ───────────────────
function estimateDRG(extracted, patientProcedure) {
  if (!CMS_DRG || !CMS_DRG.drgs) return null;
  var text = '';
  (extracted.line_items || []).forEach(function(item) {
    text += ' ' + (item.description || '').toLowerCase();
    text += ' ' + (item.category || '').toLowerCase();
  });
  var hospitalName = (extracted.hospital || '').toLowerCase();
  var candidates = [];

  // HIGHEST PRIORITY: Patient-provided procedure name
  if (patientProcedure) {
    var proc = patientProcedure.toLowerCase();
    if (proc.indexOf('knee replacement') >= 0 || proc.indexOf('knee arthroplasty') >= 0 || proc.indexOf('total knee') >= 0) candidates.push('470');
    if (proc.indexOf('hip replacement') >= 0 || proc.indexOf('hip arthroplasty') >= 0 || proc.indexOf('total hip') >= 0) candidates.push('470');
    if (proc.indexOf('shoulder replacement') >= 0) candidates.push('470');
    if (proc.indexOf('spinal fusion') >= 0 || proc.indexOf('spine surgery') >= 0 || proc.indexOf('back surgery') >= 0) candidates.push('460', '459');
    if (proc.indexOf('appendectomy') >= 0 || proc.indexOf('appendix') >= 0) candidates.push('343', '342');
    if (proc.indexOf('gallbladder') >= 0 || proc.indexOf('cholecystectomy') >= 0) candidates.push('418', '419');
    if (proc.indexOf('cesarean') >= 0 || proc.indexOf('c-section') >= 0 || proc.indexOf('c section') >= 0) candidates.push('788', '787', '786');
    if (proc.indexOf('vaginal delivery') >= 0 || proc.indexOf('childbirth') >= 0 || proc.indexOf('labor and delivery') >= 0) candidates.push('775', '774');
    if (proc.indexOf('pacemaker') >= 0 || proc.indexOf('defibrillator') >= 0) candidates.push('245', '246');
    if (proc.indexOf('cardiac stent') >= 0 || proc.indexOf('angioplasty') >= 0 || proc.indexOf('heart stent') >= 0) candidates.push('247', '248', '249');
    if (proc.indexOf('coronary bypass') >= 0 || proc.indexOf('cabg') >= 0 || proc.indexOf('heart bypass') >= 0) candidates.push('236', '235', '234');
    if (proc.indexOf('hernia') >= 0) candidates.push('353', '352');
    if (proc.indexOf('hysterectomy') >= 0) candidates.push('743', '742');
    if (proc.indexOf('colectomy') >= 0 || proc.indexOf('colon') >= 0) candidates.push('331', '330', '329');
    if (proc.indexOf('pneumonia') >= 0) candidates.push('194', '193', '192');
    if (proc.indexOf('heart failure') >= 0) candidates.push('293', '292', '291');
    if (proc.indexOf('sepsis') >= 0) candidates.push('872', '871');
    // CANCER / CHEMO procedures
    if (proc.indexOf('chemotherapy') >= 0 || proc.indexOf('chemo') >= 0) candidates.push('693', '694', '695');
    if (proc.indexOf('lymphoma') >= 0) candidates.push('820', '821', '822');
    if (proc.indexOf('leukemia') >= 0) candidates.push('834', '835', '836');
    if (proc.indexOf('mastectomy') >= 0 || proc.indexOf('breast cancer') >= 0) candidates.push('584', '585');
    if (proc.indexOf('lung cancer') >= 0 || proc.indexOf('lobectomy') >= 0) candidates.push('163', '164', '165');
    if (proc.indexOf('colon cancer') >= 0 || proc.indexOf('colorectal') >= 0) candidates.push('329', '330', '331');
    if (proc.indexOf('radiation') >= 0 || proc.indexOf('radiotherapy') >= 0) candidates.push('693', '694');
    // PSYCH / BEHAVIORAL HEALTH procedures
    if (proc.indexOf('psychiatric') >= 0 || proc.indexOf('psych') >= 0 || proc.indexOf('mental health') >= 0 || proc.indexOf('behavioral') >= 0) candidates.push('885', '886');
  }

  // SECOND: Diagnosis keywords from bill text
  if (candidates.length === 0) {
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
    // CANCER / CHEMO from bill text
    if (text.indexOf('chemo') >= 0 || text.indexOf('chemotherapy') >= 0) candidates.push('693', '694', '695');
    if (text.indexOf('lymphoma') >= 0) candidates.push('820', '821', '822');
    if (text.indexOf('leukemia') >= 0) candidates.push('834', '835', '836');
    if (text.indexOf('cancer') >= 0 || text.indexOf('oncology') >= 0 || text.indexOf('neoplasm') >= 0 || text.indexOf('tumor') >= 0 || text.indexOf('malignant') >= 0) candidates.push('693', '694', '695');
    if (text.indexOf('radiation') >= 0 || text.indexOf('radiotherapy') >= 0) candidates.push('693', '694');
    if (text.indexOf('seizure') >= 0 || text.indexOf('epilep') >= 0) candidates.push('101', '100');
    // PSYCH / BEHAVIORAL HEALTH
    if (text.indexOf('behavioral health') >= 0 || text.indexOf('psychiatric') >= 0 || text.indexOf('psych') >= 0 || text.indexOf('mental health') >= 0) candidates.push('885', '886');
    if (text.indexOf('eeg') >= 0 && text.indexOf('behavioral') >= 0) candidates.push('885', '886');
  }

  // THIRD: Clinical service pattern matching (infer diagnosis from treatment combinations)
  if (candidates.length === 0) {
    var hasNebulizer = text.indexOf('neb') >= 0 || text.indexOf('inhalation') >= 0 || text.indexOf('inhaler') >= 0 ||
        text.indexOf('albuterol') >= 0 || text.indexOf('breathing treatment') >= 0 || text.indexOf('respiratory') >= 0;
    var hasABG = text.indexOf('abg') >= 0 || text.indexOf('arterial blood') >= 0 || text.indexOf('blood gas') >= 0 ||
        text.indexOf('arterial puncture') >= 0 || text.indexOf('o2 sat') >= 0;
    var hasChestImaging = (text.indexOf('chest') >= 0 && (text.indexOf('xr') >= 0 || text.indexOf('x-ray') >= 0 ||
        text.indexOf('x ray') >= 0 || text.indexOf('radiograph') >= 0 || text.indexOf('view') >= 0)) ||
        text.indexOf('ct chest') >= 0 || text.indexOf('cxr') >= 0;
    var hasIVAntibiotic = text.indexOf('ceftriaxone') >= 0 || text.indexOf('azithromycin') >= 0 ||
        text.indexOf('vancomycin') >= 0 || text.indexOf('levofloxacin') >= 0 || text.indexOf('piperacillin') >= 0 ||
        text.indexOf('meropenem') >= 0 || text.indexOf('antibiotic') >= 0 || text.indexOf('doxycycline') >= 0;
    var hasTroponin = text.indexOf('troponin') >= 0;
    var hasBNP = text.indexOf('bnp') >= 0 || text.indexOf('natriuretic') >= 0;
    var hasCardiacMonitor = text.indexOf('telemetry') >= 0 || text.indexOf('cardiac monitor') >= 0 || text.indexOf('heart monitor') >= 0;
    var hasDialysis = text.indexOf('dialysis') >= 0 || text.indexOf('hemodialysis') >= 0;
    var hasEKG = text.indexOf('ekg') >= 0 || text.indexOf('ecg') >= 0 || text.indexOf('electrocard') >= 0;
    var hasCBC = text.indexOf('cbc') >= 0 || text.indexOf('blood count') >= 0 || text.indexOf('auto diff') >= 0;
    var hasBMP = text.indexOf('metabolic panel') >= 0 || text.indexOf('bmp') >= 0 || text.indexOf('cmp') >= 0;
    var hasLacticAcid = text.indexOf('lactic') >= 0 || text.indexOf('lactate') >= 0;
    var hasBloodCulture = text.indexOf('blood culture') >= 0 || text.indexOf('culture') >= 0;

    // Pneumonia pattern: nebulizer/respiratory treatment + (ABG or chest imaging)
    if (hasNebulizer && (hasABG || hasChestImaging)) {
      candidates.push('194', '193', '192');
    }
    // Pneumonia pattern: IV antibiotic + chest imaging
    else if (hasIVAntibiotic && hasChestImaging) {
      candidates.push('194', '193', '192');
    }
    // Sepsis pattern: blood culture + lactic acid + IV antibiotic
    else if (hasBloodCulture && hasLacticAcid && hasIVAntibiotic) {
      candidates.push('872', '871');
    }
    // Heart failure pattern: BNP + (cardiac monitor or EKG)
    else if (hasBNP && (hasCardiacMonitor || hasEKG)) {
      candidates.push('293', '292', '291');
    }
    // Chest pain / cardiac pattern: troponin + EKG
    else if (hasTroponin && hasEKG) {
      candidates.push('313');
    }
    // Kidney failure: dialysis present
    else if (hasDialysis) {
      candidates.push('684', '683', '682');
    }
    // General respiratory: nebulizer + standard labs (CBC + metabolic panel) but no specific diagnosis
    else if (hasNebulizer && hasCBC && hasBMP) {
      candidates.push('203', '202', '194');
    }
  }

  // FOURTH: Hospital name + bill pattern clues
  if (candidates.length === 0) {
    var hasSurgical = text.indexOf('or services') >= 0 || text.indexOf('operating room') >= 0 ||
      text.indexOf('oper rm') >= 0 || text.indexOf('surgery') >= 0 ||
      text.indexOf('anesthesia') >= 0 || text.indexOf('recovery room') >= 0;
    var hasImplant = text.indexOf('implant') >= 0 || text.indexOf('device') >= 0 || text.indexOf('prosthe') >= 0;
    var isOrtho = hospitalName.indexOf('ortho') >= 0 || hospitalName.indexOf('joint') >= 0 || hospitalName.indexOf('bone') >= 0;
    var isCardiac = hospitalName.indexOf('heart') >= 0 || hospitalName.indexOf('cardiac') >= 0 || hospitalName.indexOf('cardio') >= 0;
    var isCancer = hospitalName.indexOf('cancer') >= 0 || hospitalName.indexOf('oncol') >= 0 || hospitalName.indexOf('tumor') >= 0;
    var isPsych = hospitalName.indexOf('psych') >= 0 || hospitalName.indexOf('behavioral') >= 0 || hospitalName.indexOf('mental') >= 0;
    var hasBehavioral = text.indexOf('behavioral health') >= 0 || text.indexOf('behavioral treatment') >= 0 ||
      (text.indexOf('eeg') >= 0 && (text.indexOf('behavioral') >= 0 || text.indexOf('psych') >= 0 || text.indexOf('mental') >= 0));

    // Psych/behavioral health facility
    if (isPsych || hasBehavioral) {
      return {
        code: 'RANGE',
        desc: 'Psychiatric/behavioral health admission. Tell us your diagnosis for a precise benchmark.',
        payment: 0,
        los: 0,
        admission_type: 'MEDICAL',
        drg_range: { low: 5000, high: 15000, typical_drg: '885', typical_desc: 'Psychoses' },
        prompt_procedure: true
      };
    }

    // Cancer center
    if (isCancer || text.indexOf('chemo drugs') >= 0 || text.indexOf('infusion') >= 0) {
      return {
        code: 'RANGE',
        desc: 'Cancer treatment / chemotherapy admission. Tell us your diagnosis for a precise benchmark.',
        payment: 0,
        los: 0,
        admission_type: 'MEDICAL',
        drg_range: { low: 8000, high: 35000, typical_drg: '693', typical_desc: 'Chemotherapy with Major Complication' },
        prompt_procedure: true
      };
    }

    // Orthopedic hospital + implant + surgery = likely joint replacement
    if (isOrtho && hasImplant && hasSurgical) {
      return {
        code: 'RANGE',
        desc: 'Orthopedic surgical procedure with implant (likely joint replacement). Tell us your procedure for a precise benchmark.',
        payment: 0,
        los: 0,
        admission_type: 'SURGICAL',
        drg_range: { low: 12000, high: 25000, typical_drg: '470', typical_desc: 'Major Joint Replacement' },
        prompt_procedure: true
      };
    }

    // Cardiac hospital + implant + surgery
    if (isCardiac && hasImplant && hasSurgical) {
      return {
        code: 'RANGE',
        desc: 'Cardiac surgical procedure with implant. Tell us your procedure for a precise benchmark.',
        payment: 0,
        los: 0,
        admission_type: 'SURGICAL',
        drg_range: { low: 15000, high: 45000, typical_drg: '245', typical_desc: 'Cardiac Device Implant' },
        prompt_procedure: true
      };
    }

    // Generic surgical with implant
    if (hasImplant && hasSurgical) {
      return {
        code: 'RANGE',
        desc: 'Surgical admission with implant (specific procedure unknown). Tell us your procedure for a precise benchmark.',
        payment: 0,
        los: 0,
        admission_type: 'SURGICAL',
        drg_range: { low: 10000, high: 30000 },
        prompt_procedure: true
      };
    }

    // Generic surgical or medical
    return {
      code: 'UNKNOWN',
      desc: hasSurgical ? 'Surgical admission (specific procedure unknown). Tell us your procedure for a precise benchmark.' : 'Medical admission (specific diagnosis unknown). Tell us your diagnosis for a precise benchmark.',
      payment: 0,
      los: 0,
      admission_type: hasSurgical ? 'SURGICAL' : 'MEDICAL',
      prompt_procedure: true
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

// ── Detect summary bill (no CPT codes) ──────────────────────
function detectSummaryBill(extracted, enrichedItems) {
  if (!extracted.line_items || extracted.line_items.length === 0) return false;
  var totalBilled = extracted.total_billed || 0;
  if (totalBilled < 500) return false;

  var matchedCount = 0;
  var totalItems = enrichedItems.length;
  enrichedItems.forEach(function(item) {
    if (item.fair_rate !== null && item.code) matchedCount++;
  });

  var deptKeywords = [
    'room and', 'room &', 'bed semi', 'bed priv', 'room-priv', 'room-semi',
    'medical-sur', 'med-sur', 'room and care', 'room and board',
    'pharmacy', 'drugs req', 'drug charge', 'single source drug',
    'supplies', 'sterile supply', 'med-sur supplies',
    'laboratory', 'chemistry', 'hematology', 'bacteriology', 'microbiology',
    'urology', 'pathology', 'pathology lab', 'lab-',
    'radiology', 'ct scan', 'mri', 'ultrasound', 'diagnostic-general',
    'cardiology', 'pulmonary', 'respiratory', 'ekg', 'ecg', 'eeg',
    'pulmonary function',
    'or services', 'operating room', 'surgery services', 'recovery room',
    'anesthesia',
    'emergency room', 'emergency care', 'emerg room',
    'intensive care', 'intermediate care', 'icu',
    'therapy services', 'physical therapy', 'occupational therapy',
    'respiratory therapy', 'behavioral health', 'rehabilitation',
    'other therapeutic',
    'blood', 'blood adm', 'special services', 'audiology', 'iv therapy', 'miscellaneous',
    'medical/surgical', 'professional or physician', 'professional fee',
    'extension of', 'room and bed', 'central supply', 'chemo drugs', 'chemo',
    'infusion', 'med/surg supp', 'implant'
  ];
  var deptMatchCount = 0;
  (extracted.line_items || []).forEach(function(item) {
    var desc = (item.description || '').toLowerCase();
    for (var i = 0; i < deptKeywords.length; i++) {
      if (desc.indexOf(deptKeywords[i]) >= 0) { deptMatchCount++; break; }
    }
  });

  var matchRate = totalItems > 0 ? matchedCount / totalItems : 0;
  var deptRate = totalItems > 0 ? deptMatchCount / totalItems : 0;

  var totalFairValue = 0;
  enrichedItems.forEach(function(item) {
    if (item.total_fair) totalFairValue += item.total_fair;
  });
  var fairCoverage = totalBilled > 0 ? totalFairValue / totalBilled : 0;

  // Count items that had REAL CPT codes from the original bill (not from our mapping step)
  var originalCodeCount = 0;
  enrichedItems.forEach(function(item) {
    var oc = (item.original_code || '').trim();
    if (oc && oc !== '0' && oc !== '00000' && !/^0+$/.test(oc)) originalCodeCount++;
  });
  var originalCodeRate = totalItems > 0 ? originalCodeCount / totalItems : 0;

  // RULE 1: Very high department match = always summary (60%+ department names is never itemized)
  if (deptRate > 0.6) {
    console.log('Summary bill: deptRate ' + deptRate.toFixed(2) + ' > 0.6 threshold');
    return true;
  }
  // RULE 2: Original bill had zero/near-zero real CPT codes AND looks departmental
  if (originalCodeRate < 0.1 && deptRate > 0.3) {
    console.log('Summary bill: no original CPT codes (rate ' + originalCodeRate.toFixed(2) + '), deptRate ' + deptRate.toFixed(2));
    return true;
  }
  // RULE 3: Low CPT match rate + departmental (original check)
  if (matchRate < 0.15 && deptRate > 0.4) return true;
  // RULE 4: Fair value covers almost nothing despite department layout
  if (fairCoverage < 0.05 && deptRate > 0.4 && totalBilled > 1000) return true;
  return false;
}

// ── Build summary bill response ─────────────────────────────
function buildSummaryBillResponse(extracted, enrichedItems, billType, totalBilled, drgEstimate) {
  var hospital = (extracted.hospital || 'the hospital').trim();
  var state = (extracted.state || '').trim();
  var dos = (extracted.date_of_service || '').trim();

  var departments = enrichedItems.map(function(item) {
    return { description: item.description, billed: item.billed };
  }).filter(function(d) { return d.billed > 0; })
  .sort(function(a, b) { return b.billed - a.billed; });

  var roomCharge = 0;
  departments.forEach(function(d) {
    var desc = d.description.toLowerCase();
    if (desc.indexOf('room') >= 0 || desc.indexOf('care') >= 0 || desc.indexOf('bed') >= 0) {
      roomCharge += d.billed;
    }
  });
  var estimatedDays = roomCharge > 0 ? Math.round(roomCharge / 3500) : null;

  var flags = [];
  departments.forEach(function(d) {
    var pct = totalBilled > 0 ? Math.round(d.billed / totalBilled * 100) : 0;
    var desc = d.description.toLowerCase();
    if (desc.indexOf('pharmacy') >= 0 && pct > 20) {
      flags.push({ department: d.description, amount: d.billed, pct: pct, note: 'Pharmacy charges represent ' + pct + '% of total bill -- unusually high. May include markup on individual drugs.' });
    }
    if ((desc.indexOf('chemo') >= 0 || desc.indexOf('infusion') >= 0) && d.billed > 5000) {
      flags.push({ department: d.description, amount: d.billed, pct: pct, note: 'Chemotherapy/infusion charges of $' + d.billed.toLocaleString() + ' -- request itemized bill to verify individual drug pricing against Medicare ASP+6% rates.' });
    }
    if (desc.indexOf('respiratory') >= 0 && pct > 15) {
      flags.push({ department: d.description, amount: d.billed, pct: pct, note: 'Respiratory therapy charges represent ' + pct + '% of total bill -- warrants line-item review.' });
    }
    if ((desc.indexOf('supply') >= 0 || desc.indexOf('surgical') >= 0) && pct > 25) {
      flags.push({ department: d.description, amount: d.billed, pct: pct, note: 'Supply/surgical charges at ' + pct + '% is unusually high. Hospitals commonly mark up supplies 5-10x cost.' });
    }
  });

  var drgContext = '';
  if (billType === 'INPATIENT' && drgEstimate) {
    if (drgEstimate.code !== 'UNKNOWN' && drgEstimate.code !== 'RANGE' && drgEstimate.payment > 0) {
      var multiplier = totalBilled > 0 ? (totalBilled / drgEstimate.payment).toFixed(1) : 'N/A';
      drgContext = 'Based on available information, the estimated Medicare DRG payment for this type of admission would be approximately $' +
        drgEstimate.payment.toLocaleString() + ' (DRG ' + drgEstimate.code + '). Your bill of $' +
        totalBilled.toLocaleString() + ' is approximately ' + multiplier + 'x the Medicare benchmark.';
    } else if (drgEstimate.code === 'RANGE' && drgEstimate.drg_range) {
      var range = drgEstimate.drg_range;
      drgContext = 'This appears to be a ' + (drgEstimate.desc || 'surgical admission') +
        ' Medicare typically pays between $' + range.low.toLocaleString() + ' and $' + range.high.toLocaleString() +
        ' for similar procedures' + (range.typical_desc ? ' (e.g., ' + range.typical_desc + ')' : '') +
        '. Your bill of $' + totalBilled.toLocaleString() + ' is ' +
        (range.high > 0 ? (totalBilled / range.high).toFixed(1) + 'x to ' + (totalBilled / range.low).toFixed(1) + 'x' : 'significantly above') +
        ' the Medicare benchmark. To get a precise comparison, tell us what procedure you had.';
    } else {
      drgContext = 'This appears to be a ' + (drgEstimate.desc || 'hospital admission') +
        '. Without an itemized bill or procedure details, we cannot determine the exact DRG classification or Medicare benchmark. ' +
        'Tell us what procedure you had, or request an itemized bill with procedure codes for a precise analysis.';
    }
  }

  var summaryParts = ['This is a summary bill showing $' + totalBilled.toLocaleString() + ' in total charges across ' + departments.length + ' service departments.'];
  if (estimatedDays) summaryParts.push('The room charges suggest an estimated ' + estimatedDays + '-day hospital stay.');
  summaryParts.push('This bill does not contain the individual procedure codes (CPT/HCPCS codes) needed for a full line-by-line analysis.');
  if (drgContext) summaryParts.push(drgContext);
  summaryParts.push('To unlock your complete BillXM overcharge analysis, request an itemized bill from ' + hospital + ' using the phone script and letter below.');

  var phoneScript = 'Hello, I am calling about my account' +
    (dos ? ' for services received on ' + dos : '') +
    ' at ' + hospital + '. ' +
    'I am requesting a fully itemized bill that includes CPT and HCPCS procedure codes, revenue codes, dates of service for each item, and individual charges for every service rendered. ' +
    'Under federal regulations including the No Surprises Act and CMS Conditions of Participation for Medicare-certified hospitals, I am entitled to a detailed itemized statement. ' +
    'Please send this to me within 30 business days. ' +
    'Can you confirm this will be mailed to my address on file? ' +
    'If I do not receive it within 30 days, I will follow up in writing and may file a complaint with my state attorney general and the Centers for Medicare & Medicaid Services.';

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

  var estimatedFairValue = null;
  var potentialSavings = null;
  if (drgEstimate && drgEstimate.code !== 'UNKNOWN' && drgEstimate.code !== 'RANGE' && drgEstimate.payment > 0) {
    estimatedFairValue = drgEstimate.payment;
    potentialSavings = Math.max(0, Math.round((totalBilled - drgEstimate.payment) * 100) / 100);
  } else if (drgEstimate && drgEstimate.code === 'RANGE' && drgEstimate.drg_range) {
    var rangeHigh = drgEstimate.drg_range.high || 0;
    if (rangeHigh > 0 && totalBilled > rangeHigh) {
      estimatedFairValue = rangeHigh;
      potentialSavings = Math.max(0, Math.round((totalBilled - rangeHigh) * 100) / 100);
    }
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
    potential_savings: null, // Don't show OVERCHARGED for PENDING -- we can't verify without itemized bill
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
    var hospital = (extracted.hospital || '').trim();
    var state = (extracted.state || '').trim();
    var city = (extracted.city || '').trim();
    if (!hospital) return;

    var record = {
      hospital: hospital, state: state, city: city, bill_type: billType,
      drg: drgEstimate ? drgEstimate.code : null,
      total_billed: totalBilled, fair_value: estimatedFairValue,
      savings: potentialSavings, grade: grade || 'N/A',
      issue_count: issueCount || 0,
      month: new Date().toISOString().slice(0, 7),
      codes: enrichedItems
        .filter(function(i) { return i.code && i.billed > 0; })
        .map(function(i) { return { code: i.code, billed: i.billed, fair: i.total_fair, type: i.type }; })
    };

    if (process.env.KV_REST_API_URL) {
      var Redis = require('@upstash/redis').Redis;
      var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      var analysisKey = 'analysis:' + Date.now();
      await redis.set(analysisKey, JSON.stringify(record), { ex: 365 * 24 * 60 * 60 });
      await redis.incrby('counter:bills_analyzed', 1);
      await redis.incrby('counter:charges_reviewed', Math.round(totalBilled));
      if (potentialSavings && potentialSavings > 0) {
        await redis.incrby('counter:savings_found', Math.round(potentialSavings));
      }
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
            hospital: hospital, state: state, city: city, code: c.code,
            count: 1, total_billed: c.billed, avg_billed: c.billed,
            min_billed: c.billed, max_billed: c.billed,
            medicare_rate: c.fair || null, type: c.type
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

// ── Timeout wrapper for API calls ────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error('TIMEOUT: ' + label + ' did not respond within ' + Math.round(ms/1000) + 's')); }, ms);
    })
  ]);
}

// ── Extraction prompt — restored to original working version with subtotals ──
var EXTRACT_PROMPT = 'You are a medical bill data extractor. Extract every charge from this bill into structured JSON.\n\n' +
'Rules:\n' +
'- Include EVERY line item on the bill, even $0.00 items\n' +
'- Preserve the exact code shown on the bill (including leading zeros like 036600)\n' +
'- Use the exact dollar amounts shown on the bill\n' +
'- Your total_billed MUST equal the bill\'s stated total (look for "Total Amount", "Total Charges", "Total Patient Services"). Find this number FIRST, then make sure your line items add up to it.\n' +
'- Include subtotals for each category/department on the bill\n' +
'- If a service appears multiple times on different dates, each is a separate line item\n' +
'- Look for the words "INPATIENT" or "OUTPATIENT" printed on the bill for bill_type_text\n' +
'- For drugs with code 00000, set code to "" and include the drug name in description\n' +
'- Include ALL items you see, even discounts, payments, and adjustments. Put everything in line_items.\n\n' +
'Return ONLY valid JSON, no markdown, no explanation:\n' +
'{\n' +
'  "hospital": "hospital name as printed",\n' +
'  "state": "2-letter state code",\n' +
'  "city": "city name",\n' +
'  "date_of_service": "date or date range",\n' +
'  "bill_type_text": "exact text from bill e.g. INPATIENT SERVICES",\n' +
'  "line_items": [\n' +
'    {"code": "036600", "description": "ARTERIAL PUNCTURE", "quantity": 1, "billed": 372.28, "date": "10/10/22", "category": "LABORATORY"}\n' +
'  ],\n' +
'  "subtotals": {"LABORATORY": 510.34, "RESPIRATORY SVC": 847.60},\n' +
'  "adjustments": 0,\n' +
'  "total_before_adjustments": 0,\n' +
'  "total_billed": 0\n' +
'}';

// ── Sonnet report prompt ─────────────────────────────────────
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
'- FACILITY_OVERCHARGE: when total facility charges exceed the APC or DRG benchmark. HIGH severity.\n' +
'- PACKAGED_CHARGE: when a charge that should be packaged into APC/DRG appears as a separate line item.\n' +
'- Do NOT flag items without fair rates unless they are packaged charges\n\n' +
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
'  "phone_script": "word-for-word phone script",\n' +
'  "dispute_letter": "formal dispute letter",\n' +
'  "next_steps": ["actionable step"],\n' +
'  "nsa_eligible": false,\n' +
'  "financial_assistance_note": "guidance if applicable",\n' +
'  "insurance_notes": "info if relevant",\n' +
'  "appeal_recommended": false\n' +
'}\n\n' +
'CRITICAL: Use the total_billed, estimated_fair_value, and potential_savings exactly as provided. Do not recalculate them.\n' +
'If coverage_note is provided, include it in your summary.\n' +
'If partial_bill_note is provided, include it prominently.\n' +
'Write all descriptions in plain English.';

// ── Grade-only prompt ────────────────────────────────────────
var GRADE_PROMPT = 'You are BillXM AI. Quickly assess this medical bill data and return a grade.\n\n' +
'Grade based on the overcharge percentage provided:\n' +
'- A = overcharge < 10%\n' +
'- B = overcharge 10-25%\n' +
'- C = overcharge 25-50%\n' +
'- D = overcharge 50-75%\n' +
'- F = overcharge >75% or billing violations\n\n' +
'If potential_savings is $0, grade MUST be A.\n' +
'If unmapped_charges is high (over 50% of total), note in the summary that the grade only reflects benchmarked services.\n' +
'If partial_bill_note is provided, include it in the summary.\n\n' +
'Return ONLY valid JSON:\n' +
'{"grade":"A-F","grade_rationale":"one sentence","summary":"2 sentences for patient",' +
'"total_billed":0,"estimated_fair_value":0,"potential_savings":0,' +
'"issue_count":0,"high_count":0,"medium_count":0,"low_count":0}';

// ── CPT mapping prompt ───────────────────────────────────────
var CPT_MAP_PROMPT = 'You are a medical coding expert. Map each service description to its standard CPT or HCPCS code.\n\n' +
'Return ONLY valid JSON, no markdown:\n' +
'{"mappings": [{"description": "original description", "cpt": "5-digit CPT code", "confidence": "HIGH|MEDIUM|LOW"}]}\n\n' +
'Rules:\n' +
'- Only map if you are confident in the CPT code\n' +
'- If unsure, set cpt to "" and confidence to "LOW"\n' +
'- IGNORE prefixes like "HC " (Hospital Charge)\n' +
'- ONLY these are facility charges (set cpt to ""): ROOM AND BOARD, PROGRESSIVE CARE UNIT, OBSERVATION HOUR, NURSING CARE\n' +
'- NEVER set cpt to "" for: EKG, ECG, CBC, labs, x-rays, CT scans, infusions, blood tests, panels, cultures, therapy services, injections, or any diagnostic test\n' +
'- Common mappings:\n' +
'  EKG/ECG = 93005, EKG 12 LEAD = 93000, CT HEAD W/O CONTRAST = 70450,\n' +
'  CBC/CBS WITH AUTO DIFF = 85025, CBC = 85027,\n' +
'  BASIC METABOLIC PANEL = 80048, COMP METABOLIC PANEL = 80053,\n' +
'  ED CARE LEVEL 4 = 99284, ED CARE LEVEL 5 = 99285, ED CARE LEVEL 3 = 99283,\n' +
'  CHEST X-RAY 1 VIEW = 71045, CHEST X-RAY 2 VIEW = 71046,\n' +
'  IV INFUSION HYDRATION 1ST HR = 96360, HYDRATION ADDL HOUR = 96361,\n' +
'  IV PUSH = 96374, IV PUSH EA ADDL = 96375,\n' +
'  BLOOD GAS/ABG = 82803, BLOOD CULTURE = 87040, LACTIC ACID = 83605,\n' +
'  URINALYSIS = 81003, HEPATIC PANEL = 80076, LIPID PANEL = 80061,\n' +
'  THYROID STIMULATING HORMONE = 84443, MAGNESIUM LEVEL = 83735\n' +
'- Drug J-code mappings:\n' +
'  ONDANSETRON/ZOFRAN = J2405, KETOROLAC/TORADOL = J1885, MORPHINE = J2270,\n' +
'  HEPARIN = J1644, ENOXAPARIN/LOVENOX = J1650, DEXAMETHASONE = J1100,\n' +
'  VANCOMYCIN = J3370, CEFTRIAXONE = J0696, AZITHROMYCIN = J0456,\n' +
'  ACETAMINOPHEN IV = J0131, PANTOPRAZOLE IV = J3480, FAMOTIDINE IV = J3490\n' +
'- IV FLUID J-codes:\n' +
'  SODIUM CHLORIDE 0.9%/NORMAL SALINE 1000 = J7030,\n' +
'  SODIUM CHLORIDE 0.9% 500 ML = J7040, SODIUM CHLORIDE 0.9% 250 = J7050,\n' +
'  LACTATED RINGERS/LR = J7120, DEXTROSE 5% 500 ML = J7060\n';

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
    { code: '', description: 'Room and Care', billed: 1545.34, quantity: 1, fair_rate: null, total_fair: 5441.93, markup_pct: '--', status: 'DRG_COVERED', note: 'Packaged into DRG 194 (SIMPLE PNEUMONIA AND PLEURISY WITH CC) -- not separately payable' },
    { code: '36600', description: 'Arterial Puncture', billed: 372.28, quantity: 1, fair_rate: 13.26, total_fair: 0, markup_pct: '2709%', status: 'FLAG', note: 'Overcharged 2709% above Medicare rate -- DISPUTE' },
    { code: '36415', description: 'Venipuncture', billed: 69.03, quantity: 1, fair_rate: 3.44, total_fair: 0, markup_pct: '1906%', status: 'FLAG', note: 'Overcharged 1906% above Medicare rate -- DISPUTE' },
    { code: '36415', description: 'Venipuncture', billed: 69.03, quantity: 1, fair_rate: 3.44, total_fair: 0, markup_pct: '1906%', status: 'FLAG', note: 'Overcharged 1906% above Medicare rate -- DISPUTE' },
    { code: '82805', description: 'ABG with Meas O2 Sat', billed: 270.31, quantity: 1, fair_rate: 16.17, total_fair: 0, markup_pct: '1572%', status: 'FLAG', note: 'Overcharged 1572% above Medicare rate -- DISPUTE' },
    { code: '80053', description: 'Comp Metabolic Panel', billed: 434.60, quantity: 1, fair_rate: 10.56, total_fair: 0, markup_pct: '4015%', status: 'FLAG', note: 'Overcharged 4015% above Medicare rate -- DISPUTE' },
    { code: '80048', description: 'Basic Metabolic Panel', billed: 286.15, quantity: 1, fair_rate: 8.46, total_fair: 0, markup_pct: '3282%', status: 'FLAG', note: 'Overcharged 3282% above Medicare rate -- DISPUTE' },
    { code: '85025', description: 'CBC Auto Diff', billed: 220.95, quantity: 1, fair_rate: 8.07, total_fair: 0, markup_pct: '2639%', status: 'FLAG', note: 'Overcharged 2639% above Medicare rate -- DISPUTE' },
    { code: '85025', description: 'CBC Auto Diff', billed: 220.95, quantity: 1, fair_rate: 8.07, total_fair: 0, markup_pct: '2639%', status: 'FLAG', note: 'Overcharged 2639% above Medicare rate -- DISPUTE' },
    { code: '71045', description: 'XR Chest Sgl View', billed: 256.78, quantity: 1, fair_rate: 20.41, total_fair: 0, markup_pct: '1158%', status: 'FLAG', note: 'Overcharged 1158% above Medicare rate -- DISPUTE' },
    { code: '94640', description: 'Inhalation TX', billed: 132.78, quantity: 1, fair_rate: 11.54, total_fair: 0, markup_pct: '1051%', status: 'FLAG', note: 'Overcharged 1051% above Medicare rate -- DISPUTE' },
    { code: '94640', description: 'Hand Held Neb SubQ', billed: 116.55, quantity: 1, fair_rate: 11.54, total_fair: 0, markup_pct: '910%', status: 'FLAG', note: 'Overcharged 910% above Medicare rate -- DISPUTE' },
    { code: '94668', description: 'Chest Physio SubsQ', billed: 49.68, quantity: 5, fair_rate: 7.65, total_fair: 0, markup_pct: '549%', status: 'FLAG', note: 'Overcharged 549% above Medicare rate -- DISPUTE' },
    { code: '94640', description: 'MDI SubQ', billed: 116.55, quantity: 1, fair_rate: 11.54, total_fair: 0, markup_pct: '910%', status: 'FLAG', note: 'Overcharged 910% above Medicare rate -- DISPUTE' },
    { code: '94640', description: 'Hand Held Neb SubQ', billed: 233.10, quantity: 2, fair_rate: 11.54, total_fair: 0, markup_pct: '910%', status: 'FLAG', note: 'Overcharged 910% above Medicare rate -- DISPUTE' },
    { code: '', description: 'Albuterol 8.5GM INH', billed: 119.86, quantity: 1, fair_rate: null, total_fair: null, markup_pct: '--', status: 'DRG_COVERED', note: 'Drug/supply charge -- packaged into DRG 194 payment' },
    { code: '', description: 'Pot Cl 20MEQ SRT', billed: 6.73, quantity: 2, fair_rate: null, total_fair: null, markup_pct: '--', status: 'DRG_COVERED', note: 'Drug/supply charge -- packaged into DRG 194 payment' },
    { code: '', description: 'Fluticasone/Vilant 200/25', billed: 779.93, quantity: 1, fair_rate: null, total_fair: null, markup_pct: '--', status: 'DRG_COVERED', note: 'Drug/supply charge -- packaged into DRG 194 payment' },
    { code: '93005', description: 'EKG', billed: 287.68, quantity: 1, fair_rate: 6.38, total_fair: 0, markup_pct: '4408%', status: 'FLAG', note: 'Overcharged 4408% above Medicare rate -- DISPUTE' }
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
  var patientProcedure = body.procedure || '';

  // ── FIX 1: Detect if this is an image upload ──
  var isImageUpload = false;
  try {
    if (Array.isArray(messages)) {
      messages.forEach(function(msg) {
        if (Array.isArray(msg.content)) {
          msg.content.forEach(function(block) {
            if (block.type === 'image') isImageUpload = true;
          });
        }
      });
    }
  } catch (e) { /* ignore */ }

  console.log('=== ANALYZE REQUEST ===');
  console.log('Tier:', tier, 'Demo:', !!body.demo, 'Procedure:', patientProcedure || 'not provided', 'Image:', isImageUpload);

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
    console.log('Loading CMS data...');
    loadCMSData();
    console.log('CMS data loaded.');

    // ── DEMO: Return cached result with artificial delay ──
    if (body.demo === true) {
      console.log('Demo bill -- returning cached result');
      var delay = 10000 + Math.floor(Math.random() * 5000);
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(CACHED_DEMO_REPORT) }] });
    }

    console.log('Creating Anthropic client...');
    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('Anthropic client ready.');

    // ════════════════════════════════════════════════════════════
    // STEP 1: Extract structured data with Sonnet
    // ════════════════════════════════════════════════════════════
    console.log('Step 1: Extracting bill data with Sonnet...');
    var extractResponse;
    try {
      extractResponse = await withTimeout(
        client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          system: EXTRACT_PROMPT,
          messages: messages,
        }),
        90000,
        'Sonnet extraction'
      );
      console.log('Sonnet extraction complete.');
    } catch (apiErr) {
      console.error('Sonnet extraction error:', apiErr.message);

      // ── FIX 3: Graceful fallback for image failures ──
      if (isImageUpload) {
        console.log('Image extraction failed -- returning IMAGE_UNREADABLE response');
        var fallbackResult = {
          bill_type: 'UNKNOWN',
          report_type: 'IMAGE_UNREADABLE',
          grade: 'PENDING',
          grade_rationale: 'We could not read this bill image clearly enough to extract charges. Upload a PDF for best results.',
          summary: 'BillXM was unable to extract the charges from this bill image. This can happen with photos of paper bills, low-resolution images, or bills with unusual formatting. For the most accurate analysis, request a PDF copy of your bill from the hospital (most hospitals can email you one) and upload that instead. If you only have a paper bill, try taking a clearer photo with good lighting, or scan it as a PDF.',
          hospital: '',
          state: '',
          date_of_service: '',
          total_billed: 0,
          estimated_fair_value: null,
          potential_savings: null,
          drg_estimate: null,
          departments: [],
          department_flags: [],
          phone_script: 'Hello, I am calling to request a PDF or electronic copy of my hospital bill. I need a detailed statement showing all charges, procedure codes, and dates of service. Can you email that to me? If not, can you mail me an itemized statement with CPT codes?',
          request_letter: '',
          next_steps: [
            'Request a PDF copy of your bill from the hospital -- most hospitals can email this to you',
            'If you only have a paper bill, try scanning it as a PDF using your phone (most phone cameras have a scan mode)',
            'Upload the PDF to BillXM for a complete analysis',
            'If you need immediate help, use the contact form below to send your bill to our team for manual review'
          ],
          issues: [],
          line_items: [],
          nsa_eligible: false,
          financial_assistance_note: '',
          insurance_notes: '',
          appeal_recommended: false
        };
        return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(fallbackResult) }] });
      }

      throw new Error('Bill extraction failed: ' + (apiErr.message || 'API error'));
    }

    var extracted;
    try {
      var raw = extractResponse.content.map(function(b) { return b.text || ''; }).join('');
      raw = raw.replace(/```json|```/g, '').trim();
      var s = raw.indexOf('{');
      var e = raw.lastIndexOf('}');
      if (s === -1 || e === -1) throw new Error('No JSON found in Haiku response');
      extracted = JSON.parse(raw.slice(s, e + 1));
    } catch (err) {
      console.error('JSON parse failed. Raw response:', raw ? raw.substring(0, 200) : 'empty');

      // ── FIX 3b: If parse fails on image, return IMAGE_UNREADABLE ──
      if (isImageUpload) {
        console.log('Image JSON parse failed -- returning IMAGE_UNREADABLE response');
        var parseFailResult = {
          bill_type: 'UNKNOWN',
          report_type: 'IMAGE_UNREADABLE',
          grade: 'PENDING',
          grade_rationale: 'We could not extract structured data from this bill image. Upload a PDF for best results.',
          summary: 'BillXM could not clearly read the charges on this bill image. The image may be blurry, too small, or have formatting that makes it difficult to extract individual line items. For the best results, upload a PDF copy of your bill. You can request one from your hospital by calling their billing department.',
          hospital: '', state: '', date_of_service: '',
          total_billed: 0, estimated_fair_value: null, potential_savings: null,
          drg_estimate: null, departments: [], department_flags: [],
          phone_script: 'Hello, I am calling to request a PDF or electronic copy of my hospital bill. I need a detailed statement showing all charges, procedure codes, and dates of service. Can you email that to me?',
          request_letter: '',
          next_steps: [
            'Request a PDF copy of your bill from the hospital',
            'Try scanning your paper bill as a PDF using your phone camera',
            'Upload the PDF to BillXM for a complete analysis'
          ],
          issues: [], line_items: [],
          nsa_eligible: false, financial_assistance_note: '', insurance_notes: '', appeal_recommended: false
        };
        return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(parseFailResult) }] });
      }

      throw new Error('Failed to parse bill extraction: ' + err.message);
    }

    var extractedTotal = extracted.total_billed || 0;
    var itemCount = (extracted.line_items || []).length;
    console.log('Extracted: ' + itemCount + ' items, total: $' + extractedTotal.toFixed(2));

    // Preserve the bill's stated total -- this is the number the customer sees
    var statedTotal = extractedTotal;

    // ── FIX: Use total_billed as the customer-facing number ──
    // total_before_adjustments is the pre-discount amount, but the customer sees total_billed
    // We use total_before_adjustments only as context for the discount filter
    if (extracted.total_before_adjustments > 0 && extracted.total_before_adjustments < extractedTotal) {
      // total_before_adjustments is LESS than total_billed: unusual, use the lower as the real total
      console.log('Using total_before_adjustments: $' + extracted.total_before_adjustments.toFixed(2) + ' (was $' + extractedTotal.toFixed(2) + ')');
      extractedTotal = extracted.total_before_adjustments;
      extracted.total_billed = extracted.total_before_adjustments;
      statedTotal = extractedTotal;
    }

    // If adjustments reported, store as reference for the line item filter
    if (extracted.adjustments && extracted.adjustments < 0) {
      var adjustedTotal = extractedTotal + extracted.adjustments; // adjustments is negative
      if (adjustedTotal > 0 && adjustedTotal < extractedTotal) {
        console.log('Reported adjustments: $' + extracted.adjustments.toFixed(2) + ' (net: $' + adjustedTotal.toFixed(2) + ')');
        extracted._expectedTotal = adjustedTotal;
      }
    }

    // ── Validate: do line items sum match stated total? ──
    var lineItemSum = 0;
    (extracted.line_items || []).forEach(function(item) { lineItemSum += (item.billed || 0); });

    // Use total_before_adjustments as reference for VALIDATION ONLY (not for total_billed)
    // This helps detect when the discount filter missed items
    var referenceTotal = extractedTotal;
    if (extracted.total_before_adjustments > referenceTotal) {
      referenceTotal = extracted.total_before_adjustments;
      // DO NOT override extractedTotal or statedTotal here
      // The customer sees total_billed, not total_before_adjustments
      console.log('Validation reference: $' + referenceTotal.toFixed(2) + ' (total_before_adjustments), bill total: $' + extractedTotal.toFixed(2));
    }

    // Log extraction quality (no retry needed with Sonnet)
    var totalDiff = Math.abs(lineItemSum - referenceTotal);
    var totalPct = referenceTotal > 0 ? (totalDiff / referenceTotal) : 0;
    if (totalPct > 0.15) {
      console.log('NOTE: Items sum $' + lineItemSum.toFixed(2) + ' vs total $' + referenceTotal.toFixed(2) + ' (' + Math.round(totalPct * 100) + '% gap)');
    }

    // ════════════════════════════════════════════════════════════
    // STEP 1b: Separate charges from discounts/credits/payments
    // ════════════════════════════════════════════════════════════
    if (extracted.line_items && extracted.line_items.length > 0) {
      var discountKeywords = ['discount', 'disc ', 'disc.', 'uninsured', 'prompt pay',
        'adjustment', 'write-off', 'write off', 'charity',
        'financial assistance', 'courtesy', 'contractual', 'allowance',
        'account balance', 'account bal', 'acct bal', 'acct balance',
        'balance due', 'amount due', 'total due', 'pay now', 'please pay',
        'patient responsibility', 'patient balance', 'your balance',
        'this is your balance', 'due from insurance', 'remaining responsibility',
        'insurance payment', 'insurance discount', 'insurance covered',
        'billed to insurance', 'billed to ins', 'submitted to insurance',
        'benefits summary', 'benefit summary',
        'coinsurance', 'copay', 'co-pay', 'deductible',
        'total activity', 'total patient services',
        'total charges', 'total amount billed', 'billed/total',
        'page ', 'page 1', 'page 2', 'continued',
        'payment', 'paid', 'credit', 'refund',
        'united healthcare', 'blue cross', 'aetna', 'cigna', 'humana',
        'kaiser', 'medicaid', 'medicare payment', 'tricare',
        'payer', 'primary insurance', 'secondary insurance',
        'amount covered', 'plan paid', 'plan payment',
        'member responsibility', 'patient portion', 'you owe',
        'amount you owe', 'your responsibility'];
      var charges = [];
      var adjustmentsTotal = 0;
      extracted.line_items.forEach(function(item) {
        var desc = (item.description || '').toLowerCase();
        var isDiscount = false;
        for (var dk = 0; dk < discountKeywords.length; dk++) {
          if (desc.indexOf(discountKeywords[dk]) >= 0) { isDiscount = true; break; }
        }
        if ((item.billed || 0) < 0) {
          adjustmentsTotal += (item.billed || 0);
        } else if (isDiscount) {
          console.log('Discount keyword matched: "' + item.description + '" $' + (item.billed || 0).toFixed(2));
          adjustmentsTotal -= (item.billed || 0);
        } else {
          charges.push(item);
        }
      });
      if (charges.length < extracted.line_items.length) {
        console.log('Separated: ' + charges.length + ' charges from ' + (extracted.line_items.length - charges.length) + ' discounts/credits (adjustments: $' + adjustmentsTotal.toFixed(2) + ')');
        extracted.line_items = charges;
        extracted.adjustments = adjustmentsTotal;
      }

      // ── Numerical discount detection: if extraction reported adjustments but keyword filter missed them ──
      // Check if charges sum exceeds what it should be by roughly the adjustment amount
      if (extracted.adjustments && Math.abs(extracted.adjustments) > 0) {
        var chargesSum = 0;
        charges.forEach(function(item) { chargesSum += (item.billed || 0); });
        var expectedTotal = chargesSum + (extracted.adjustments || 0); // adjustments are negative
        // If Haiku reported adjustments but the discount is still in the charges, find and remove it
        // Look for a charge whose amount ≈ the absolute adjustment value
        var absAdj = Math.abs(extracted.adjustments);
        if (absAdj > 100) {
          var bestMatch = null;
          var bestDiff = Infinity;
          charges.forEach(function(item, idx) {
            var diff = Math.abs((item.billed || 0) - absAdj);
            if (diff < absAdj * 0.05 && diff < bestDiff) { // within 5% of adjustment
              bestMatch = idx;
              bestDiff = diff;
            }
          });
          if (bestMatch !== null) {
            var removed = charges[bestMatch];
            console.log('NUMERICAL MATCH: Removed suspected discount line: "' + removed.description + '" $' + (removed.billed || 0).toFixed(2) + ' (≈ adjustment amount $' + absAdj.toFixed(2) + ')');
            charges.splice(bestMatch, 1);
            extracted.line_items = charges;
          }
        }
      }

      // ── FIX: Sanity check -- catch account balance / total due lines mislabeled as charges ──
      // If any single charge equals the sum of all OTHER charges (within 5%), it's an account balance, not a charge
      // Also remove any charge that equals total_billed (it's a summary/total line, not a real charge)
      if (extracted.line_items.length > 2) {
        var totalAllItems = 0;
        extracted.line_items.forEach(function(item) { totalAllItems += (item.billed || 0); });
        var suspiciousRemoved = false;
        extracted.line_items = extracted.line_items.filter(function(item) {
          var billed = item.billed || 0;
          if (billed <= 0) return true; // keep negative items for now
          var otherSum = totalAllItems - billed;
          var diff = Math.abs(billed - otherSum);
          // If this item's amount ≈ sum of all other items, it's a running total, not a charge
          if (otherSum > 0 && diff / otherSum < 0.05 && billed > 0) {
            console.log('SANITY CHECK: Removed suspected total/summary line: "' + item.description + '" $' + billed.toFixed(2) + ' (≈ sum of other charges $' + otherSum.toFixed(2) + ')');
            suspiciousRemoved = true;
            return false;
          }
          // If this item equals the stated total_billed, it's a summary line (e.g. "Billed to Insurance")
          if (extractedTotal > 0 && Math.abs(billed - extractedTotal) / extractedTotal < 0.02) {
            console.log('SANITY CHECK: Removed line matching total_billed: "' + item.description + '" $' + billed.toFixed(2));
            suspiciousRemoved = true;
            return false;
          }
          return true;
        });
        if (suspiciousRemoved) {
          var newSum = 0;
          extracted.line_items.forEach(function(item) { newSum += (item.billed || 0); });
          console.log('After sanity check: ' + extracted.line_items.length + ' items, $' + newSum.toFixed(2));
        }
      }

      // ── FIX: Last resort -- if total_before_adjustments suggests items still include a discount ──
      // Discounts/account balance lines are always the LAST items on a bill
      // If removing the last 1-2 items brings total closer to total_before_adjustments, they're discounts
      var targetTotal = extracted.total_before_adjustments || extracted._expectedTotal || 0;
      if (targetTotal > 0 && extracted.line_items.length > 3) {
        var currentSum = 0;
        extracted.line_items.forEach(function(item) { currentSum += (item.billed || 0); });
        var currentGap = Math.abs(currentSum - targetTotal);

        if (currentGap > targetTotal * 0.10) { // more than 10% off from expected
          // Try removing just the last item
          var lastItem = extracted.line_items[extracted.line_items.length - 1];
          var sumWithoutLast = currentSum - (lastItem.billed || 0);
          var gapWithoutLast = Math.abs(sumWithoutLast - targetTotal);

          if (gapWithoutLast < currentGap * 0.5) { // removing last item gets us at least 50% closer
            console.log('BOTTOM-OF-BILL: Removed last item as suspected discount: "' + lastItem.description + '" $' + (lastItem.billed || 0).toFixed(2) + ' (gap reduced from $' + currentGap.toFixed(2) + ' to $' + gapWithoutLast.toFixed(2) + ')');
            extracted.line_items.pop();
            currentSum = sumWithoutLast;
            currentGap = gapWithoutLast;

            // Try removing the new last item too (account balance after discount)
            if (currentGap > targetTotal * 0.05 && extracted.line_items.length > 3) {
              var nextLast = extracted.line_items[extracted.line_items.length - 1];
              var sumWithoutTwo = currentSum - (nextLast.billed || 0);
              var gapWithoutTwo = Math.abs(sumWithoutTwo - targetTotal);
              if (gapWithoutTwo < currentGap * 0.5) {
                console.log('BOTTOM-OF-BILL: Also removed: "' + nextLast.description + '" $' + (nextLast.billed || 0).toFixed(2));
                extracted.line_items.pop();
              }
            }
          }
        }
      }

      // Net charge/reversal pairs
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
          if (hasPos && hasNeg) {
            var maxPos = 0, maxNeg = 0;
            g.items.forEach(function(i) {
              if ((i.billed || 0) > maxPos) maxPos = i.billed;
              if ((i.billed || 0) < maxNeg) maxNeg = i.billed;
            });
            if (Math.abs(maxNeg) <= maxPos * 3) hasReversals = true;
          }
        }
      });
      if (hasReversals) {
        console.log('Charge/reversal pairs detected. Netting...');
        var netted = [];
        Object.keys(grouped).forEach(function(key) {
          var g = grouped[key];
          var hasPos = g.items.some(function(i) { return (i.billed || 0) > 0; });
          var hasNeg = g.items.some(function(i) { return (i.billed || 0) < 0; });
          if (hasPos && hasNeg) {
            var maxPos = 0, maxNeg = 0;
            g.items.forEach(function(i) {
              if ((i.billed || 0) > maxPos) maxPos = i.billed;
              if ((i.billed || 0) < maxNeg) maxNeg = i.billed;
            });
            if (Math.abs(maxNeg) <= maxPos * 3) {
              var netAmount = Math.round(g.netAmount * 100) / 100;
              if (Math.abs(netAmount) > 0.01) {
                var rep = JSON.parse(JSON.stringify(g.items[0]));
                rep.billed = netAmount;
                rep.quantity = 1;
                netted.push(rep);
              }
            } else {
              g.items.forEach(function(i) { if ((i.billed || 0) > 0) netted.push(i); });
            }
          } else {
            g.items.forEach(function(i) { netted.push(i); });
          }
        });
        console.log('Netted: ' + extracted.line_items.length + ' -> ' + netted.length + ' items');
        extracted.line_items = netted;
      }

      var chargeSum = 0;
      extracted.line_items.forEach(function(item) { chargeSum += (item.billed || 0); });
      if (chargeSum > 0 && Math.abs(chargeSum - extractedTotal) > extractedTotal * 0.1) {
        console.log('Recalculated total from charges: $' + chargeSum.toFixed(2) + ' (was $' + extractedTotal.toFixed(2) + ')');
        extractedTotal = chargeSum;
        extracted.total_billed = chargeSum;
      }
    }

    // ── Check for partial bill ──
    var partialBillNote = '';
    var finalLineItemSum = 0;
    (extracted.line_items || []).forEach(function(item) { finalLineItemSum += (item.billed || 0); });
    var finalGap = extractedTotal > 0 ? Math.abs(finalLineItemSum - extractedTotal) / extractedTotal : 0;
    if (finalGap > 0.30 && extractedTotal > finalLineItemSum && finalLineItemSum > 0) {
      console.log('PARTIAL BILL: Items sum $' + finalLineItemSum.toFixed(2) + ' vs stated total $' + extractedTotal.toFixed(2));
      // statedTotal already set above -- preserves the bill's printed total for enforcement
      partialBillNote = 'NOTE: This analysis covers $' + finalLineItemSum.toFixed(2) + ' of the $' + statedTotal.toFixed(2) + ' stated total on your bill. The remaining charges may be on pages that were not uploaded. Upload all pages for a complete analysis.';
      extractedTotal = finalLineItemSum;
      extracted.total_billed = finalLineItemSum;
      extracted.partial_bill = true;
      extracted.stated_total = statedTotal;
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
        var mapResponse = await withTimeout(
          client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            system: CPT_MAP_PROMPT,
            messages: [{ role: 'user', content: 'Map these: ' + JSON.stringify(descriptionsToMap) }],
          }),
          60000,
          'Haiku CPT mapping'
        );
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
    // STEP 2c: Summary bill detection
    // ════════════════════════════════════════════════════════════
    if (detectSummaryBill(extracted, enrichedItems)) {
      console.log('SUMMARY BILL DETECTED -- routing to summary response');
      var summaryDRG = billType === 'INPATIENT' ? estimateDRG(extracted, patientProcedure) : null;
      var summaryResult = buildSummaryBillResponse(extracted, enrichedItems, billType, totalBilled, summaryDRG);

      var hasDRGMatch = summaryDRG && summaryDRG.code !== 'UNKNOWN' && summaryDRG.payment > 0;
      var hasRange = summaryDRG && summaryDRG.code === 'RANGE' && summaryDRG.drg_range && summaryDRG.drg_range.high > 0;
      var analyticsCharges = (hasDRGMatch || hasRange) ? totalBilled : 0;
      var analyticsFairValue = hasDRGMatch ? summaryDRG.payment : (hasRange ? summaryDRG.drg_range.high : 0);
      var analyticsSavings = hasDRGMatch ? Math.max(0, totalBilled - summaryDRG.payment) : (hasRange ? Math.max(0, totalBilled - summaryDRG.drg_range.high) : 0);
      recordAnalytics(extracted, enrichedItems, billType, analyticsCharges, analyticsFairValue, analyticsSavings, 'PENDING', 0, summaryDRG);

      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(summaryResult) }] });
    }

    // ── Re-detect bill type after CPT mapping ──
    var hasERCode = enrichedItems.some(function(item) { return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0; });
    var hasObservation = enrichedItems.some(function(item) { return (item.description || '').toLowerCase().indexOf('observation') >= 0; });
    // Only flip to OUTPATIENT if there's no multi-day room (preserve ER-to-inpatient admissions)
    if (hasERCode && billType === 'INPATIENT') {
      var hasRoomCharges = enrichedItems.some(function(item) {
        var desc = (item.description || '').toLowerCase();
        return (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('r&b') >= 0 ||
                desc.indexOf('bed') >= 0 || desc.indexOf('nursing') >= 0) && item.billed > 1000;
      });
      if (!hasRoomCharges) {
        billType = 'OUTPATIENT';
        console.log('Bill type corrected to OUTPATIENT (ER code found, no room charges)');
      } else {
        console.log('Bill type stays INPATIENT (ER code found BUT room charges present -- ER-to-inpatient admission)');
      }
    }

    // ── Determine fair value based on bill type ──
    var estimatedFairValue = 0;
    var drgEstimate = null;
    var apcEstimate = null;

    if (billType === 'INPATIENT') {
      var drg = estimateDRG(extracted, patientProcedure);
      if (drg && drg.code !== 'UNKNOWN' && drg.payment > 0) {
        estimatedFairValue = drg.payment;
        var drgMarkup = totalBilled > 0 && drg.payment > 0 ? (totalBilled / drg.payment).toFixed(1) : '0';
        drgEstimate = { drg_code: drg.code, drg_description: drg.desc, drg_payment: drg.payment, markup_multiplier: drgMarkup + 'x' };
        console.log('DRG ' + drg.code + ': $' + drg.payment.toFixed(2) + ' (' + drgMarkup + 'x)');
        var drgFacilityItems = [];
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0) {
            var desc = (item.description || '').toLowerCase();
            if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('care unit') >= 0 ||
                desc.indexOf('nursing') >= 0 || desc.indexOf('progressive') >= 0 || desc.indexOf('icu') >= 0) {
              item.status = 'DRG_COVERED';
              item.type = 'facility_drg';
              drgFacilityItems.push(item);
            }
          }
        });
        if (drgFacilityItems.length > 0) {
          drgFacilityItems.sort(function(a, b) { return b.billed - a.billed; });
          // First facility item carries the DRG benchmark for fair value calculation
          drgFacilityItems[0].fair_rate = null;
          drgFacilityItems[0].total_fair = drg.payment;
          drgFacilityItems[0].markup_pct = '--';
          drgFacilityItems[0].note = 'Packaged into DRG ' + drg.code + ' (' + (drg.desc || '').split(' ').slice(0, 6).join(' ') + ') -- not separately payable';
          drgFacilityItems[0].status = 'DRG_COVERED';
          for (var di = 1; di < drgFacilityItems.length; di++) {
            drgFacilityItems[di].fair_rate = null;
            drgFacilityItems[di].total_fair = null;
            drgFacilityItems[di].markup_pct = '--';
            drgFacilityItems[di].note = 'Packaged into DRG ' + drg.code + ' -- not separately payable';
            drgFacilityItems[di].status = 'DRG_COVERED';
          }
        }
        // Tag no-code drug items as DRG-packaged (drugs are covered by DRG for inpatient)
        var drugKeywords = ['mg', 'ml', 'gm', 'mcg', 'inh', 'inj', 'tab', 'cap', 'sol', 'srt',
            'albuterol', 'heparin', 'saline', 'dextrose', 'sodium chloride', 'potassium',
            'fluticasone', 'prednisone', 'morphine', 'acetaminophen', 'ibuprofen',
            'ondansetron', 'famotidine', 'pantoprazole', 'metoprolol', 'lisinopril',
            'amoxicillin', 'azithromycin', 'ceftriaxone', 'vancomycin', 'insulin'];
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0 && !item.code && item.status !== 'DRG_COVERED') {
            var desc = (item.description || '').toLowerCase();
            var isDrug = false;
            for (var dk = 0; dk < drugKeywords.length; dk++) {
              if (desc.indexOf(drugKeywords[dk]) >= 0) { isDrug = true; break; }
            }
            if (isDrug) {
              item.fair_rate = null;
              item.total_fair = null;
              item.markup_pct = '--';
              item.note = 'Drug/supply charge -- packaged into DRG ' + drg.code + ' payment';
              item.status = 'DRG_COVERED';
              item.type = 'facility_drg';
            }
          }
        });
        // Zero out total_fair on CPT items -- DRG covers everything, individual rates are dispute evidence only
        enrichedItems.forEach(function(item) {
          if (item.status !== 'DRG_COVERED' && item.total_fair !== null && item.total_fair > 0) {
            item._display_fair = item.total_fair; // preserve for display
            item.total_fair = 0;
          }
        });
      } else if (drg && drg.code === 'RANGE' && drg.drg_range) {
        // RANGE DRG: use high end as conservative estimate + CPT rates
        var rangeHigh = drg.drg_range.high || 0;
        estimatedFairValue = rangeHigh > 0 ? rangeHigh : totalFairCPT;
        var rangeMarkup = totalBilled > 0 && rangeHigh > 0 ? (totalBilled / rangeHigh).toFixed(1) : 'N/A';
        drgEstimate = {
          drg_code: 'RANGE', drg_description: drg.desc,
          drg_payment: rangeHigh,
          drg_range_low: drg.drg_range.low, drg_range_high: rangeHigh,
          markup_multiplier: rangeMarkup + 'x'
        };
        console.log('DRG RANGE: $' + (drg.drg_range.low || 0) + '-$' + rangeHigh + ' (' + rangeMarkup + 'x)');
        // Mark room/board as covered by facility benchmark AND set fair_rate
        var rangeFacilityItems = [];
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0) {
            var desc = (item.description || '').toLowerCase();
            if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('care unit') >= 0 ||
                desc.indexOf('nursing') >= 0 || desc.indexOf('progressive') >= 0 || desc.indexOf('icu') >= 0) {
              item.status = 'DRG_COVERED';
              item.type = 'facility_drg';
              rangeFacilityItems.push(item);
            }
          }
        });
        if (rangeFacilityItems.length > 0 && rangeHigh > 0) {
          var rangeDesc = 'DRG estimate ($' + (drg.drg_range.low || 0).toLocaleString() + '-$' + rangeHigh.toLocaleString() + ')';
          rangeFacilityItems.sort(function(a, b) { return b.billed - a.billed; });
          rangeFacilityItems[0].fair_rate = null;
          rangeFacilityItems[0].total_fair = rangeHigh;
          rangeFacilityItems[0].markup_pct = '--';
          rangeFacilityItems[0].note = 'Packaged into ' + rangeDesc + ' -- not separately payable';
          rangeFacilityItems[0].status = 'DRG_COVERED';
          for (var ri = 1; ri < rangeFacilityItems.length; ri++) {
            rangeFacilityItems[ri].fair_rate = null;
            rangeFacilityItems[ri].total_fair = null;
            rangeFacilityItems[ri].markup_pct = '--';
            rangeFacilityItems[ri].note = 'Packaged into ' + rangeDesc + ' -- not separately payable';
            rangeFacilityItems[ri].status = 'DRG_COVERED';
          }
        }
      } else {
        // UNKNOWN DRG or no DRG match: add generic facility benchmark to CPT rates
        // Calculate total room/facility charges on the bill
        var facilityCharges = 0;
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0) {
            var desc = (item.description || '').toLowerCase();
            if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('care') >= 0 ||
                desc.indexOf('nursing') >= 0 || desc.indexOf('progressive') >= 0 || desc.indexOf('icu') >= 0 ||
                desc.indexOf('recovery') >= 0 || desc.indexOf('or services') >= 0 || desc.indexOf('operating') >= 0 ||
                desc.indexOf('anesthesia') >= 0 || desc.indexOf('emerg') >= 0) {
              facilityCharges += item.billed;
            }
          }
        });

        // Use generic DRG benchmarks based on surgical vs medical
        var isSurgicalBill = enrichedItems.some(function(item) {
          var desc = (item.description || '').toLowerCase();
          return desc.indexOf('or services') >= 0 || desc.indexOf('operating') >= 0 ||
                 desc.indexOf('surgery') >= 0 || desc.indexOf('anesthesia') >= 0 || desc.indexOf('recovery room') >= 0;
        });

        // CMS 2026 median DRG benchmarks (conservative estimates)
        var genericFacilityBenchmark = isSurgicalBill ? 8000 : 5000; // Surgical vs Medical median
        estimatedFairValue = totalFairCPT + genericFacilityBenchmark;

        var genericDesc = isSurgicalBill ?
          'Estimated surgical admission facility benchmark (median Medicare DRG for surgical admissions)' :
          'Estimated medical admission facility benchmark (median Medicare DRG for medical admissions)';
        var genericMarkup = totalBilled > 0 ? (totalBilled / estimatedFairValue).toFixed(1) : 'N/A';
        drgEstimate = {
          drg_code: 'ESTIMATED', drg_description: genericDesc,
          drg_payment: genericFacilityBenchmark,
          markup_multiplier: genericMarkup + 'x',
          note: 'Exact DRG could not be determined. Using conservative Medicare median. Tell us your diagnosis or procedure for a precise benchmark.'
        };
        console.log('GENERIC facility benchmark: $' + genericFacilityBenchmark + ' (' + (isSurgicalBill ? 'surgical' : 'medical') + ') + CPT $' + totalFairCPT.toFixed(2));

        // Mark facility items AND set fair_rate to generic benchmark
        var unknownFacilityItems = [];
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0) {
            var desc = (item.description || '').toLowerCase();
            if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('care') >= 0 ||
                desc.indexOf('nursing') >= 0 || desc.indexOf('progressive') >= 0 || desc.indexOf('icu') >= 0) {
              item.status = 'DRG_COVERED';
              item.type = 'facility_drg';
              unknownFacilityItems.push(item);
            }
          }
        });
        if (unknownFacilityItems.length > 0) {
          var estDesc = isSurgicalBill ? 'estimated surgical DRG' : 'estimated medical DRG';
          unknownFacilityItems.sort(function(a, b) { return b.billed - a.billed; });
          unknownFacilityItems[0].fair_rate = null;
          unknownFacilityItems[0].total_fair = genericFacilityBenchmark;
          unknownFacilityItems[0].markup_pct = '--';
          unknownFacilityItems[0].note = 'Packaged into ' + estDesc + ' benchmark ($' + genericFacilityBenchmark.toLocaleString() + ') -- not separately payable. Provide procedure details for exact DRG.';
          unknownFacilityItems[0].status = 'DRG_COVERED';
          for (var ui = 1; ui < unknownFacilityItems.length; ui++) {
            unknownFacilityItems[ui].fair_rate = null;
            unknownFacilityItems[ui].total_fair = null;
            unknownFacilityItems[ui].markup_pct = '--';
            unknownFacilityItems[ui].note = 'Packaged into ' + estDesc + ' -- not separately payable';
            unknownFacilityItems[ui].status = 'DRG_COVERED';
          }
        }
      }
    } else {
      estimatedFairValue = totalFairCPT;
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
      if (!erFeeAdded && hasERCode) {
        var erCode = enrichedItems.find(function(item) { return ['99281','99282','99283','99284','99285'].indexOf(item.code) >= 0; });
        if (erCode) {
          var hardcodedAPC = { '99285': 814, '99284': 531, '99283': 330, '99282': 188, '99281': 79 };
          var hcApcPayment = hardcodedAPC[erCode.code] || 531;
          estimatedFairValue += hcApcPayment;
          apcEstimate = { apc_description: 'ER facility fee estimate (ED Level ' + erCode.code.slice(-1) + ')', apc_payment: hcApcPayment };
          erFeeAdded = true;
        }
      }
      if (hasObservation && !(apcEstimate && apcEstimate.observation_payment)) {
        var hcObsPayment = 2846;
        estimatedFairValue += hcObsPayment;
        if (apcEstimate) {
          apcEstimate.observation_apc = 'Comprehensive Observation Services (estimated)';
          apcEstimate.observation_payment = hcObsPayment;
          apcEstimate.apc_payment += hcObsPayment;
        } else {
          apcEstimate = { apc_description: 'Comprehensive Observation Services (estimated)', apc_payment: hcObsPayment, observation_payment: hcObsPayment };
        }
      }
      if (erFeeAdded || hasObservation) {
        var facilityItems = [];
        enrichedItems.forEach(function(item) {
          if (item.fair_rate === null && item.billed > 0) {
            var desc = (item.description || '').toLowerCase();
            if (desc.indexOf('room') >= 0 || desc.indexOf('board') >= 0 || desc.indexOf('care unit') >= 0 ||
                desc.indexOf('progressive') >= 0 || desc.indexOf('observation') >= 0 || desc.indexOf('nursing') >= 0) {
              item.status = 'APC_COVERED';
              item.type = 'facility_apc';
              facilityItems.push(item);
            }
          }
        });
        if (facilityItems.length > 0 && apcEstimate) {
          var totalApcRate = apcEstimate.apc_payment || 0;
          facilityItems.sort(function(a, b) { return b.billed - a.billed; });
          facilityItems[0].fair_rate = totalApcRate;
          facilityItems[0].total_fair = totalApcRate;
          facilityItems[0].markup_pct = totalApcRate > 0 ? Math.round((facilityItems[0].billed / totalApcRate - 1) * 100) + '%' : 'N/A';
          facilityItems[0].note = 'Medicare APC benchmark for all facility services combined';
          for (var fi = 1; fi < facilityItems.length; fi++) {
            facilityItems[fi].fair_rate = 0;
            facilityItems[fi].total_fair = 0;
            facilityItems[fi].markup_pct = 'NOT ALLOWED';
            facilityItems[fi].note = 'NOT SEPARATELY PAYABLE -- packaged into APC facility fee. Dispute this charge.';
            facilityItems[fi].status = 'FLAG';
          }
          var totalFacilityBilled = 0;
          facilityItems.forEach(function(fi) { totalFacilityBilled += fi.billed; });
          if (totalFacilityBilled > totalApcRate) {
            highCount++;
            apcEstimate.facility_total_billed = totalFacilityBilled;
            apcEstimate.facility_overcharge = Math.max(0, Math.round((totalFacilityBilled - totalApcRate) * 100) / 100);
            apcEstimate.facility_items = facilityItems.map(function(fi) { return fi.description + ': $' + fi.billed.toFixed(2); });
          }
        }
      }
    }

    var potentialSavings = Math.max(0, Math.round((totalBilled - estimatedFairValue) * 100) / 100);
    if (potentialSavings === 0 && (highCount + medCount + lowCount) > 0) {
      var itemSavings = 0;
      enrichedItems.forEach(function(item) {
        if (item.savings && item.savings > 0) itemSavings += item.savings;
      });
      if (itemSavings > 0) {
        potentialSavings = Math.round(itemSavings * 100) / 100;
        estimatedFairValue = Math.round((totalBilled - potentialSavings) * 100) / 100;
        console.log('Fair value exceeded billed. Using individual item savings: $' + potentialSavings.toFixed(2));
      }
    }

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
          .map(function(i) { return i.description + ': billed $' + i.billed + ' vs fair $' + (i.total_fair || 'N/A'); }),
        partial_bill_note: partialBillNote
      };
      var gradeResponse = await withTimeout(
        client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: GRADE_PROMPT,
          messages: [{ role: 'user', content: 'Grade this bill:\n' + JSON.stringify(gradeInput) }],
        }),
        60000,
        'Haiku grading'
      );
      var gradeRaw = gradeResponse.content.map(function(b) { return b.text || ''; }).join('');
      gradeRaw = gradeRaw.replace(/```json|```/g, '').trim();
      var gs = gradeRaw.indexOf('{');
      var ge = gradeRaw.lastIndexOf('}');
      var grade = JSON.parse(gradeRaw.slice(gs, ge + 1));
      grade.total_billed = totalBilled;
      grade.estimated_fair_value = estimatedFairValue;
      grade.potential_savings = potentialSavings;
      recordAnalytics(extracted, enrichedItems, billType, totalBilled, estimatedFairValue, potentialSavings, grade.grade, issueCount, drgEstimate);
      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(grade) }] });
    }

    // ════════════════════════════════════════════════════════════
    // STEP 3b: Full report (Sonnet)
    // ════════════════════════════════════════════════════════════
    console.log('Step 3b: Generating report with Sonnet...');
    var unmappedCharges = 0;
    var unmappedDescriptions = [];
    var facilityCoveredCharges = 0;
    var facilityCoveredDescriptions = [];
    enrichedItems.forEach(function(item) {
      if (item.fair_rate === null && item.billed > 0) {
        if (item.type === 'facility_apc' || item.type === 'facility_drg') {
          facilityCoveredCharges += item.billed;
          facilityCoveredDescriptions.push(item.description + ': $' + item.billed.toFixed(2));
        } else {
          unmappedCharges += item.billed;
          unmappedDescriptions.push(item.description + ': $' + item.billed.toFixed(2));
        }
      }
    });
    var benchmarkedCharges = totalBilled - unmappedCharges;

    var coverageNote = '';
    if (facilityCoveredCharges > 0 && apcEstimate) {
      coverageNote += 'FACILITY CHARGES: The hospital billed $' + facilityCoveredCharges.toFixed(2) + ' for facility services (' +
        facilityCoveredDescriptions.join(', ') + '). Under Medicare APC rules, these are packaged into the facility fee. ' +
        'Medicare would pay approximately $' + apcEstimate.apc_payment.toFixed(2) + ' total. ';
    }
    if (facilityCoveredCharges > 0 && drgEstimate && drgEstimate.drg_code !== 'UNKNOWN') {
      coverageNote += 'FACILITY CHARGES: The hospital billed $' + facilityCoveredCharges.toFixed(2) + ' for facility services. ' +
        'Under Medicare DRG rules, ALL facility services are covered by the DRG payment of $' + drgEstimate.drg_payment.toFixed(2) + '. ';
    }
    if (unmappedCharges > 0) {
      coverageNote += 'NOTE: $' + unmappedCharges.toFixed(2) + ' in charges (' + Math.round(unmappedCharges / totalBilled * 100) +
        '% of total) could not be benchmarked (' + unmappedDescriptions.slice(0, 5).join(', ') + '). ' +
        'Request an itemized bill with CPT codes for a complete analysis.';
    }

    var reportInput = {
      bill_type: billType, hospital: extracted.hospital || '', state: state, city: city,
      date_of_service: extracted.date_of_service || '', total_billed: totalBilled,
      estimated_fair_value: estimatedFairValue, potential_savings: potentialSavings,
      overcharge_pct: overchargePct, drg_estimate: drgEstimate, apc_estimate: apcEstimate,
      line_items: enrichedItems,
      issue_counts: { high: highCount, medium: medCount, low: lowCount, total: issueCount },
      unmapped_charges: unmappedCharges,
      facility_covered_charges: facilityCoveredCharges,
      benchmarked_charges: benchmarkedCharges,
      unmapped_descriptions: unmappedDescriptions.slice(0, 10),
      coverage_note: coverageNote,
      partial_bill_note: partialBillNote
    };

    var reportResponse = await withTimeout(
      client.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 8000, system: REPORT_PROMPT,
        messages: [{ role: 'user', content: 'Write the analysis report:\n\n' + JSON.stringify(reportInput, null, 2) }],
      }),
      90000,
      'Sonnet report'
    );

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
      var defaultNote;
      if (item.type === 'facility_drg') { defaultNote = 'Facility charge -- covered by DRG benchmark'; }
      else if (item.type === 'facility_apc') { defaultNote = 'Facility charge -- covered by APC benchmark'; }
      else if (item.type === 'drug') { defaultNote = 'Drug/solution charge -- Medicare ASP+6% benchmark'; }
      else if (item.status === 'FLAG' && item.fair_rate !== null) {
        var mPct = item.total_fair > 0 ? Math.round((item.billed / item.total_fair - 1) * 100) : 0;
        defaultNote = 'Overcharged ' + mPct + '% above Medicare rate -- DISPUTE';
      } else if (item.fair_rate !== null && item.status === 'OK') { defaultNote = 'Within expected range of Medicare rate'; }
      else if (item.billed > 0 && !item.code) { defaultNote = 'No CPT code provided -- request itemized bill with procedure codes'; }
      else if (item.billed > 0 && item.type === 'unknown') { defaultNote = 'Code not in CMS database -- request clarification from billing department'; }
      else { defaultNote = 'Unable to benchmark -- request itemized bill with CPT codes'; }
      return {
        code: item.code, description: item.description, billed: item.billed,
        quantity: item.quantity, fair_rate: item.fair_rate, total_fair: item.total_fair,
        markup_pct: item.markup_pct, status: item.status,
        note: item.note || defaultNote
      };
    });

    recordAnalytics(extracted, enrichedItems, billType, totalBilled, estimatedFairValue, potentialSavings, report.grade, issueCount, drgEstimate);

    // ── DRG ENFORCEMENT: if we have a known DRG, fair value IS the DRG payment ──
    // This is the safety net -- no matter what Sonnet writes or how the UI computes,
    // the DRG benchmark is the final word on fair value for inpatient bills
    if (drgEstimate && drgEstimate.drg_code && drgEstimate.drg_code !== 'UNKNOWN' && drgEstimate.drg_code !== 'ESTIMATED' && drgEstimate.drg_code !== 'RANGE' && drgEstimate.drg_payment > 0) {
      report.estimated_fair_value = drgEstimate.drg_payment;
      report.potential_savings = Math.max(0, Math.round((report.total_billed - drgEstimate.drg_payment) * 100) / 100);
      console.log('DRG ENFORCEMENT: fair_value=$' + drgEstimate.drg_payment.toFixed(2) + ', savings=$' + report.potential_savings.toFixed(2));
    }

    // ── GRADE ENFORCEMENT: grade must match the actual overcharge percentage ──
    var enforcedOverchargePct = report.total_billed > 0 ? Math.round((report.potential_savings / report.total_billed) * 100) : 0;
    var correctGrade;
    if (enforcedOverchargePct < 10) correctGrade = 'A';
    else if (enforcedOverchargePct < 25) correctGrade = 'B';
    else if (enforcedOverchargePct < 50) correctGrade = 'C';
    else if (enforcedOverchargePct < 75) correctGrade = 'D';
    else correctGrade = 'F';
    if (report.grade && report.grade !== correctGrade) {
      console.log('GRADE ENFORCEMENT: ' + report.grade + ' -> ' + correctGrade + ' (' + enforcedOverchargePct + '%)');
      report.grade = correctGrade;
    }

    // ── NARRATIVE ENFORCEMENT: summary must match the enforced numbers ──
    // Sonnet sometimes invents its own totals in the narrative text.
    // Strip any sentence with wrong dollar amounts and append the correct closing.
    if (report.summary) {
      var enforcedBilled = report.total_billed;
      var enforcedFair = report.estimated_fair_value;
      var enforcedSavings = report.potential_savings;
      var sentences = report.summary.split(/(?<=\.)\s+/);
      var cleaned = sentences.filter(function(s) {
        var lower = s.toLowerCase();
        // Remove sentences that state wrong total savings or wrong bill totals
        if ((lower.indexOf('total potential savings') >= 0 || lower.indexOf('total savings') >= 0 ||
             lower.indexOf('overall savings') >= 0 || lower.indexOf('out of a $') >= 0) &&
            s.indexOf('$' + enforcedSavings.toLocaleString()) < 0 && s.indexOf('$' + enforcedBilled.toLocaleString()) < 0) {
          console.log('NARRATIVE STRIP: ' + s.substring(0, 80));
          return false;
        }
        // Remove sentences that claim a different total bill amount
        var dollarMatches = s.match(/\$[\d,]+\.?\d*/g) || [];
        for (var dm = 0; dm < dollarMatches.length; dm++) {
          var val = parseFloat(dollarMatches[dm].replace(/[$,]/g, ''));
          // If a sentence claims to be the total bill but uses a wrong number
          if ((lower.indexOf('total bill') >= 0 || lower.indexOf('total charge') >= 0 || lower.indexOf('your bill of') >= 0) &&
              val > 1000 && Math.abs(val - enforcedBilled) > 100 && Math.abs(val - enforcedSavings) > 100 && Math.abs(val - enforcedFair) > 100) {
            console.log('NARRATIVE STRIP (wrong total): ' + s.substring(0, 80));
            return false;
          }
        }
        return true;
      });
      // Append the correct closing sentence
      var drgNote = drgEstimate && drgEstimate.drg_code && drgEstimate.drg_code !== 'UNKNOWN' && drgEstimate.drg_code !== 'ESTIMATED' && drgEstimate.drg_code !== 'RANGE' ?
        ' Under Medicare DRG ' + drgEstimate.drg_code + ', the fair value for this entire admission is $' + enforcedFair.toLocaleString() + '.' : '';
      cleaned.push('Your total bill of $' + enforcedBilled.toLocaleString() + ' has $' + enforcedSavings.toLocaleString() + ' in potential savings.' + drgNote);
      report.summary = cleaned.join(' ');
      console.log('NARRATIVE ENFORCED: ' + report.summary.substring(report.summary.length - 120));
    }

    // ── FINAL ENFORCEMENT: total_billed MUST match the bill's stated total ──
    // The customer holds the bill -- if our number differs, we lose all credibility
    var finalResult = { content: [{ type: 'text', text: JSON.stringify(report) }] };
    if (statedTotal && statedTotal > 0 && report.total_billed !== statedTotal) {
      console.log('ENFORCING total_billed: report shows $' + report.total_billed + ' but bill states $' + statedTotal);
      report.total_billed = statedTotal;
      report.potential_savings = Math.max(0, Math.round((statedTotal - report.estimated_fair_value) * 100) / 100);
      finalResult = { content: [{ type: 'text', text: JSON.stringify(report) }] };
    }

    return res.status(200).json(finalResult);

  } catch (err) {
    console.error('analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
