// Run this to add OPPS rates to your existing cms_rvus.json
// Usage: node add_opps.js

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const HOUSTON_LOCALITY = '09';
const HOUSTON_CARRIER = '01112';

console.log('Loading OPPS facility pricing cap file...');

// Load existing cms_rvus.json
const existing = JSON.parse(fs.readFileSync(path.join(dataDir, 'cms_rvus.json'), 'utf8'));

// Parse OPPSCAP file - Houston locality 09
const file = fs.readFileSync(path.join(dataDir, 'OPPSCAP_Jan.csv'), 'utf8');
const lines = file.split('\n');

// HCPCS,MOD,PROCSTAT,CARRIER,LOCALITY,FACILITY PRICE,NON-FACILITY PRICE
const opps = {};
let added = 0;

for (var i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const cols = line.split(',');
  if (cols.length < 7) continue;

  const code     = cols[0] ? cols[0].trim() : '';
  const mod      = cols[1] ? cols[1].trim() : '';
  const carrier  = cols[3] ? cols[3].trim() : '';
  const locality = cols[4] ? cols[4].trim() : '';
  const facPrice = parseFloat(cols[5]) || 0;

  // Only Houston, no modifier rows
  if (carrier !== HOUSTON_CARRIER) continue;
  if (locality !== HOUSTON_LOCALITY) continue;
  if (mod) continue;
  if (!code || facPrice <= 0) continue;

  // Only add if not already in physician or lab schedules
  // OPPS fills gaps for codes not in MPFS
  if (!existing.rvus[code] && !existing.labs[code]) {
    opps[code] = { r: facPrice, d: '', t: 'opps' };
    added++;
  }
}

console.log('OPPS codes added (Houston, no modifier): ' + added);

// Merge into existing structure
existing.opps_houston = opps;
existing.total_codes = Object.keys(existing.rvus).length + Object.keys(existing.labs).length + added;

fs.writeFileSync(path.join(dataDir, 'cms_rvus.json'), JSON.stringify(existing));

console.log('Updated cms_rvus.json with OPPS rates');
console.log('Total codes now: ' + existing.total_codes);
