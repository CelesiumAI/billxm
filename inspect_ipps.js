const XLSX = require('xlsx');
const path = require('path');

// Inspect Table 5 — DRG weights
console.log('=== TABLE 5: MS-DRG Weights ===');
try {
  const wb5 = XLSX.readFile(path.join(__dirname, 'data', 'CMS-1833-F Table 5.xlsx'));
  const sheet5 = wb5.Sheets[wb5.SheetNames[0]];
  const data5 = XLSX.utils.sheet_to_json(sheet5, { header: 1 });
  console.log('Sheet names:', wb5.SheetNames);
  console.log('Total rows:', data5.length);
  for (var i = 0; i < 8; i++) {
    console.log('Row ' + i + ':', JSON.stringify(data5[i]));
  }
} catch(e) { console.error('Table 5 error:', e.message); }

console.log('');

// Inspect Table 1A-1E — base rates
console.log('=== TABLE 1A-1E: Base Payment Rates ===');
try {
  const wb1 = XLSX.readFile(path.join(__dirname, 'data', 'CMS-1833-F Tables 1A - 1E.xlsx'));
  console.log('Sheet names:', wb1.SheetNames);
  const sheet1 = wb1.Sheets[wb1.SheetNames[0]];
  const data1 = XLSX.utils.sheet_to_json(sheet1, { header: 1 });
  console.log('Total rows:', data1.length);
  for (var j = 0; j < 15; j++) {
    console.log('Row ' + j + ':', JSON.stringify(data1[j]));
  }
} catch(e) { console.error('Table 1 error:', e.message); }
