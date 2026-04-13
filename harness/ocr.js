/**
 * BillXM Harness — OCR Module
 *
 * Handles image preprocessing and text extraction via Tesseract.
 * Falls back to Claude Haiku 4.5 vision when Tesseract extracts < 100 chars.
 * For PDFs, extracts text directly with pdf-parse first.
 */

const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const pdf = require('pdf-parse');

const HAIKU_MIN_CHARS = 100; // Fall back to Haiku if Tesseract gets fewer chars than this

let scheduler = null;

// Initialize a Tesseract scheduler with workers (reused across calls)
async function getScheduler() {
  if (scheduler) return scheduler;
  scheduler = Tesseract.createScheduler();
  // Create 2 workers for parallel page processing
  const workerCount = 2;
  for (let i = 0; i < workerCount; i++) {
    const worker = await Tesseract.createWorker('eng');
    scheduler.addWorker(worker);
  }
  return scheduler;
}

// Preprocess an image buffer for better OCR results
async function preprocessImage(inputBuffer) {
  return sharp(inputBuffer)
    .greyscale()
    .normalize()            // auto contrast enhancement
    .sharpen()              // sharpen text edges
    .toBuffer();
}

// OCR a single image buffer, returns { text, confidence }
async function ocrImageBuffer(imageBuffer) {
  const processed = await preprocessImage(imageBuffer);
  const sched = await getScheduler();
  const { data } = await sched.addJob('recognize', processed);
  return {
    text: data.text,
    confidence: data.confidence
  };
}

// Extract text from a PDF file
// Strategy: try pdf-parse first (works for text-based PDFs).
// If the result is mostly empty, fall back to rendering pages as images and OCR'ing.
async function ocrPdf(filePath) {
  const dataBuffer = await fs.promises.readFile(filePath);

  // Try text extraction first
  let parsed;
  try {
    parsed = await pdf(dataBuffer);
  } catch (err) {
    parsed = { text: '', numpages: 0 };
  }

  const directText = (parsed.text || '').trim();

  // If we got meaningful text (>50 chars), use it directly — much faster than OCR
  if (directText.length > 50) {
    return {
      text: directText,
      confidence: 95,  // direct extraction is high confidence
      method: 'pdf-parse',
      pages: parsed.numpages
    };
  }

  // Scanned/image PDF — Tesseract.js cannot read PDF buffers directly.
  // Try Haiku vision as fallback (only works for single-page-ish PDFs).
  try {
    const haikuText = await ocrWithHaiku(filePath);
    if (haikuText && haikuText.trim().length > 50) {
      return {
        text: haikuText,
        confidence: 85,
        method: 'haiku-vision',
        pages: parsed.numpages || 1
      };
    }
  } catch (err) {
    console.log('Haiku PDF fallback failed:', err.message);
  }

  return {
    text: directText || '[scanned PDF — no extractable text]',
    confidence: directText.length > 10 ? 50 : 10,
    method: 'pdf-parse-limited',
    pages: parsed.numpages || 1
  };
}

// ── Claude Haiku 4.5 vision fallback ────────────────────────────
// Used when Tesseract extracts too little text (< HAIKU_MIN_CHARS).
// Sends the image to Haiku with a bill-extraction prompt.

function getMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/png'
  };
  return map[ext] || 'image/jpeg';
}

async function ocrWithHaiku(filePath) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null; // No API key — skip fallback
  }

  const imageBuffer = await fs.promises.readFile(filePath);
  const base64 = imageBuffer.toString('base64');
  const mediaType = getMediaType(filePath);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: 'Extract all text from this medical bill image. Include all dollar amounts, procedure codes (CPT/HCPCS), dates, line items, hospital name, patient details, and totals. Reproduce the text exactly as printed, preserving the layout as much as possible. If this is not a medical bill, describe what you see in one sentence.'
          }
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Haiku API ${response.status}: ${err.substring(0, 200)}`);
  }

  const result = await response.json();
  const text = (result.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return text || null;
}

// OCR an image file (.png, .jpg, etc.)
// Tries Tesseract first; falls back to Haiku vision if < HAIKU_MIN_CHARS extracted.
async function ocrImage(filePath) {
  const imageBuffer = await fs.promises.readFile(filePath);
  const result = await ocrImageBuffer(imageBuffer);

  // If Tesseract got enough text, use it
  if (result.text.trim().length >= HAIKU_MIN_CHARS) {
    return { ...result, method: 'tesseract', pages: 1 };
  }

  // Fallback: try Haiku vision
  try {
    const haikuText = await ocrWithHaiku(filePath);
    if (haikuText && haikuText.trim().length > result.text.trim().length) {
      return {
        text: haikuText,
        confidence: 85, // Haiku is generally reliable for text extraction
        method: 'haiku-vision',
        pages: 1
      };
    }
  } catch (err) {
    // Haiku failed — fall through to Tesseract result
    console.log('Haiku vision fallback failed:', err.message);
  }

  // Return Tesseract result even if sparse
  return { ...result, method: 'tesseract', pages: 1 };
}

// Main entry point: OCR any supported file
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    return ocrPdf(filePath);
  }

  return ocrImage(filePath);
}

// Shut down the Tesseract scheduler (call on process exit)
async function terminate() {
  if (scheduler) {
    await scheduler.terminate();
    scheduler = null;
  }
}

module.exports = { extractText, terminate };
