/**
 * BillXM Harness — GoFundMe Crawler
 *
 * Searches GoFundMe for medical campaigns and downloads bill images.
 *
 * GoFundMe renders search results client-side (React/Next.js), so
 * simple fetch returns empty results. Two approaches:
 *
 *   1. Puppeteer (headless browser) — full JS rendering, works reliably
 *      Requires: npm install puppeteer
 *      Enable by setting USE_PUPPETEER = true below
 *
 *   2. GoFundMe Discover API — undocumented endpoint that may return
 *      JSON results directly. Less reliable but doesn't need a browser.
 *
 * Currently defaults to the API approach with Puppeteer as fallback.
 */

const fs = require('fs');
const path = require('path');

const { INBOX, CONFIG_PATH, SEEN_PATH } = require('../paths');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Set to true once puppeteer is installed (npm install puppeteer)
const USE_PUPPETEER = true;

// ── Shared helpers ──────────────────────────────────────────────

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

/**
 * Heuristic: is this image likely a bill document (not a profile photo)?
 * Bill photos tend to be portrait orientation and larger file sizes.
 */
function looksLikeBillImage(width, height, fileSize) {
  // Portrait or square, reasonably large
  if (height > width * 0.8 && fileSize > 30000) return true;
  // Very large file regardless of orientation (high-res scan)
  if (fileSize > 200000) return true;
  return false;
}

async function downloadImage(imageUrl, filename, log) {
  try {
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow'
    });
    if (!response.ok) {
      log(`  DOWNLOAD FAIL ${filename}: HTTP ${response.status}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 15000) {
      log(`  SKIP ${filename}: too small (${buffer.length} bytes)`);
      return null;
    }
    const dest = path.join(INBOX, filename);
    await fs.promises.writeFile(dest, buffer);
    log(`  SAVED ${filename} (${Math.round(buffer.length / 1024)}KB)`);
    return dest;
  } catch (err) {
    log(`  DOWNLOAD ERROR ${filename}: ${err.message}`);
    return null;
  }
}

// ── Approach 1: GoFundMe Discover/Search API ────────────────────

async function searchViaApi(query, log) {
  // GoFundMe has an internal search API used by their frontend
  const url = `https://gateway.gofundme.com/web-gateway/v1/feed/search?query=${encodeURIComponent(query)}&limit=20&offset=0`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Referer': 'https://www.gofundme.com/'
      }
    });

    if (!response.ok) {
      log(`  GoFundMe API returned ${response.status} for "${query}"`);
      return [];
    }

    const data = await response.json();
    const results = data.results || data.search_results || data.fundraisers || [];
    return results.map(r => ({
      title: r.title || r.fund_name || '',
      url: r.url || r.fund_url || '',
      photoUrl: r.photo_url || r.fund_photo_url || '',
      campaignId: r.fund_id || r.campaign_id || '',
      raised: r.current_amount || 0,
      goal: r.goal || 0
    }));
  } catch (err) {
    log(`  GoFundMe API error for "${query}": ${err.message}`);
    return [];
  }
}

// ── Approach 2: Puppeteer (headless browser) ────────────────────

