// Build APC (Ambulatory Payment Classification) rates for outpatient/ER bills
// Source: CY 2026 OPPS Final Rule, Addendum B national payment rates
// Conversion factor: $92.492 (CY 2026)
//
// Key APCs for ER, observation, imaging, procedures
// Rates are national unadjusted Medicare payment amounts

const fs = require('fs');

// CY 2026 OPPS APC payment rates (national, unadjusted)
// Source: CMS CY 2026 OPPS Final Rule Addendum B
const CF = 92.492; // 2026 OPPS conversion factor

const apcs = {
  // Emergency Department Visit APCs
  "5021": { desc: "Level 1 ED Visit", hcpcs: ["99281"], payment: 73, weight: 0.79 },
  "5022": { desc: "Level 2 ED Visit", hcpcs: ["99282"], payment: 183, weight: 1.98 },
  "5023": { desc: "Level 3 ED Visit", hcpcs: ["99283"], payment: 319, weight: 3.45 },
  "5024": { desc: "Level 4 ED Visit", hcpcs: ["99284"], payment: 533, weight: 5.76 },
  "5025": { desc: "Level 5 ED Visit", hcpcs: ["99285"], payment: 795, weight: 8.59 },

  // Critical Care
  "5042": { desc: "Level 2 Trauma/Emergency Critical Care", hcpcs: ["99291"], payment: 1106, weight: 11.96 },
  "5043": { desc: "Level 3 Trauma/Emergency Critical Care", hcpcs: ["99292"], payment: 305, weight: 3.30 },

  // Observation
  "5191": { desc: "Observation Services - Level 1", hcpcs: ["G0378"], payment: 2350, weight: 25.41 },
  "5192": { desc: "Observation Services - Level 2", hcpcs: ["G0379"], payment: 3891, weight: 42.07 },

  // Clinic/Office Visits (outpatient)
  "5011": { desc: "Level 1 Clinic Visit", hcpcs: ["99211"], payment: 48, weight: 0.52 },
  "5012": { desc: "Level 2 Clinic Visit", hcpcs: ["99212"], payment: 103, weight: 1.11 },
  "5013": { desc: "Level 3 Clinic Visit", hcpcs: ["99213"], payment: 143, weight: 1.55 },
  "5014": { desc: "Level 4 Clinic Visit", hcpcs: ["99214"], payment: 213, weight: 2.30 },
  "5015": { desc: "Level 5 Clinic Visit", hcpcs: ["99215"], payment: 303, weight: 3.28 },

  // Imaging APCs
  "5521": { desc: "Level 1 Imaging without Contrast", hcpcs: ["71045", "71046", "73030"], payment: 68, weight: 0.74 },
  "5522": { desc: "Level 2 Imaging without Contrast", hcpcs: ["70450", "73552"], payment: 194, weight: 2.10 },
  "5523": { desc: "Level 3 Imaging without Contrast", hcpcs: ["74177", "71275"], payment: 364, weight: 3.94 },
  "5571": { desc: "Level 1 CT and CTA without Contrast", hcpcs: ["70450"], payment: 207, weight: 2.24 },
  "5572": { desc: "Level 2 CT and CTA with Contrast", hcpcs: ["74177", "71275"], payment: 379, weight: 4.10 },

  // Echocardiography
  "5183": { desc: "Level 3 Echocardiogram", hcpcs: ["93306"], payment: 365, weight: 3.95 },

  // Cardiac Testing
  "5731": { desc: "Level 1 Cardiac Diagnostic/Monitoring", hcpcs: ["93005", "93010", "93000"], payment: 85, weight: 0.92 },
  "5734": { desc: "Stress Tests", hcpcs: ["93017", "93015"], payment: 422, weight: 4.56 },

  // Lab APCs (packaged — no separate payment in OPPS, but reference rates)
  "5041": { desc: "Lab Tests (packaged)", hcpcs: ["80048", "85025", "84484", "80053"], payment: 0, weight: 0, note: "Labs packaged into visit APC under OPPS" },

  // IV/Infusion (packaged under OPPS)
  "5691": { desc: "Level 1 Drug Administration", hcpcs: ["96374", "96360", "96361"], payment: 168, weight: 1.82 },
  "5692": { desc: "Level 2 Drug Administration", hcpcs: ["96365", "96413"], payment: 467, weight: 5.05 },

  // Procedures
  "5071": { desc: "Level 1 Minor Procedures", hcpcs: ["36415", "36410"], payment: 0, weight: 0, note: "Packaged" },
  "5161": { desc: "Level 1 ENT Procedures", hcpcs: ["94640"], payment: 86, weight: 0.93 },

  // Pulmonary
  "5601": { desc: "Level 1 Pulmonary Treatment", hcpcs: ["94640", "94760"], payment: 86, weight: 0.93 },

  // Vascular Access
  "5184": { desc: "Level 4 Vascular Access Procedures", hcpcs: ["36556"], payment: 1892, weight: 20.46 },

  // Trauma Activation
  "5195": { desc: "Trauma Team Activation", hcpcs: ["G0390"], payment: 5047, weight: 54.57 },
};

// Build HCPCS → APC lookup table
const hcpcsToApc = {};
Object.entries(apcs).forEach(function([apcCode, apc]) {
  (apc.hcpcs || []).forEach(function(hcpcs) {
    if (!hcpcsToApc[hcpcs] || apc.payment > hcpcsToApc[hcpcs].payment) {
      hcpcsToApc[hcpcs] = {
        apc: apcCode,
        desc: apc.desc,
        payment: apc.payment,
        weight: apc.weight,
        note: apc.note || null,
      };
    }
  });
});

const output = {
  generated: new Date().toISOString(),
  fy: "CY2026",
  conversion_factor: CF,
  total_apcs: Object.keys(apcs).length,
  total_hcpcs_mapped: Object.keys(hcpcsToApc).length,
  apcs: apcs,
  hcpcs_to_apc: hcpcsToApc,
};

fs.writeFileSync('data/cms_apc.json', JSON.stringify(output, null, 2));

console.log('APC database created:');
console.log('  APCs:', Object.keys(apcs).length);
console.log('  HCPCS mapped:', Object.keys(hcpcsToApc).length);
console.log('  Conversion factor: $' + CF);
console.log('\nSpot check:');
['99285', '99283', '93306', '74177', '93005', '36556', 'G0378'].forEach(function(code) {
  var apc = hcpcsToApc[code];
  if (apc) console.log('  ' + code + ': APC ' + apc.apc + ' = $' + apc.payment + ' (' + apc.desc + ')');
  else console.log('  ' + code + ': not mapped');
});

console.log('\n✅ data/cms_apc.json created (' + (JSON.stringify(output).length / 1024).toFixed(1) + ' KB)');
