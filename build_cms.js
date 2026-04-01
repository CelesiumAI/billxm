const fs = require('fs');
const path = require('path');

const CF = 33.4009;

console.log('Building optimized CMS rate lookup tables...');

// ── Load GPCI for all localities ─────────────────────────────
function loadAllGPCIs() {
  const file = fs.readFileSync(path.join(__dirname, 'data', 'GPCI2026.csv'), 'utf8');
  const lines = file.split('\n');
  const localities = {};
  let count = 0;

  for (var i = 3; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 8) continue;

    const state        = cols[1] ? cols[1].trim().toUpperCase() : '';
    const localityNum  = cols[2] ? cols[2].trim().padStart(2,'0') : '';
    const localityName = cols[3] ? cols[3].trim().toUpperCase().replace(/\*/g,'') : '';
    const workGPCI     = parseFloat(cols[5]) || 1.0;
    const peGPCI       = parseFloat(cols[6]) || 1.0;
    const mpGPCI       = parseFloat(cols[7]) || 1.0;

    if (!state || !localityNum) continue;

    const key = state + '_' + localityNum;
    localities[key] = {
      state: state,
      locality: localityNum,
      name: localityName,
      work: workGPCI,
      pe: peGPCI,
      mp: mpGPCI,
    };
    count++;
  }

  console.log('Localities loaded: ' + count);
  return localities;
}

// ── Calculate national average GPCI ─────────────────────────
function calcNationalAverage(localities) {
  var totalWork = 0, totalPE = 0, totalMP = 0, count = 0;
  Object.keys(localities).forEach(function(key) {
    const loc = localities[key];
    // Skip bad rows — valid GPCI values are between 0.4 and 2.5
    if (loc.work > 2.5 || loc.pe > 2.5 || loc.mp > 2.5) return;
    if (loc.work < 0.4 || loc.pe < 0.4 || loc.mp < 0.1) return;
    totalWork += loc.work;
    totalPE   += loc.pe;
    totalMP   += loc.mp;
    count++;
  });
  return {
    work: Math.round((totalWork / count) * 1000) / 1000,
    pe:   Math.round((totalPE   / count) * 1000) / 1000,
    mp:   Math.round((totalMP   / count) * 1000) / 1000,
  };
}

