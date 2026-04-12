/**
 * BillXM Harness — Image Search Crawler
 *
 * Searches for medical bill images using Bing Images (Google Images
 * requires JS rendering and is not scrapeable via simple fetch).
 *
 * Bing returns full-size image URLs in parseable m= attributes.
 * Filters out stock photo domains per config.
 */

const fs = require('fs');
const path = require('path');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(HARNESS_ROOT, 'inbox');
const CONFIG_PATH = path.join(HARNESS_ROOT, 'config.json');
const SEEN_PATH = path.join(HARNESS_ROOT, 'seen_urls.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Config / state ──────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}

function loadSeenUrls() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch (_) { return new Set(); }
}

function saveSeenUrls(seenSet) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seenSet], null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// Default stock photo domains to skip
const DEFAULT_SKIP_DOMAINS = [
  'istockphoto.com', 'gettyimages.com', 'shutterstock.com',
  'dreamstime.com', 'alamy.com', 'stock.adobe.com', 'depositphotos.com',
  '123rf.com', 'bigstockphoto.com', 'canstockphoto.com',
  'pdffiller.com', 'template.net', 'sampletemplates.com',
  'formswift.com', 'invoicehome.com'
];

// ── Bing Images search ──────────────────────────────────────────

/**
 * Search Bing Images and return parsed results.
 * Each result: { imageUrl, sourceUrl, description, width, height }
 */
async function searchBingImages(query, log) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large&form=IRFLTR&first=1`;

  let html;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!response.ok) {
      log(`  Bing returned HTTP ${response.status} for "${query}"`);
      return [];
    }
    html = await response.text();
  } catch (err) {
    log(`  Bing fetch error for "${query}": ${err.message}`);
    return [];
  }

  // Parse m= attributes containing image metadata as HTML-encoded JSON
  const results = [];
  const re = /m="(\{[^"]+\})"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const decoded = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      const obj = JSON.parse(decoded);
      if (obj.murl) {
        results.push({
          imageUrl: obj.murl,
          sourceUrl: obj.purl || '',
          description: obj.desc || obj.t || '',
          width: obj.mw || 0,
          height: obj.mh || 0
        });
      }
    } catch (_) {}
  }

  return results;
}

// ── Download ────────────────────────────────────────────────────

async function downloadImage(imageUrl, filename, log) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!response.ok) {
      log(`  DOWNLOAD FAIL ${filename}: HTTP ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    // Skip non-image responses (HTML error pages, etc.)
    if (!contentType.includes('image') && !contentType.includes('octet-stream')) {
      log(`  SKIP ${filename}: not an image (${contentType})`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // Skip tiny files (<15KB) — thumbnails, icons, errors
    if (buffer.length < 15000) {
      log(`  SKIP ${filename}: too small (${buffer.length} bytes)`);
      return null;
    }

    const dest = path.join(INBOX, filename);
    await fs.promises.writeFile(dest, buffer);
    log(`  SAVED ${filename} (${Math.round(buffer.length / 1024)}KB)`);
    return dest;
  } catch (err) {
    if (err.name === 'AbortError') {
      log(`  SKIP ${filename}: download timed out`);
    } else {
      log(`  DOWNLOAD ERROR ${filename}: ${err.message}`);
    }
    return null;
  }
}

// ── Extension from URL ──────────────────────────────────────────

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return ext;
  } catch (_) {}
  return '.jpg';
}

// ── Main crawl function ─────────────────────────────────────────

async function crawlImages(log) {
  const config = loadConfig();
  const imgConfig = (config.sources && config.sources.google_images) || {};

  if (imgConfig.enabled === false) {
    log('Image search crawler is disabled in config');
    return { downloaded: 0, skipped: 0, errors: 0 };
  }

  const queries = imgConfig.search_queries || ['itemized hospital bill', 'medical bill charges CPT'];
  const skipDomains = imgConfig.skip_domains || DEFAULT_SKIP_DOMAINS;

  const seenUrls = loadSeenUrls();
  const initialSeen = seenUrls.size;

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  log(`Image search crawl starting: ${queries.length} queries (via Bing Images)`);

  for (const query of queries) {
    log(`  Searching: "${query}"`);

    let results;
    try {
      results = await searchBingImages(query, log);
    } catch (err) {
      log(`  ERROR searching "${query}": ${err.message}`);
      errors++;
      continue;
    }

    // Filter out stock photo domains
    const filtered = results.filter(r => {
      const combined = (r.imageUrl + ' ' + r.sourceUrl).toLowerCase();
      return !skipDomains.some(d => combined.includes(d));
    });

    const stockRemoved = results.length - filtered.length;
    log(`  "${query}": ${results.length} results, ${stockRemoved} stock photos filtered → ${filtered.length} candidates`);

    for (const result of filtered) {
      // Skip already-seen
      if (seenUrls.has(result.imageUrl) || seenUrls.has(result.sourceUrl)) {
        continue;
      }

      seenUrls.add(result.imageUrl);
      if (result.sourceUrl) seenUrls.add(result.sourceUrl);

      const ext = extFromUrl(result.imageUrl);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const filename = `${todayStr()}_google_${id}${ext}`;

      const localPath = await downloadImage(result.imageUrl, filename, log);
      if (localPath) {
        // Save metadata
        const base = path.basename(filename, ext);
        await fs.promises.writeFile(
          path.join(INBOX, `${base}_meta.json`),
          JSON.stringify({
            source: 'google_images',
            search_engine: 'bing',
            query: query,
            image_url: result.imageUrl,
            source_page: result.sourceUrl,
            description: result.description,
            crawled_at: new Date().toISOString()
          }, null, 2)
        );
        downloaded++;
      } else {
        skipped++;
      }

      // Rate limit
      await sleep(1500);
    }

    // Delay between queries
    await sleep(2000);
  }

  saveSeenUrls(seenUrls);
  const newSeen = seenUrls.size - initialSeen;
  log(`Image search crawl complete: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors, ${newSeen} new URLs tracked`);

  return { downloaded, skipped, errors, newSeen };
}

module.exports = { crawlImages, searchBingImages };
