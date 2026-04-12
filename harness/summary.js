/**
 * BillXM Harness — Daily Summary Generator
 *
 * Scans harness/results/ and harness/flagged/ for today's bills,
 * generates a Markdown summary report in harness/logs/daily_summary_{date}.md
 */

const fs = require('fs');
const path = require('path');

const HARNESS_ROOT = path.resolve(__dirname);
const RESULTS = path.join(HARNESS_ROOT, 'results');
const FLAGGED = path.join(HARNESS_ROOT, 'flagged');
const LOGS = path.join(HARNESS_ROOT, 'logs');

/**
 * Generate the daily summary for a given date (defaults to today).
 * @param {string} [date] - Date string YYYY-MM-DD
 * @param {function} [log] - Optional logger function
 * @returns {string} Path to the generated summary file
 */
function generateDailySummary(date, log) {
  if (!date) date = new Date().toISOString().slice(0, 10);
  if (!log) log = console.log;

  log(`Generating daily summary for ${date}...`);

  // ── Collect results ───────────────────────────────────────────
  const resultDirs = [];
  try {
    const entries = fs.readdirSync(RESULTS);
    for (const entry of entries) {
      if (entry.startsWith(date)) {
        const metaPath = path.join(RESULTS, entry, 'metadata.json');
        const analysisPath = path.join(RESULTS, entry, 'analysis.json');
        let meta = null, analysis = null;
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
        try { analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8')); } catch (_) {}
        if (meta) resultDirs.push({ folder: entry, meta, analysis });
      }
    }
  } catch (_) {}

  // ── Collect flagged bills ─────────────────────────────────────
  const flaggedFiles = [];
  try {
    const entries = fs.readdirSync(FLAGGED);
    for (const entry of entries) {
      if (entry.startsWith(date) && entry.endsWith('_flag.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(FLAGGED, entry), 'utf8'));
          flaggedFiles.push({ file: entry, ...data });
        } catch (_) {}
      } else if (entry.startsWith(date) && entry.endsWith('_error.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(FLAGGED, entry), 'utf8'));
          flaggedFiles.push({ file: entry, reason: `Error: ${data.error}`, ...data });
        } catch (_) {}
      }
    }
  } catch (_) {}

  // ── Compute stats ─────────────────────────────────────────────
  const bySource = {};
  const grades = {};
  const analyzed = [];
  const analysisErrors = [];
  const postAnalysisFlags = [];
  let totalSavings = 0;
  let totalBilled = 0;

  for (const r of resultDirs) {
    const src = r.meta.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;

    if (r.meta.analysis_completed && r.analysis) {
      const a = r.analysis;
      const grade = a.grade || 'N/A';
      grades[grade] = (grades[grade] || 0) + 1;
      totalBilled += (a.total_billed || 0);
      totalSavings += (a.potential_savings || 0);

      analyzed.push({
        folder: r.folder,
        grade,
        total_billed: a.total_billed || 0,
        savings: a.potential_savings || 0,
        issues: (a.issues || []).length,
        line_items: (a.line_items || []).length,
        hospital: a.hospital || ''
      });

      // Collect post-analysis flags from metadata (set by flagger.js)
      const metaFlags = (r.meta.flags && r.meta.flags.length > 0) ? r.meta.flags : [];

      // Add summary-only edge cases not covered by flagger
      const extraFlags = [];
      const hasCpt = (a.line_items || []).some(i => {
        const code = (i.code || '').toString().trim();
        return code.length >= 4;
      });
      if (!hasCpt && (a.line_items || []).length > 0) {
        extraFlags.push('No CPT/HCPCS codes identified — possible OCR quality issue');
      }

      const allFlags = [...metaFlags, ...extraFlags];
      if (allFlags.length > 0) {
        postAnalysisFlags.push({ folder: r.folder, flags: allFlags });
      }
    } else {
      analysisErrors.push({ folder: r.folder, source: src });
    }
  }

  // ── Build markdown ────────────────────────────────────────────
  const lines = [];
  lines.push(`# BillXM Harness — Daily Summary for ${date}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Overview
  lines.push('## Overview');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Bills processed today | ${resultDirs.length} |`);
  lines.push(`| Successfully analyzed | ${analyzed.length} |`);
  lines.push(`| Analysis errors | ${analysisErrors.length} |`);
  lines.push(`| Flagged (OCR/validation) | ${flaggedFiles.length} |`);
  lines.push(`| Post-analysis flags | ${postAnalysisFlags.length} |`);
  lines.push(`| Total billed | $${Math.round(totalBilled).toLocaleString()} |`);
  lines.push(`| Total potential savings | $${Math.round(totalSavings).toLocaleString()} |`);
  lines.push('');

  // By source
  if (Object.keys(bySource).length > 0) {
    lines.push('## Bills by Source');
    lines.push('');
    lines.push('| Source | Count |');
    lines.push('|--------|-------|');
    for (const [src, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${src} | ${count} |`);
    }
    lines.push('');
  }

  // Grade distribution
  if (Object.keys(grades).length > 0) {
    lines.push('## Grade Distribution');
    lines.push('');
    lines.push('| Grade | Count |');
    lines.push('|-------|-------|');
    for (const g of ['A', 'B', 'C', 'D', 'F', 'PENDING', 'N/A']) {
      if (grades[g]) lines.push(`| ${g} | ${grades[g]} |`);
    }
    // Any other grades not in the standard list
    for (const [g, count] of Object.entries(grades)) {
      if (!['A', 'B', 'C', 'D', 'F', 'PENDING', 'N/A'].includes(g)) {
        lines.push(`| ${g} | ${count} |`);
      }
    }
    lines.push('');
  }

  // Analyzed bills detail
  if (analyzed.length > 0) {
    lines.push('## Analyzed Bills');
    lines.push('');
    lines.push('| Folder | Grade | Billed | Savings | Issues | Items | Hospital |');
    lines.push('|--------|-------|--------|---------|--------|-------|----------|');
    for (const a of analyzed.sort((x, y) => y.total_billed - x.total_billed)) {
      lines.push(`| ${a.folder} | ${a.grade} | $${Math.round(a.total_billed).toLocaleString()} | $${Math.round(a.savings).toLocaleString()} | ${a.issues} | ${a.line_items} | ${a.hospital} |`);
    }
    lines.push('');
  }

  // Flagged (OCR/validation stage)
  if (flaggedFiles.length > 0) {
    lines.push('## Flagged Bills (OCR/Validation)');
    lines.push('');
    for (const f of flaggedFiles) {
      lines.push(`- **${f.file}**: ${f.reason || 'Unknown reason'}`);
    }
    lines.push('');
  }

  // Post-analysis flags
  if (postAnalysisFlags.length > 0) {
    lines.push('## Post-Analysis Flags (Review Needed)');
    lines.push('');
    for (const pf of postAnalysisFlags) {
      lines.push(`- **${pf.folder}**:`);
      for (const flag of pf.flags) {
        lines.push(`  - ${flag}`);
      }
    }
    lines.push('');
  }

  // Analysis errors
  if (analysisErrors.length > 0) {
    lines.push('## Analysis Errors');
    lines.push('');
    for (const e of analysisErrors) {
      lines.push(`- **${e.folder}** (source: ${e.source})`);
    }
    lines.push('');
  }

  // Quality indicators
  lines.push('## Quality Indicators');
  lines.push('');
  const zeroSavings = analyzed.filter(a => a.savings === 0);
  const zeroIssues = analyzed.filter(a => a.issues === 0);
  const highBills = analyzed.filter(a => a.total_billed > 500000);
  const lowBills = analyzed.filter(a => a.total_billed > 0 && a.total_billed < 50);
  lines.push(`- Bills with $0 potential savings: ${zeroSavings.length}`);
  lines.push(`- Bills with 0 issues found: ${zeroIssues.length}`);
  lines.push(`- Bills over $500K (verify accuracy): ${highBills.length}`);
  lines.push(`- Bills under $50 (verify completeness): ${lowBills.length}`);
  lines.push('');

  // Write file
  const content = lines.join('\n');
  fs.mkdirSync(LOGS, { recursive: true });
  const summaryPath = path.join(LOGS, `daily_summary_${date}.md`);
  fs.writeFileSync(summaryPath, content);

  log(`Daily summary written: ${summaryPath}`);
  log(`  ${resultDirs.length} processed, ${analyzed.length} analyzed, ${flaggedFiles.length} flagged, ${postAnalysisFlags.length} post-analysis flags`);

  return summaryPath;
}

module.exports = { generateDailySummary };