// ── Load RVU values (store raw, calculate rates at runtime) ──
function loadRVUs() {
  const file = fs.readFileSync(
    path.join(__dirname, 'data', 'PPRRVU2026_Jan_nonQPP.csv'), 'utf8'
  );
  const lines = file.split('\n');
  const HEADER_ROW = 9;
  const COL_CODE  = 0;
  const COL_MOD   = 1;
  const COL_DESC  = 2;
  const COL_WORK  = 5;
  const COL_FACPE = 8;
  const COL_MP    = 10;

  const rvus = {};
  let processed = 0;

  for (var i = HEADER_ROW + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const code = cols[COL_CODE] ? cols[COL_CODE].trim() : '';
    const mod  = cols[COL_MOD]  ? cols[COL_MOD].trim()  : '';
    if (!code || mod) continue;

    const workRVU = parseFloat(cols[COL_WORK])  || 0;
    const facPE   = parseFloat(cols[COL_FACPE]) || 0;
    const mpRVU   = parseFloat(cols[COL_MP])    || 0;

    // Only store if at least one RVU value exists
    if (workRVU > 0 || facPE > 0 || mpRVU > 0) {
      rvus[code] = {
        w: workRVU,
        p: facPE,
        m: mpRVU,
        d: cols[COL_DESC] ? cols[COL_DESC].trim().replace(/"/g,'').substring(0,60) : '',
        t: 'ph',
      };
      processed++;
    }
  }

  console.log('Physician RVUs loaded: ' + processed + ' codes');
  return rvus;
}

// ── Load lab rates (national, no locality adjustment) ────────
function loadLabRates() {
  const file = fs.readFileSync(
    path.join(__dirname, 'data', 'PUF_CLFS_CY2026_Q2V1.csv'), 'utf8'
  );
  const lines = file.split('\n');
  const HEADER_ROW = 4;
  const COL_CODE = 1;
  const COL_MOD  = 2;
  const COL_RATE = 5;
  const COL_DESC = 6;

  const labs = {};
  let added = 0;

  for (var i = HEADER_ROW + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const code = cols[COL_CODE] ? cols[COL_CODE].trim() : '';
    const mod  = cols[COL_MOD]  ? cols[COL_MOD].trim()  : '';
    if (!code || mod) continue;
    const rate = parseFloat(cols[COL_RATE]) || 0;
    const desc = cols[COL_DESC] ? cols[COL_DESC].trim().replace(/"/g,'').substring(0,60) : '';
    if (rate > 0) {
      labs[code] = { r: rate, d: desc, t: 'lab' };
      added++;
    }
  }

  console.log('Lab rates loaded: ' + added + ' codes');
  return labs;
}

// ── MAIN ─────────────────────────────────────────────────────
try {
  const localities  = loadAllGPCIs();
  const nationalAvg = calcNationalAverage(localities);
  const rvus        = loadRVUs();
  const labs        = loadLabRates();

  console.log('National average GPCI - Work: ' + nationalAvg.work +
              ', PE: ' + nationalAvg.pe + ', MP: ' + nationalAvg.mp);

  // File 1: cms_rvus.json — RVU values + lab rates (~2MB)
  const rvuOutput = {
    generated: new Date().toISOString(),
    conversion_factor: CF,
    national_avg_gpci: nationalAvg,
    rvus: rvus,
    labs: labs,
  };
  const rvuPath = path.join(__dirname, 'data', 'cms_rvus.json');
  fs.writeFileSync(rvuPath, JSON.stringify(rvuOutput));
  const rvuSizeMB = (fs.statSync(rvuPath).size / 1024 / 1024).toFixed(2);
  console.log('cms_rvus.json: ' + rvuSizeMB + ' MB (' + (Object.keys(rvus).length + Object.keys(labs).length) + ' codes)');

  // File 2: cms_gpci.json — locality lookup table (~20KB)
  const gpciOutput = {
    generated: new Date().toISOString(),
    localities: localities,
  };
  const gpciPath = path.join(__dirname, 'data', 'cms_gpci.json');
  fs.writeFileSync(gpciPath, JSON.stringify(gpciOutput));
  const gpciSizeKB = (fs.statSync(gpciPath).size / 1024).toFixed(1);
  console.log('cms_gpci.json: ' + gpciSizeKB + ' KB (' + Object.keys(localities).length + ' localities)');

  // Spot check national average rates
  console.log('');
  console.log('Spot check - national average rates:');
  var checks = ['99285','93005','80048','74177','85025'];
  checks.forEach(function(code) {
    if (labs[code]) {
      console.log('  ' + code + ': $' + labs[code].r + ' [LAB] (' + labs[code].d + ')');
    } else if (rvus[code]) {
      const r = rvus[code];
      const rate = Math.round(
        ((r.w * nationalAvg.work) + (r.p * nationalAvg.pe) + (r.m * nationalAvg.mp)) * CF * 100
      ) / 100;
      console.log('  ' + code + ': $' + rate + ' [PHYSICIAN] (' + r.d + ')');
    } else {
      console.log('  ' + code + ': NOT FOUND');
    }
  });

  // Spot check Houston rates
  const houstonKey = 'TX_09';
  const houston = localities[houstonKey];
  if (houston) {
    console.log('');
    console.log('Spot check - Houston TX rates (locality ' + houstonKey + '):');
    checks.forEach(function(code) {
      if (labs[code]) {
        console.log('  ' + code + ': $' + labs[code].r + ' [LAB - national]');
      } else if (rvus[code]) {
        const r = rvus[code];
        const rate = Math.round(
          ((r.w * houston.work) + (r.p * houston.pe) + (r.m * houston.mp)) * CF * 100
        ) / 100;
        console.log('  ' + code + ': $' + rate + ' [Houston]');
      }
    });
  } else {
    console.log('Houston key TX_09 not found. Available TX localities:');
    Object.keys(localities).filter(function(k){ return k.startsWith('TX_'); }).forEach(function(k){
      console.log('  ' + k + ': ' + localities[k].name);
    });
  }

  console.log('');
  console.log('All done! Two small files created:');
  console.log('  cms_rvus.json  — ' + rvuSizeMB + ' MB (RVUs + lab rates)');
  console.log('  cms_gpci.json  — ' + gpciSizeKB + ' KB (locality adjustments)');
  console.log('Delete cms_rates.json — it is no longer needed.');

} catch (err) {
  console.error('Error: ' + err.message);
  console.error(err.stack);
}
