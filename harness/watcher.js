/**
 * BillXM Harness — Inbox Watcher
 *
 * Watches harness/inbox/ for new image/PDF files.
 * When a file appears it is moved to harness/processing/,
 * then OCR'd, validated, and (in Step 3) analyzed.
 */

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { extractText, terminate: terminateOcr } = require('./ocr');
const { validateBillText } = require('./validator');
const { analyzeBill } = require('./analyze');
const { checkFlags } = require('./flagger');

const { HARNESS_ROOT, CONFIG_PATH, INBOX, PROCESSING, RESULTS, FLAGGED, LOGS } = require('./paths');

const VALID_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.pdf', '.webp']);

// Simple logger that writes to console and a log file
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  const logFile = path.join(LOGS, `harness_${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

// Derive a result folder name from the filename
// Expected format: {date}_{source}_{id}.{ext}  e.g. 2026-04-12_reddit_abc123.png
// For manually dropped files: {date}_manual_{sanitized-name}
function resultFolderName(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  // If the file already follows the convention, use it directly
  if (/^\d{4}-\d{2}-\d{2}_\w+_.+$/.test(base)) {
    return base;
  }

  // Otherwise, treat as a manual drop
  const date = new Date().toISOString().slice(0, 10);
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
  return `${date}_manual_${sanitized}`;
}

// Move a file safely (copy + delete to work across drives/volumes)
// Retries on ENOENT to handle OneDrive sync lag
async function moveFile(src, dest) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.copyFile(src, dest);
      await fs.promises.unlink(src);
      return;
    } catch (err) {
      if (err.code === 'ENOENT' && attempt < 4) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

async function processBill(filePath) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();

  if (!VALID_EXTENSIONS.has(ext)) {
    log(`SKIP  ${filename} — unsupported extension "${ext}"`);
    return;
  }

  log(`INBOX ${filename} — new file detected`);

  // 1. Move to processing/
  const processingPath = path.join(PROCESSING, filename);
  try {
    await moveFile(filePath, processingPath);
  } catch (err) {
    log(`ERROR moving ${filename} to processing: ${err.message}`);
    return;
  }
  log(`MOVE  ${filename} → processing/`);

  // 2. OCR extraction
  log(`OCR   ${filename} — extracting text...`);
  let ocrResult;
  try {
    ocrResult = await extractText(processingPath);
  } catch (err) {
    log(`ERROR OCR failed for ${filename}: ${err.message}`);
    // Move to flagged
    const flaggedPath = path.join(FLAGGED, filename);
    await moveFile(processingPath, flaggedPath);
    await fs.promises.writeFile(
      path.join(FLAGGED, `${path.basename(filename, ext)}_error.json`),
      JSON.stringify({ error: err.message, stage: 'ocr', timestamp: new Date().toISOString() }, null, 2)
    );
    return;
  }
  log(`OCR   ${filename} — done (${ocrResult.method}, confidence: ${Math.round(ocrResult.confidence)}%, ${ocrResult.text.length} chars)`);

  // 3. Bill validation (confidence no longer gates — let the 4-signal validator decide)
  const validation = validateBillText(ocrResult.text);
  if (!validation.valid) {
    log(`FLAG  ${filename} — ${validation.reason}`);
    const flaggedPath = path.join(FLAGGED, filename);
    await moveFile(processingPath, flaggedPath);
    await fs.promises.writeFile(
      path.join(FLAGGED, `${path.basename(filename, ext)}_flag.json`),
      JSON.stringify({
        reason: validation.reason,
        signals: validation.signals,
        details: validation.details,
        ocr_snippet: ocrResult.text.substring(0, 500),
        timestamp: new Date().toISOString()
      }, null, 2)
    );
    return;
  }
  log(`VALID ${filename} — bill validated (${validation.signals} signals: ${Object.keys(validation.details).join(', ')})`);

  // 5. Create result folder
  const folderName = resultFolderName(filename);
  const resultDir = path.join(RESULTS, folderName);
  await fs.promises.mkdir(resultDir, { recursive: true });

  // 6. Save OCR text
  await fs.promises.writeFile(path.join(resultDir, 'ocr_text.txt'), ocrResult.text);

  // 7. Call analysis engine
  log(`ANALYZE ${filename} — sending to BillXM engine...`);
  const analysisResult = await analyzeBill(ocrResult.text);
  let analysisCompleted = false;
  let analysisSummary = {};

  if (analysisResult.success) {
    const report = analysisResult.report;
    await fs.promises.writeFile(
      path.join(resultDir, 'analysis.json'),
      JSON.stringify(report, null, 2)
    );
    analysisCompleted = true;
    analysisSummary = {
      grade: report.grade || 'N/A',
      total_billed: report.total_billed || 0,
      estimated_fair_value: report.estimated_fair_value || null,
      potential_savings: report.potential_savings || null,
      issue_count: (report.issues || []).length,
      line_item_count: (report.line_items || []).length
    };
    log(`ANALYZE ${filename} — grade: ${analysisSummary.grade}, billed: $${analysisSummary.total_billed}, savings: $${analysisSummary.potential_savings || 0}, issues: ${analysisSummary.issue_count}`);
  } else {
    log(`ANALYZE ${filename} — FAILED: ${analysisResult.error}`);
    await fs.promises.writeFile(
      path.join(resultDir, 'analysis_error.json'),
      JSON.stringify({ error: analysisResult.error, api_url: analysisResult.api_url, timestamp: new Date().toISOString() }, null, 2)
    );
  }

  // 8. Move original to results folder
  const originalDest = path.join(resultDir, `original${ext}`);
  await moveFile(processingPath, originalDest);
  log(`DONE  ${filename} → results/${folderName}/`);

  // Write metadata
  const source = filename.includes('_reddit_') ? 'reddit'
        : filename.includes('_gofundme_') ? 'gofundme'
        : filename.includes('_twitter_') ? 'twitter'
        : filename.includes('_news_') ? 'news'
        : filename.includes('_google_') ? 'google_images'
        : 'manual';
  const metadata = {
    original_filename: filename,
    source: source,
    ingested_at: new Date().toISOString(),
    ocr_method: ocrResult.method,
    ocr_confidence: Math.round(ocrResult.confidence),
    ocr_chars: ocrResult.text.length,
    ocr_completed: true,
    validation_signals: validation.signals,
    validation_details: validation.details,
    analysis_completed: analysisCompleted,
    analysis_summary: analysisSummary,
    flags: []
  };

  // 9. Post-analysis flagging rules
  if (analysisCompleted) {
    const report = analysisResult.success ? analysisResult.report : null;
    const flags = checkFlags(metadata, report);
    metadata.flags = flags;
    if (flags.length > 0) {
      log(`FLAG  ${filename} — ${flags.length} post-analysis flag(s):`);
      flags.forEach(f => log(`  ⚠ ${f}`));
      // Write flag details to flagged/ directory as well (bill stays in results for summary)
      await fs.promises.writeFile(
        path.join(FLAGGED, `${folderName}_postanalysis.json`),
        JSON.stringify({ folder: folderName, flags, analysis_summary: analysisSummary, timestamp: new Date().toISOString() }, null, 2)
      );
    }
  }

  await fs.promises.writeFile(
    path.join(resultDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  return { resultDir, folderName, ocrText: ocrResult.text };
}

// ── Watcher ─────────────────────────────────────────────────────────────────

let processing = false;
const queue = [];

async function drainQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const filePath = queue.shift();
    try {
      await processBill(filePath);
    } catch (err) {
      log(`ERROR processing ${path.basename(filePath)}: ${err.message}`);
    }
  }
  processing = false;
}

function startWatcher() {
  // Ensure directories exist
  for (const dir of [INBOX, PROCESSING, RESULTS, FLAGGED, LOGS]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  log('Watcher starting — watching harness/inbox/ for new files...');

  const watcher = chokidar.watch(INBOX, {
    ignoreInitial: false,       // process files already sitting in inbox
    awaitWriteFinish: {
      stabilityThreshold: 3000, // wait 3s after last write before processing
      pollInterval: 500
    },
    depth: 0                    // only top-level files
  });

  watcher.on('add', (filePath) => {
    queue.push(filePath);
    drainQueue();
  });

  watcher.on('error', (err) => {
    log(`WATCHER ERROR: ${err.message}`);
  });

  log('Watcher ready. Drop files into harness/inbox/ to process them.');
  return watcher;
}

module.exports = { startWatcher, processBill, log, terminateOcr, HARNESS_ROOT, INBOX, PROCESSING, RESULTS, FLAGGED, LOGS };
