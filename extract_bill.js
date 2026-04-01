const fs = require('fs');
const pdf = require('pdf-parse');

const MAX_TOKENS = 5000;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * APPROX_CHARS_PER_TOKEN;

// Split trailing "qtyAmount" number block into qty and amount.
// Returns all valid splits; caller picks the best one.
function allQtyAmountSplits(tail) {
  var results = [];
  for (var qtyLen = 1; qtyLen <= 3 && qtyLen < tail.length; qtyLen++) {
    var qtyStr = tail.slice(0, qtyLen);
    var amtStr = tail.slice(qtyLen);
    if (!/^\d+$/.test(qtyStr) || parseInt(qtyStr) === 0) continue;
    // Amount: 1-3 digits, optional comma groups, dot, 2 digits
    if (/^\d{1,3}(,\d{3})*\.\d{2}$/.test(amtStr)) {
      results.push({
        qty: parseInt(qtyStr),
        amount: parseFloat(amtStr.replace(/,/g, '')),
        amtStr: amtStr,
      });
    }
  }
  return results;
}

function bestSplit(tail) {
  var splits = allQtyAmountSplits(tail);
  if (splits.length === 0) return null;
  if (splits.length === 1) return splits[0];

  // Heuristic: hospital bills rarely have qty > 100 for a single line.
  // Prefer splits where qty is small (1-20) and amount looks reasonable.
  // If multiple valid, prefer the one where amount has proper comma grouping
  // (e.g., "3,774.00" over "73,774.00" when qty could be 17 vs 1)

  // Score: lower qty is slightly preferred, but also prefer amounts
  // that look like they have correct comma grouping from the start
  for (var i = 0; i < splits.length; i++) {
    var s = splits[i];
    // Check if amount string starts with 1-3 digits before first comma
    // This is the "natural" format: amounts like 3,774.00 start with 1-3 digits
    // But 73,774.00 also matches. The difference: in the original layout,
    // the qty column is separate, so what's left should be a clean amount.
    // We just pick the last valid split (longest qty) since that maximizes
    // the chance the amount portion is a clean standalone number.
  }

  // Actually: prefer the split that makes qty smallest IF amount > qty.
  // But the real fix: prefer splits where amount >= 1 (always true)
  // and qty is reasonable. Most lines have qty 1-10.
  // Pick the LAST valid split (longest qty match) — this gives smallest amounts
  // which is usually wrong. Pick the FIRST valid split (shortest qty).
  // ... But first split gave wrong answer for 173,774.00.
  //
  // Better: if there's a split with qty <= 20, prefer it.
  // If multiple have qty <= 20, prefer the one with larger amount (more digits).
  var preferred = splits.filter(function(s) { return s.qty <= 50; });
  if (preferred.length === 0) preferred = splits;

  // Among preferred, pick the one with the largest amount (most likely correct)
  preferred.sort(function(a, b) { return b.amount - a.amount; });
  return preferred[0];
}

function parseChargeLine(line) {
  if (!/^\d{2}\/\d{2}\/\d{2}/.test(line)) return null;

  var date = line.slice(0, 8);
  var rest = line.slice(8);

  // Find boundary between text and trailing number block
  var boundary = rest.match(/^(.*[^0-9,.])([\d,.]+)$/);
  if (!boundary) return null;

  var textPart = boundary[1];
  var numBlock = boundary[2];

  // Validate numBlock has a decimal point (it's an amount)
  if (numBlock.indexOf('.') === -1) return null;

  var split = bestSplit(numBlock);
  if (!split) return null;

  // Extract code from textPart
  var code = '';
  var desc = textPart;

  // J-code: J followed by 4-5 digits
  var jMatch = textPart.match(/^(J\d{4,5})(.*)/);
  if (jMatch) {
    code = jMatch[1];
    desc = jMatch[2];
  } else {
    // CPT with HC suffix
    var cptMatch = textPart.match(/^(\d{5})HC\s*(.*)/);
    if (cptMatch) {
      code = cptMatch[1];
      desc = cptMatch[2];
    } else {
      // G-code with optional HC
      var gMatch = textPart.match(/^(G\d{4,5})(?:HC)?\s*(.*)/);
      if (gMatch) {
        code = gMatch[1];
        desc = gMatch[2];
      } else {
        // Internal hospital code (10 digits)
        var intMatch = textPart.match(/^(\d{10})(.*)/);
        if (intMatch) {
          code = '';
          desc = intMatch[2];
        } else {
          // Other codes (C-codes, etc.)
          var otherMatch = textPart.match(/^([A-Z]\d{4,5})(?:HC)?\s*(.*)/);
          if (otherMatch) {
            code = otherMatch[1];
            desc = otherMatch[2];
          }
        }
      }
    }
  }

  // Clean description
  desc = desc.replace(/\s*\([\d-]+\)\s*$/, ''); // strip NDC
  desc = desc.replace(/^\s*[-–]\s*/, '').replace(/\s*[-–]\s*$/, '');
  desc = desc.replace(/\s+/g, ' ').trim();
  if (!desc) return null;

  return { date: date, code: code, desc: desc, qty: split.qty, amount: split.amount };
}

