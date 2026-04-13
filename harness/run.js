#!/usr/bin/env node
/**
 * BillXM Harness — Entry Point
 *
 * Usage:
 *   node harness/run.js                  Start the watcher only
 *   node harness/run.js --crawl          Run all crawlers, then start watcher
 *   node harness/run.js --crawl-only     Run all crawlers and exit
 *   node harness/run.js --daemon         Start watcher + schedule daily crawl via cron
 *   node harness/run.js --summary        Generate today's summary and exit
 *   node harness/run.js --reddit-only    Run Reddit crawler only and exit
 *   node harness/run.js --images-only    Run image search crawler only and exit
 *   node harness/run.js --gofundme-only  Run GoFundMe crawler only and exit
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { startWatcher, log, terminateOcr } = require('./watcher');
const { crawlReddit } = require('./crawlers/reddit');
const { crawlGoFundMe } = require('./crawlers/gofundme');
const { crawlImages } = require('./crawlers/google');
const { generateDailySummary } = require('./summary');

const { CONFIG_PATH } = require('./paths');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}

const args = process.argv.slice(2);
const doCrawl = args.includes('--crawl') || args.includes('--crawl-only');
const crawlOnly = args.includes('--crawl-only')
  || args.includes('--reddit-only')
  || args.includes('--images-only')
  || args.includes('--gofundme-only');
const daemonMode = args.includes('--daemon');
const summaryOnly = args.includes('--summary');

// Which crawlers to run (one-shot mode)
const runReddit = doCrawl || args.includes('--reddit-only');
const runImages = doCrawl || args.includes('--images-only');
const runGoFundMe = doCrawl || args.includes('--gofundme-only');

// ── Run all enabled crawlers ────────────────────────────────────

async function runAllCrawlers() {
  let totalDownloaded = 0;

  log('── Reddit crawler ──');
  try {
    const stats = await crawlReddit(log);
    totalDownloaded += stats.downloaded;
    log(`Reddit done: ${stats.downloaded} downloaded`);
  } catch (err) {
    log(`Reddit crawler error: ${err.message}`);
  }

  log('── GoFundMe crawler ──');
  try {
    const stats = await crawlGoFundMe(log);
    totalDownloaded += stats.downloaded;
    log(`GoFundMe done: ${stats.downloaded} downloaded`);
  } catch (err) {
    log(`GoFundMe crawler error: ${err.message}`);
  }

  log('── Image search crawler ──');
  try {
    const stats = await crawlImages(log);
    totalDownloaded += stats.downloaded;
    log(`Image search done: ${stats.downloaded} downloaded`);
  } catch (err) {
    log(`Image search crawler error: ${err.message}`);
  }

  log(`All crawlers finished: ${totalDownloaded} total images downloaded to inbox/`);
  return totalDownloaded;
}

// ── Run selected crawlers (one-shot flags) ──────────────────────

async function runSelectedCrawlers() {
  let totalDownloaded = 0;

  if (runReddit) {
    log('── Reddit crawler ──');
    try {
      const stats = await crawlReddit(log);
      totalDownloaded += stats.downloaded;
      log(`Reddit done: ${stats.downloaded} downloaded`);
    } catch (err) {
      log(`Reddit crawler error: ${err.message}`);
    }
  }

  if (runGoFundMe) {
    log('── GoFundMe crawler ──');
    try {
      const stats = await crawlGoFundMe(log);
      totalDownloaded += stats.downloaded;
      log(`GoFundMe done: ${stats.downloaded} downloaded`);
    } catch (err) {
      log(`GoFundMe crawler error: ${err.message}`);
    }
  }

  if (runImages) {
    log('── Image search crawler ──');
    try {
      const stats = await crawlImages(log);
      totalDownloaded += stats.downloaded;
      log(`Image search done: ${stats.downloaded} downloaded`);
    } catch (err) {
      log(`Image search crawler error: ${err.message}`);
    }
  }

  if (totalDownloaded > 0 || runReddit || runImages || runGoFundMe) {
    log(`All crawlers finished: ${totalDownloaded} total images downloaded to inbox/`);
  }

  return totalDownloaded;
}

// ── Scheduled daily cycle ───────────────────────────────────────

let crawlRunning = false;

async function dailyCrawlCycle() {
  if (crawlRunning) {
    log('SCHEDULER: Crawl already in progress — skipping this cycle');
    return;
  }
  crawlRunning = true;

  log('═══════════════════════════════════════════════');
  log('  SCHEDULED CRAWL CYCLE STARTING');
  log('═══════════════════════════════════════════════');

  try {
    await runAllCrawlers();
  } catch (err) {
    log(`Scheduled crawl error: ${err.message}`);
  }

  // Wait for the watcher to process downloaded files
  // (give it a generous window — analysis takes ~60s per bill)
  log('Waiting 5 minutes for watcher to process downloaded bills...');
  await new Promise(r => setTimeout(r, 5 * 60 * 1000));

  // Generate daily summary
  try {
    generateDailySummary(null, log);
  } catch (err) {
    log(`Summary generation error: ${err.message}`);
  }

  log('═══════════════════════════════════════════════');
  log('  SCHEDULED CRAWL CYCLE COMPLETE');
  log('═══════════════════════════════════════════════');

  crawlRunning = false;
}

// ── Parse crawl_time from config into cron expression ───────────

function getCronExpression() {
  const config = loadConfig();
  const timeStr = config.crawl_time || '06:00';
  const parts = timeStr.split(':');
  const hour = parseInt(parts[0], 10) || 6;
  const minute = parseInt(parts[1], 10) || 0;
  return `${minute} ${hour} * * *`; // Every day at HH:MM
}

// ── Main ────────────────────────────────────────────────────────

log('═══════════════════════════════════════════════');
log('  BillXM Harness v0.1 — Starting up');
log('═══════════════════════════════════════════════');

(async function main() {
  // --summary: generate summary and exit
  if (summaryOnly) {
    generateDailySummary(null, log);
    process.exit(0);
  }

  // One-shot crawl modes
  if (doCrawl || runReddit || runImages || runGoFundMe) {
    await runSelectedCrawlers();

    if (crawlOnly) {
      log('Crawl-only mode — exiting.');
      process.exit(0);
    }
  }

  // Start watcher
  const watcher = startWatcher();

  // --daemon: schedule daily crawl + summary
  if (daemonMode) {
    const cronExpr = getCronExpression();
    const config = loadConfig();
    log(`DAEMON: Scheduling daily crawl at ${config.crawl_time || '06:00'} (cron: ${cronExpr})`);

    const task = cron.schedule(cronExpr, () => {
      dailyCrawlCycle().catch(err => {
        log(`DAEMON: Crawl cycle failed: ${err.message}`);
        crawlRunning = false;
      });
    }, {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });

    log(`DAEMON: Running. Watcher active. Next crawl at ${config.crawl_time || '06:00'} local time.`);
    log(`DAEMON: Tip — drop files into harness/inbox/ anytime for immediate processing.`);
  }

  // Graceful shutdown
  async function shutdown() {
    log('Shutting down...');
    await watcher.close();
    await terminateOcr();
    log('Watcher + OCR stopped. Goodbye.');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
