// build_asp.js — adds ASP drug pricing (J-codes and other Part B drugs) to cms_rvus.json
// Run: node build_asp.js

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');

console.log('Loading ASP Part B Drug Pricing file...');
const wb = XLSX.readFile(path.join(dataDir, 'April 2026 Medicare Part B Payment Limit File 033026.xls'));
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

// Header is row 8 (index 8), data starts row 9
// Cols: HCPCS, Short Description, Dosage, Payment Limit, Co-insurance %, ...
const COL_CODE  = 0;
const COL_DESC  = 1;
const COL_DOSE  = 2;
const COL_LIMIT = 3;

const drugs = {};
let jCodes = 0;
let otherCodes = 0;

for (var i = 9; i < rows.length; i++) {
  const row = rows[i];
  if (!row || !row[COL_CODE]) continue;

  const code  = String(row[COL_CODE]).trim().toUpperCase();
  const desc  = String(row[COL_DESC] || '').trim();
  const dose  = String(row[COL_DOSE] || '').trim();
  const limit = parseFloat(row[COL_LIMIT]) || 0;

  if (!code || limit <= 0) continue;

  // Medicare pays ASP + 6% — the payment limit file already includes this
  drugs[code] = {
    r: limit,        // payment limit (ASP + 6%)
    d: desc,         // short description
    dose: dose,      // dosage unit
    t: 'asp'         // type: asp drug
  };

  if (code.startsWith('J')) jCodes++;
  else otherCodes++;
}

console.log('J-codes loaded: ' + jCodes);
console.log('Other drug codes: ' + otherCodes);
console.log('Total drug codes: ' + (jCodes + otherCodes));

// Spot check key J-codes commonly seen on hospital bills
const spotCheck = ['J1100','J2270','J0696','J1642','J2785','J0881','J9999','J0129','J1030','J2001'];
console.log('\nSpot check key J-codes:');
spotCheck.forEach(function(code) {
  if (drugs[code]) {
    console.log('  ' + code + ': $' + drugs[code].r + '/unit — ' + drugs[code].d + ' (' + drugs[code].dose + ')');
  } else {
    console.log('  ' + code + ': not in April 2026 file');
  }
});

// Load existing cms_rvus.json and add drug data
console.log('\nMerging into cms_rvus.json...');
const existing = JSON.parse(fs.readFileSync(path.join(dataDir, 'cms_rvus.json'), 'utf8'));

// Add drugs — don't overwrite lab codes (CLFS takes precedence for lab tests)
let added = 0;
let skipped = 0;
Object.keys(drugs).forEach(function(code) {
  if (existing.labs && existing.labs[code]) {
    skipped++; // CLFS lab rate takes precedence
  } else {
    if (!existing.drugs) existing.drugs = {};
    existing.drugs[code] = drugs[code];
    added++;
  }
});

console.log('Drug codes added: ' + added);
console.log('Skipped (already in CLFS): ' + skipped);

existing.total_codes = Object.keys(existing.rvus || {}).length +
                       Object.keys(existing.labs || {}).length +
                       Object.keys(existing.drugs || {}).length +
                       Object.keys(existing.opps_houston || {}).length;

fs.writeFileSync(path.join(dataDir, 'cms_rvus.json'), JSON.stringify(existing));

const sizeMB = (fs.statSync(path.join(dataDir, 'cms_rvus.json')).size / 1024 / 1024).toFixed(2);
console.log('\n✅ Done! cms_rvus.json updated');
console.log('Total codes now: ' + existing.total_codes);
console.log('File size: ' + sizeMB + ' MB');
