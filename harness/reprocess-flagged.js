#!/usr/bin/env node
/**
 * Re-process flagged files through the updated OCR + validation pipeline.
 * Moves image files from flagged/ back to inbox/ for the watcher to pick up.
 *
 * Usage: node harness/reprocess-flagged.js
 * Then start the watcher: node harness/run.js
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
const { FLAGGED, INBOX } = require('./paths');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.pdf', '.webp']);

const flaggedFiles = fs.readdirSync(FLAGGED);
const imageFiles = flaggedFiles.filter(f => {
  const ext = path.extname(f).toLowerCase();
  return IMAGE_EXTS.has(ext);
});

console.log(`Found ${imageFiles.length} image files in flagged/`);
console.log(`Moving them to inbox/ for re-processing...`);

let moved = 0;
for (const file of imageFiles) {
  const src = path.join(FLAGGED, file);
  const dest = path.join(INBOX, file);
  try {
    // Don't overwrite if already in inbox
    if (fs.existsSync(dest)) {
      console.log(`  SKIP ${file} — already in inbox`);
      continue;
    }
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
    moved++;
  } catch (err) {
    console.log(`  ERROR ${file}: ${err.message}`);
  }
}

// Also clean up orphaned flag JSON files for moved images
let cleaned = 0;
for (const file of flaggedFiles) {
  if (!file.endsWith('_flag.json') && !file.endsWith('_error.json')) continue;
  const baseName = file.replace(/_flag\.json$|_error\.json$/, '');
  // Check if the corresponding image was moved
  const hasImage = imageFiles.some(img => path.basename(img, path.extname(img)) === baseName);
  if (hasImage) {
    try {
      fs.unlinkSync(path.join(FLAGGED, file));
      cleaned++;
    } catch (_) {}
  }
}

console.log(`\nMoved ${moved} images to inbox/`);
console.log(`Cleaned ${cleaned} flag JSON files`);
console.log(`\nNow run: node harness/run.js`);