async function searchViaPuppeteer(query, log) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (_) {
    log('  Puppeteer not installed — run: npm install puppeteer');
    return [];
  }

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    const searchUrl = `https://www.gofundme.com/s?q=${encodeURIComponent(query)}`;
    log(`  PUPPETEER navigating to ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for search results to render
    await page.waitForSelector('[class*="campaign"], [class*="fundraiser"], a[href*="/f/"]', { timeout: 10000 })
      .catch(() => log('  No campaign elements found — page may have changed'));

    // Extract campaign links and images
    const campaigns = await page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="/f/"]');
      return Array.from(cards).slice(0, 20).map(card => {
        const img = card.querySelector('img');
        return {
          title: card.textContent.trim().substring(0, 100),
          url: card.href,
          photoUrl: img ? img.src : '',
          campaignId: (card.href.match(/\/f\/([^/?]+)/) || [])[1] || ''
        };
      });
    });

    return campaigns;
  } catch (err) {
    log(`  Puppeteer error: ${err.message}`);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ── Scrape campaign page for additional bill images ─────────────

async function scrapeCampaignImages(campaignUrl, log) {
  try {
    const response = await fetch(campaignUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!response.ok) return [];

    const html = await response.text();

    // Look for image URLs in the campaign page HTML
    const imgMatches = html.match(/https:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/gi) || [];

    // Filter to GoFundMe-hosted images (d2g8igdw686xgo.cloudfront.net or similar)
    const gfmImages = imgMatches.filter(url => {
      return url.includes('cloudfront.net') || url.includes('gofundme.com');
    });

    // Deduplicate
    return [...new Set(gfmImages)];
  } catch (err) {
    log(`  Campaign scrape error: ${err.message}`);
    return [];
  }
}

// ── Main crawl function ─────────────────────────────────────────

async function crawlGoFundMe(log) {
  const config = loadConfig();
  const gfmConfig = (config.sources && config.sources.gofundme) || {};

  if (gfmConfig.enabled === false) {
    log('GoFundMe crawler is disabled in config');
    return { downloaded: 0, skipped: 0, errors: 0 };
  }

  const queries = gfmConfig.search_queries || ['hospital bill', 'medical bill', 'surgery cost', 'medical debt'];
  const maxCampaigns = gfmConfig.max_campaigns || 20;
  const seenUrls = loadSeenUrls();
  const initialSeen = seenUrls.size;

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  log(`GoFundMe crawl starting: ${queries.length} queries, max ${maxCampaigns} campaigns each`);

  for (const query of queries) {
    log(`  Searching: "${query}"`);

    // Try API first, fall back to Puppeteer
    let campaigns;
    if (USE_PUPPETEER) {
      campaigns = await searchViaPuppeteer(query, log);
    } else {
      campaigns = await searchViaApi(query, log);
      if (campaigns.length === 0) {
        log(`  API returned 0 results — GoFundMe may require Puppeteer for this query`);
      }
    }

    log(`  Found ${campaigns.length} campaigns for "${query}"`);

    let processed = 0;
    for (const campaign of campaigns) {
      if (processed >= maxCampaigns) break;

      const campaignUrl = campaign.url;
      if (!campaignUrl || seenUrls.has(campaignUrl)) continue;
      seenUrls.add(campaignUrl);
      processed++;

      // Download the main campaign photo
      if (campaign.photoUrl && !seenUrls.has(campaign.photoUrl)) {
        seenUrls.add(campaign.photoUrl);
        const ext = path.extname(new URL(campaign.photoUrl).pathname).toLowerCase() || '.jpg';
        const id = campaign.campaignId || Date.now().toString(36);
        const filename = `${todayStr()}_gofundme_${id}${ext}`;

        const localPath = await downloadImage(campaign.photoUrl, filename, log);
        if (localPath) {
          // Save metadata
          const base = path.basename(filename, ext);
          await fs.promises.writeFile(
            path.join(INBOX, `${base}_meta.json`),
            JSON.stringify({
              source: 'gofundme',
              campaign_title: campaign.title,
              campaign_url: campaignUrl,
              image_url: campaign.photoUrl,
              raised: campaign.raised,
              goal: campaign.goal,
              crawled_at: new Date().toISOString()
            }, null, 2)
          );
          downloaded++;
        } else {
          skipped++;
        }

        await sleep(1000);
      }

      // Optionally scrape campaign page for additional bill images
      // (the main photo is often a profile pic, not the bill itself)
      if (campaignUrl.startsWith('http')) {
        const extraImages = await scrapeCampaignImages(campaignUrl, log);
        for (const imgUrl of extraImages.slice(0, 3)) { // max 3 extra per campaign
          if (seenUrls.has(imgUrl)) continue;
          seenUrls.add(imgUrl);

          const ext = path.extname(new URL(imgUrl).pathname).toLowerCase() || '.jpg';
          const id = (campaign.campaignId || '') + '_' + Date.now().toString(36);
          const filename = `${todayStr()}_gofundme_${id}${ext}`;

          const localPath = await downloadImage(imgUrl, filename, log);
          if (localPath) downloaded++;
          else skipped++;

          await sleep(500);
        }
      }

      await sleep(1000);
    }
  }

  saveSeenUrls(seenUrls);
  const newSeen = seenUrls.size - initialSeen;
  log(`GoFundMe crawl complete: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors, ${newSeen} new URLs tracked`);

  return { downloaded, skipped, errors, newSeen };
}

module.exports = { crawlGoFundMe };
