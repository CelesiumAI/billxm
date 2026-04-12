/**
 * BillXM Harness — Bill Validator
 *
 * Validates that OCR'd text actually looks like a medical bill.
 * Must contain at least 2 of:
 *   - Dollar amounts ($)
 *   - CPT/HCPCS codes (5-digit patterns)
 *   - Medical terms (hospital, patient, charges, diagnosis, procedure, etc.)
 *   - Date patterns (MM/DD/YYYY, etc.)
 */

// Dollar amounts: $1,234.56 or $50.00 etc.
const DOLLAR_PATTERN = /\$\s?\d[\d,]*\.?\d{0,2}/g;

// CPT/HCPCS codes: 5-digit numeric codes, or alpha + 4 digits (J-codes, etc.)
const CPT_PATTERN = /\b[A-Z]?\d{4,5}\b/g;

// Medical terms (case-insensitive)
const MEDICAL_TERMS = [
  'hospital', 'patient', 'charges', 'charge', 'diagnosis', 'procedure',
  'insurance', 'copay', 'co-pay', 'deductible', 'coinsurance',
  'emergency', 'physician', 'medical', 'clinical', 'laboratory',
  'radiology', 'pharmacy', 'surgical', 'anesthesia', 'room',
  'inpatient', 'outpatient', 'admission', 'discharge', 'billing',
  'account', 'balance', 'amount due', 'total', 'subtotal',
  'date of service', 'provider', 'facility', 'health', 'treatment',
  'claim', 'explanation of benefits', 'eob', 'itemized', 'statement',
  'cpt', 'hcpcs', 'icd', 'npi', 'cms'
];

// Date patterns: MM/DD/YYYY, MM-DD-YYYY, MM/DD/YY, YYYY-MM-DD, etc.
const DATE_PATTERN = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g;

function validateBillText(text) {
  if (!text || text.trim().length < 20) {
    return { valid: false, reason: 'OCR output is empty or too short', signals: 0, details: {} };
  }

  const lower = text.toLowerCase();
  let signals = 0;
  const details = {};

  // 1. Dollar amounts
  const dollars = text.match(DOLLAR_PATTERN) || [];
  if (dollars.length >= 1) {
    signals++;
    details.dollar_amounts = dollars.length;
  }

  // 2. CPT/HCPCS codes
  const cptMatches = text.match(CPT_PATTERN) || [];
  // Filter out common false positives (years, zip codes in context)
  const cptCodes = cptMatches.filter(m => {
    const n = parseInt(m.replace(/[A-Z]/gi, ''), 10);
    // CPT codes are 00100-99499; HCPCS are A0000-V9999
    if (/^[A-Z]\d{4}$/i.test(m)) return true; // HCPCS like J1234
    return n >= 100 && (n < 1900 || n > 2100) && n < 100000; // skip years
  });
  if (cptCodes.length >= 1) {
    signals++;
    details.cpt_codes = cptCodes.length;
  }

  // 3. Medical terms
  const foundTerms = MEDICAL_TERMS.filter(term => lower.includes(term));
  if (foundTerms.length >= 3) {
    signals++;
    details.medical_terms = foundTerms.length;
    details.matched_terms = foundTerms.slice(0, 10);
  }

  // 4. Date patterns
  const dates = text.match(DATE_PATTERN) || [];
  if (dates.length >= 1) {
    signals++;
    details.dates = dates.length;
  }

  const valid = signals >= 2;
  const reason = valid
    ? null
    : `OCR output does not appear to be a medical bill (only ${signals}/2 required signals found)`;

  return { valid, reason, signals, details };
}

module.exports = { validateBillText };
