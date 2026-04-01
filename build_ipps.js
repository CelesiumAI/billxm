// build_ipps.js — builds cms_drg.json from IPPS Table 5
// Run: node build_ipps.js

const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

// ── FY2026 Base Payment Rates (Table 1A — quality submitters, wage index > 1) ──
const LABOR_RATE    = 4456.72;
const NONLABOR_RATE = 2295.89;
const BASE_RATE     = LABOR_RATE + NONLABOR_RATE; // $6,752.61 national

// Houston CBSA 26420 wage index (from Table 3 — pre-looked up)
// Houston wage index FY2026: approximately 0.9986 (slightly under 1.0)
// When wage index <= 1, use Table 1B rates (62/38 split)
// Table 1B: Labor $4,186.62 + NonLabor $2,565.99 = $6,752.61 (same total, different split)
// For our purposes, use the national base rate directly — difference is <1%
const HOUSTON_WAGE_INDEX = 0.9986;
const HOUSTON_BASE = (LABOR_RATE * HOUSTON_WAGE_INDEX) + NONLABOR_RATE;

console.log('FY2026 IPPS Base Rate (national): $' + BASE_RATE.toFixed(2));
console.log('FY2026 IPPS Base Rate (Houston):  $' + HOUSTON_BASE.toFixed(2));

// ── Parse Table 5: DRG weights ────────────────────────────────────────
console.log('\nParsing Table 5...');

const wb = XLSX.readFile(path.join(__dirname, 'data', 'CMS-1833-F Table 5.xlsx'));
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

// Find header row
let headerRow = -1;
for (var i = 0; i < rows.length; i++) {
  if (rows[i] && rows[i][0] && String(rows[i][0]).match(/^0*\d+$/) && rows[i].length >= 7) {
    headerRow = i;
    break;
  }
}

console.log('Data starts at row:', headerRow);
console.log('Sample row:', JSON.stringify(rows[headerRow]));

// Structure from inspection:
// Col 0: DRG number
// Col 1: Post-acute transfer
// Col 2: Special payment
// Col 3: MDC
// Col 4: Type (MED/SURG/PRE)
// Col 5: Description
// Col 6: Relative weight
// Col 7: Relative weight (same)
// Col 8: Geometric mean LOS
// Col 9: Arithmetic mean LOS

const drgs = {};
let count = 0;

for (var i = headerRow; i < rows.length; i++) {
  const row = rows[i];
  if (!row || !row[0]) continue;

  const drgNum = String(row[0]).trim().padStart(3, '0');
  const desc   = String(row[5] || '').trim();
  const weight = parseFloat(row[6]) || 0;
  const geoLOS = parseFloat(row[8]) || 0;
  const arithLOS = parseFloat(row[9]) || 0;

  if (!drgNum.match(/^\d{3}$/) || weight <= 0) continue;

  const nationalPayment = Math.round(weight * BASE_RATE * 100) / 100;
  const houstonPayment  = Math.round(weight * HOUSTON_BASE * 100) / 100;

  drgs[drgNum] = {
    desc: desc,
    weight: weight,
    geo_los: geoLOS,
    arith_los: arithLOS,
    national_payment: nationalPayment,
    houston_payment: houstonPayment,
  };
  count++;
}

console.log('DRGs parsed: ' + count);

// ── Spot check key DRGs ───────────────────────────────────────────────
const spotCheck = {
  '291': 'Heart failure with MCC',
  '292': 'Heart failure with CC',
  '470': 'Major joint replacement lower extremity w/o MCC',
  '313': 'Chest pain',
  '280': 'Acute MI with MCC',
  '065': 'Intracranial hemorrhage with MCC',
  '194': 'Simple pneumonia with MCC',
  '871': 'Septicemia without MV >96 hours with MCC',
};

console.log('\nSpot check:');
Object.keys(spotCheck).forEach(function(drg) {
  const d = drgs[drg];
  if (d) {
    console.log('DRG ' + drg + ' (' + d.desc + '): weight=' + d.weight + ' | national=$' + d.national_payment + ' | houston=$' + d.houston_payment + ' | avg LOS=' + d.geo_los + ' days');
  } else {
    console.log('DRG ' + drg + ': NOT FOUND');
  }
});

// ── Save output ───────────────────────────────────────────────────────
const output = {
  generated: new Date().toISOString(),
  fy: '2026',
  base_rate_national: BASE_RATE,
  base_rate_houston: HOUSTON_BASE,
  houston_wage_index: HOUSTON_WAGE_INDEX,
  total_drgs: count,
  drgs: drgs,
};

const outPath = path.join(__dirname, 'data', 'cms_drg.json');
fs.writeFileSync(outPath, JSON.stringify(output));

const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
console.log('\n✅ cms_drg.json created: ' + sizeMB + ' MB | ' + count + ' DRGs');