async function extractBill(filePath) {
  var buf = fs.readFileSync(filePath);
  var data = await pdf(buf);

  var lines = data.text.split('\n');
  var items = [];
  var hospital = '';
  var dateRange = '';
  var totalCharges = 0;
  var admissions = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();

    // Capture hospital name
    if (!hospital) {
      if (/Memorial Hermann/i.test(line)) hospital = 'Memorial Hermann Health System';
      else if (/hospital|medical center/i.test(line) && line.length < 80) hospital = line;
    }

    // Capture admission info
    var admMatch = line.match(/Admission to (.+) \(Acct/);
    if (admMatch) admissions.push(admMatch[1]);

    // Capture date range
    var dateMatch = line.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})\s+to\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/);
    if (dateMatch) {
      if (!dateRange) dateRange = dateMatch[1] + ' to ' + dateMatch[2];
    }

    // Capture "Total Charges"
    var totalMatch = line.match(/^Total Charges([\d,]+\.\d{2})/);
    if (totalMatch) {
      totalCharges += parseFloat(totalMatch[1].replace(/,/g, ''));
    }

    // Try to parse as charge line
    var parsed = parseChargeLine(line);
    if (parsed) {
      // Skip adjustment/payment lines — not actual charges
      var descLower = parsed.desc.toLowerCase();
      if (/insurance payment|contractual allowance|contract-to-payment|adjustment|expected payer/i.test(parsed.desc)) continue;
      // Skip lines where internal code leaked into description
      if (/^\d{4}/.test(parsed.desc) && parsed.desc.length < 30) continue;
      items.push(parsed);
    }
  }

  // Aggregate: same code + description → sum
  var agg = {};
  items.forEach(function(item) {
    var key = (item.code || 'NO_CPT') + '|' + item.desc;
    if (!agg[key]) {
      agg[key] = { code: item.code, desc: item.desc, qty: 0, amount: 0 };
    }
    agg[key].qty += item.qty;
    agg[key].amount = Math.round((agg[key].amount + item.amount) * 100) / 100;
  });

  var aggregated = Object.values(agg).sort(function(a, b) { return b.amount - a.amount; });
  var calcTotal = Math.round(aggregated.reduce(function(s, i) { return s + i.amount; }, 0) * 100) / 100;

  // Build output
  var output = '';
  output += 'HOSPITAL: ' + hospital + '\n';
  if (admissions.length) output += 'FACILITY: ' + admissions[0] + '\n';
  if (dateRange) output += 'DATES: ' + dateRange + '\n';
  output += 'TOTAL BILLED: $' + (totalCharges || calcTotal).toFixed(2) + '\n';
  output += 'LINE ITEMS: ' + items.length + ' raw, ' + aggregated.length + ' unique\n';
  output += '\n';
  output += 'CODE | DESCRIPTION | QTY | AMOUNT\n';
  output += '------|-------------|-----|-------\n';

  for (var j = 0; j < aggregated.length; j++) {
    var item = aggregated[j];
    var codePart = item.code || 'NO_CPT';
    var row = codePart + ' | ' + item.desc + ' | ' + item.qty + ' | $' + item.amount.toFixed(2) + '\n';

    if ((output + row).length > MAX_CHARS) {
      output += '... (' + (aggregated.length - j) + ' more items truncated)\n';
      break;
    }
    output += row;
  }

  return output;
}

// CLI usage
var file = process.argv[2];
if (!file) {
  console.error('Usage: node extract_bill.js <path-to-pdf>');
  process.exit(1);
}

extractBill(file).then(function(result) {
  console.log(result);
  console.log('--- Token estimate: ~' + Math.ceil(result.length / APPROX_CHARS_PER_TOKEN) + ' tokens ---');
}).catch(function(err) {
  console.error('Error:', err.message);
  process.exit(1);
});
