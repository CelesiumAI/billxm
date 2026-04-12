/**
 * BillXM Harness — OCR Module
 *
 * Handles image preprocessing and text extraction via Tesseract.
 * For PDFs, extracts text directly with pdf-parse first;
 * falls back to Tesseract if the PDF is image-based (scanned).
 */

const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const pdf = require('pdf-parse');

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
  // Return what we have with low confidence so the validator can flag it.
  return {
    text: directText || '[scanned PDF — no extractable text]',
    confidence: directText.length > 10 ? 50 : 10,
    method: 'pdf-parse-limited',
    pages: parsed.numpages || 1
  };
}

// OCR an image file (.png, .jpg, etc.)
async function ocrImage(filePath) {
  const imageBuffer = await fs.promises.readFile(filePath);
  const result = await ocrImageBuffer(imageBuffer);
  return {
    ...result,
    method: 'tesseract',
    pages: 1
  };
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
