/**
 * BillXM Harness — Analysis Module
 *
 * Calls the BillXM /api/analyze endpoint with OCR'd text.
 * Uses the isHarness flag so these runs don't inflate public counters.
 */

const fs = require('fs');
const path = require('path');

const { CONFIG_PATH } = require('./paths');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * Send OCR text to the BillXM analysis engine.
 *
 * @param {string} ocrText  - The extracted bill text
 * @param {object} [opts]   - Optional overrides
 * @param {string} [opts.apiUrl]  - Override the API URL
 * @param {string} [opts.tier]    - Override the tier (default: "full")
 * @param {number} [opts.timeout] - Timeout in ms
 * @returns {object} The parsed analysis report
 */
async function analyzeBill(ocrText, opts) {
  opts = opts || {};
  const config = loadConfig();
  const analysisConfig = config.analysis || {};

  const apiUrl = opts.apiUrl || analysisConfig.api_url || 'https://www.billxm.com/api/analyze';
  const tier = opts.tier || analysisConfig.tier || 'full';
  const timeoutMs = (opts.timeout || analysisConfig.timeout_seconds || 120) * 1000;

  const payload = {
    messages: [{ role: 'user', content: ocrText }],
    tier: tier,
    isHarness: true
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`API returned ${response.status}: ${errBody.substring(0, 200)}`);
    }

    const result = await response.json();

    // The API returns { content: [{ type: "text", text: "<JSON string>" }] }
    let report;
    if (result.content && Array.isArray(result.content)) {
      const textBlock = result.content.find(b => b.type === 'text');
      if (textBlock && textBlock.text) {
        try {
          report = JSON.parse(textBlock.text);
        } catch (_) {
          report = { raw_text: textBlock.text };
        }
      }
    }

    if (!report) {
      report = result;
    }

    return {
      success: true,
      report: report,
      api_url: apiUrl,
      tier: tier
    };

  } catch (err) {
    if (err.name === 'AbortError') {
      return { success: false, error: `Analysis timed out after ${timeoutMs / 1000}s`, api_url: apiUrl };
    }
    return { success: false, error: err.message, api_url: apiUrl };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { analyzeBill };
