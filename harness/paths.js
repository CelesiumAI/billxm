/**
 * BillXM Harness — Shared Paths
 *
 * Resolves working directories from config.work_dir.
 * If work_dir is set (e.g. "C:\\billxm-harness"), all working
 * directories (inbox, processing, results, etc.) live there,
 * outside OneDrive sync. Otherwise they fall back to harness/.
 */

const fs = require('fs');
const path = require('path');

const HARNESS_ROOT = path.resolve(__dirname);
const CONFIG_PATH = path.join(HARNESS_ROOT, 'config.json');

let _cfg = {};
try { _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}

const WORK_DIR = _cfg.work_dir ? path.resolve(_cfg.work_dir) : HARNESS_ROOT;

module.exports = {
  HARNESS_ROOT,
  CONFIG_PATH,
  WORK_DIR,
  INBOX:      path.join(WORK_DIR, 'inbox'),
  PROCESSING: path.join(WORK_DIR, 'processing'),
  RESULTS:    path.join(WORK_DIR, 'results'),
  FLAGGED:    path.join(WORK_DIR, 'flagged'),
  ARCHIVE:    path.join(WORK_DIR, 'archive'),
  LOGS:       path.join(WORK_DIR, 'logs'),
  SEEN_PATH:  path.join(WORK_DIR, 'seen_urls.json'),
};
