/**
 * BillXM Harness — Post-Analysis Flagger
 *
 * Applies flagging rules to a completed analysis result.
 * Returns an array of flag reasons (empty = no flags).
 *
 * Flagging rules (from spec):
 *  - OCR confidence below threshold
 *  - Analysis returned 0 line items
 *  - Analysis returned 0 issues on a bill over $10,000
 *  - Potential savings is $0 on a bill with identifiable CPT codes
 *  - Any analysis error or timeout
 */

const fs = require('fs');
const path = require('path');

const { CONFIG_PATH } = require('./paths');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}

/**
 * Check a completed bill result for flagging conditions.
 *
 * @param {object} metadata   - The metadata.json contents
 * @param {object|null} analysis - The analysis.json contents (null if analysis failed)
 * @returns {string[]} Array of flag reason strings (empty = passed)
 */
function checkFlags(metadata, analysis) {
  const config = loadConfig();
  const reviewConfig = config.review || {};
  const flags = [];

  // Rule 1: Analysis failed entirely
  if (!metadata.analysis_completed) {
    flags.push('Analysis did not complete (error or timeout)');
    return flags; // No point checking further
  }

  if (!analysis) {
    flags.push('Analysis result file is missing');
    return flags;
  }

  const lineItems = analysis.line_items || [];
  const issues = analysis.issues || [];
  const totalBilled = analysis.total_billed || 0;
  const savings = analysis.potential_savings || 0;
  const grade = analysis.grade || '';

  // Rule 2: 0 line items (engine couldn't parse)
  if (reviewConfig.flag_if_zero_line_items !== false && lineItems.length === 0) {
    flags.push('Analysis returned 0 line items — engine could not parse the bill');
  }

  // Rule 3: 0 issues on a large bill (suspicious — likely missed something)
  const bigBillThreshold = reviewConfig.flag_if_zero_issues_above || 10000;
  if (issues.length === 0 && totalBilled > bigBillThreshold) {
    flags.push(`0 issues found on a $${totalBilled.toLocaleString()} bill (threshold: $${bigBillThreshold.toLocaleString()}) — likely missed something`);
  }

  // Rule 4: $0 savings on a bill with identifiable CPT codes
  if (reviewConfig.flag_if_savings_zero_with_cpt !== false) {
    const hasCptCodes = lineItems.some(item => {
      const code = (item.code || '').toString().trim();
      return code.length >= 4 && code.length <= 5;
    });
    if (hasCptCodes && savings === 0) {
      flags.push('Potential savings is $0 despite identifiable CPT codes — review for missed overcharges');
    }
  }

  // Rule 5: Unusually high total (>$500K) — may be data extraction error
  if (totalBilled > 500000) {
    flags.push(`Total billed is unusually high: $${totalBilled.toLocaleString()} — verify extraction accuracy`);
  }

  // Rule 6: Unusually low total (<$50) — may be partial bill or OCR error
  if (totalBilled > 0 && totalBilled < 50) {
    flags.push(`Total billed is unusually low: $${totalBilled.toFixed(2)} — may be partial bill or OCR error`);
  }

  // Rule 7: IMAGE_UNREADABLE or PENDING grade from engine fallback
  if (analysis.report_type === 'IMAGE_UNREADABLE' || grade === 'PENDING') {
    flags.push('Engine returned IMAGE_UNREADABLE or PENDING — bill could not be fully analyzed');
  }

  return flags;
}

module.exports = { checkFlags };
