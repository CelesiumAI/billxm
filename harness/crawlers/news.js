/**
 * BillXM Harness — News Article Crawler
 *
 * Searches news sites for articles about outrageous medical bills, then:
 * 1. Extracts embedded bill images from those articles
 * 2. Extracts bill dollar amounts and descriptions from article text for metadata
 *
 * Two approaches:
 *   A. Bing News search (primary) — finds recent articles across all news sites
 *   B. Direct site search (secondary) — targets known bill-roundup sites
 */

const fs = require('fs');
const path = require('path');

const { INBOX, CONFIG_PATH, SEEN_PATH } = require('../paths');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Stock photo domains (shared with google.js)
const DEFAULT_SKIP_DOMAINS = [
  'istockphoto.com', 'gettyimages.com', 'shutterstock.com',
  'dreamstime.com', 'alamy.com', 'stock.adobe.com', 'depositphotos.com',
  '123rf.com', 'bigstockphoto.com', 'canstockphoto.com',
  'pdffiller.com', 'template.net', 'sampletemplates.com',
  'formswift.com', 'invoicehome.com'
];

// Domains/patterns to skip for images (ads, avatars, icons, etc.)
const SKIP_IMAGE_DOMAINS = [
  'gravatar.com', 'facebook.com', 'twitter.com', 'instagram.com',
  'google-analytics.com', 'doubleclick.net', 'adsense',
  'logo', 'icon', 'avatar', 'profile', 'author',
  'ad-', 'advertisement', 'sponsor', 'badge', 'widget',
  ...DEFAULT_SKIP_DOMAINS
];

// Patterns in URL suggesting small/non-bill images
const SKIP_SIZE_PATTERNS = [
  /\d+x\d+/i,        // e.g. 100x100
  /thumbnail/i,
  /thumb/i,
  /favicon/i,
  /sprite/i,
  /pixel/i,
  /1x1/i
];

// Keywords that suggest an image might be a bill photo
const BILL_IMAGE_KEYWORDS = [
  'bill', 'charge', 'statement', 'invoice', 'itemized',
  'cpt', 'eob', 'hospital', 'medical', 'receipt'
];

// Direct sites known to publish bill roundup articles
const DIRECT_SITES = [
  { name: 'buzzfeed', url: 'https://www.buzzfeed.com/search?q=hospital+bill' },
  { name: 'newsweek', url: 'https://www.newsweek.com/search/site/hospital%20bill' },
  { name: 'yahoo', url: 'https://news.yahoo.com/search?p=medical+bill+outrageous' },
  { name: 'distractify', url: 'https://www.distractify.com/search?q=hospital+bill' },
  { name: 'boredpanda', url: 'https://www.boredpanda.com/?s=medical+bill' },
  { name: 'reddit_bestof', url: 'https://www.reddit.com/search.json?q=hospital+bill+image&sort=top&t=month&limit=25' }
];

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

// ── Download (same as google.js) ────────────────────────────────

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
    if (!contentType.includes('image') && !contentType.includes('octet-stream')) {
      log(`  SKIP ${filename}: not an image (${contentType})`);
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
    if (err.name === 'AbortError') {
      log(`  SKIP ${filename}: download timed out`);
    } else {
      log(`  DOWNLOAD ERROR ${filename}: ${err.message}`);
    }
    return null;
  }
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return ext;
  } catch (_) {}
  return '.jpg';
}

// ── Approach A: Bing News search ────────────────────────────────

async function searchBingNews(query, log) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&qft=interval%3d%228%22&form=PTFTNR`;

  let html;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      log(`  Bing News HTTP ${response.status} for "${query}"`);
      return [];
    }
    html = await response.text();
  } catch (err) {
    log(`  Bing News fetch error for "${query}": ${err.message}`);
    return [];
  }

  // Extract article URLs from news card links
  const articleUrls = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*title[^"]*"/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    articleUrls.push(match[1]);
  }

  // Fallback: extract from data-url or news-card patterns
  if (articleUrls.length === 0) {
    const re2 = /url="(https?:\/\/(?!www\.bing\.com)[^"]+)"/gi;
    while ((match = re2.exec(html)) !== null) {
      const decoded = match[1].replace(/&amp;/g, '&');
      if (!decoded.includes('bing.com') && !decoded.includes('microsoft.com')) {
        articleUrls.push(decoded);
      }
    }
  }

  // Another fallback: <a> tags with news-related hrefs
  if (articleUrls.length === 0) {
    const re3 = /href="(https?:\/\/(?!www\.bing\.com|login\.|account\.)[^"]+)"[^>]*>/gi;
    while ((match = re3.exec(html)) !== null) {
      const u = match[1].replace(/&amp;/g, '&');
      if (!u.includes('bing.com') && !u.includes('microsoft.com') && !u.includes('go.microsoft')) {
        articleUrls.push(u);
      }
    }
  }

  // Deduplicate
  return [...new Set(articleUrls)];
}

// ── Approach B: Direct site search ──────────────────────────────

async function searchDirectSites(log) {
  const articleUrls = [];

  for (const site of DIRECT_SITES) {
    log(`  Direct search: ${site.name}`);
    try {
      const response = await fetch(site.url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow'
      });
      if (!response.ok) {
        log(`  ${site.name}: HTTP ${response.status}`);
        await sleep(1000);
        continue;
      }

      // Reddit JSON endpoint
      if (site.name === 'reddit_bestof') {
        const data = await response.json();
        const posts = (data.data && data.data.children) || [];
        for (const child of posts) {
          const post = child.data;
          if (post && post.url && (post.url.includes('i.redd.it') || post.url.includes('imgur'))) {
            articleUrls.push({ url: post.url, site: 'reddit_bestof', title: post.title || '' });
          }
        }
      } else {
        // HTML sites — extract article links
        const html = await response.text();
        const re = /href="(https?:\/\/[^"]*(?:bill|medical|hospital|charge)[^"]*)"/gi;
        let match;
        while ((match = re.exec(html)) !== null) {
          const u = match[1].replace(/&amp;/g, '&');
          articleUrls.push({ url: u, site: site.name, title: '' });
        }
      }
    } catch (err) {
      log(`  ${site.name}: error ${err.message}`);
    }
    await sleep(1000);
  }

  return articleUrls;
}

// ── Article scraping: extract images ────────────────────────────

function shouldSkipImage(imgUrl) {
  const lower = imgUrl.toLowerCase();

  // Skip known non-bill domains/patterns
  if (SKIP_IMAGE_DOMAINS.some(d => lower.includes(d))) return true;

  // Skip small-size patterns in URL
  if (SKIP_SIZE_PATTERNS.some(p => p.test(imgUrl))) {
    // Exception: don't skip if it also has bill keywords
    if (!BILL_IMAGE_KEYWORDS.some(k => lower.includes(k))) return true;
  }

  return false;
}

function hasBillKeywords(imgTag) {
  const lower = imgTag.toLowerCase();
  return BILL_IMAGE_KEYWORDS.some(k => lower.includes(k));
}

async function scrapeArticleImages(articleUrl, log) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(articleUrl, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!response.ok) return { images: [], title: '' };

    const html = await response.text();

    // Extract article title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().substring(0, 200) : '';

    // Extract all image URLs from <img> tags
    const imgRegex = /<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*/gi;
    const candidates = [];
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      const imgUrl = match[1];
      const fullTag = match[0];

      // Must be a full URL
      if (!imgUrl.startsWith('http')) continue;

      // Apply skip filters
      if (shouldSkipImage(imgUrl)) continue;

      // Score: bill-keyword images get priority
      const priority = hasBillKeywords(fullTag) ? 1 : 0;
      candidates.push({ url: imgUrl, priority });
    }

    // Sort: bill-keyword images first
    candidates.sort((a, b) => b.priority - a.priority);

    return {
      images: candidates.map(c => c.url),
      title
    };
  } catch (err) {
    if (err.name !== 'AbortError') {
      log(`  Article scrape error: ${err.message}`);
    }
    return { images: [], title: '' };
  }
}

// ── Main crawl function ─────────────────────────────────────────

async function crawlNews(log) {
  const config = loadConfig();
  const newsConfig = (config.sources && config.sources.news) || {};

  if (newsConfig.enabled === false) {
    log('News crawler is disabled in config');
    return { downloaded: 0, skipped: 0, errors: 0 };
  }

  const queries = newsConfig.search_queries || [
    'outrageous hospital bill', 'medical bill viral', 'itemized hospital charges',
    'hospital bill shocked', 'medical bill thousands', 'ER bill surprise charges',
    'NICU bill parents', 'ambulance bill outrageous', 'surgery bill overcharged patient'
  ];
  const maxArticles = newsConfig.max_articles_per_query || 10;
  const maxImages = newsConfig.max_images_per_article || 5;
  const useDirectSites = newsConfig.direct_sites !== false;

  const seenUrls = loadSeenUrls();
  const initialSeen = seenUrls.size;

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  log(`News crawl starting: ${queries.length} Bing News queries${useDirectSites ? ' + direct sites' : ''}`);

  // ── Approach A: Bing News ──
  for (const query of queries) {
    log(`  Bing News: "${query}"`);

    let articleUrls;
    try {
      articleUrls = await searchBingNews(query, log);
    } catch (err) {
      log(`  ERROR searching Bing News for "${query}": ${err.message}`);
      errors++;
      continue;
    }

    // Limit and dedup
    const unseen = articleUrls.filter(u => !seenUrls.has(u)).slice(0, maxArticles);
    log(`  "${query}": ${articleUrls.length} articles found, ${unseen.length} new`);

    for (const articleUrl of unseen) {
      seenUrls.add(articleUrl);

      const { images, title } = await scrapeArticleImages(articleUrl, log);
      if (images.length === 0) {
        await sleep(2000);
        continue;
      }

      // Derive site name from URL
      let siteName;
      try { siteName = new URL(articleUrl).hostname.replace('www.', '').split('.')[0]; } catch (_) { siteName = 'unknown'; }

      let articleDownloads = 0;
      for (const imgUrl of images.slice(0, maxImages)) {
        if (seenUrls.has(imgUrl)) continue;
        seenUrls.add(imgUrl);

        const ext = extFromUrl(imgUrl);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const filename = `${todayStr()}_news_${siteName}_${id}${ext}`;

        const localPath = await downloadImage(imgUrl, filename, log);
        if (localPath) {
          const base = path.basename(filename, ext);
          await fs.promises.writeFile(
            path.join(INBOX, `${base}_meta.json`),
            JSON.stringify({
              source: 'news_article',
              site: siteName,
              article_url: articleUrl,
              article_title: title,
              image_url: imgUrl,
              crawled_at: new Date().toISOString()
            }, null, 2)
          );
          downloaded++;
          articleDownloads++;
        } else {
          skipped++;
        }

        await sleep(1000);
      }

      if (articleDownloads > 0) {
        log(`  ${siteName}: ${articleDownloads} images from "${title.substring(0, 60)}..."`);
      }

      await sleep(2000);
    }

    await sleep(3000);
  }

  // ── Approach B: Direct sites ──
  if (useDirectSites) {
    log(`  Searching direct sites...`);
    let directResults;
    try {
      directResults = await searchDirectSites(log);
    } catch (err) {
      log(`  Direct sites error: ${err.message}`);
      directResults = [];
    }

    log(`  Direct sites: ${directResults.length} article URLs found`);

    for (const result of directResults) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);

      // For reddit_bestof, the URL IS the image — download directly
      if (result.site === 'reddit_bestof') {
        const ext = extFromUrl(result.url);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const filename = `${todayStr()}_news_reddit_${id}${ext}`;

        const localPath = await downloadImage(result.url, filename, log);
        if (localPath) {
          const base = path.basename(filename, ext);
          await fs.promises.writeFile(
            path.join(INBOX, `${base}_meta.json`),
            JSON.stringify({
              source: 'news_article',
              site: 'reddit_bestof',
              article_url: result.url,
              article_title: result.title,
              image_url: result.url,
              crawled_at: new Date().toISOString()
            }, null, 2)
          );
          downloaded++;
        } else {
          skipped++;
        }
        await sleep(1000);
        continue;
      }

      // For other sites, scrape the article for images
      const { images, title } = await scrapeArticleImages(result.url, log);
      for (const imgUrl of images.slice(0, maxImages)) {
        if (seenUrls.has(imgUrl)) continue;
        seenUrls.add(imgUrl);

        const ext = extFromUrl(imgUrl);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const filename = `${todayStr()}_news_${result.site}_${id}${ext}`;

        const localPath = await downloadImage(imgUrl, filename, log);
        if (localPath) {
          const base = path.basename(filename, ext);
          await fs.promises.writeFile(
            path.join(INBOX, `${base}_meta.json`),
            JSON.stringify({
              source: 'news_article',
              site: result.site,
              article_url: result.url,
              article_title: title || result.title,
              image_url: imgUrl,
              crawled_at: new Date().toISOString()
            }, null, 2)
          );
          downloaded++;
        } else {
          skipped++;
        }
        await sleep(1000);
      }

      await sleep(2000);
    }
  }

  saveSeenUrls(seenUrls);
  const newSeen = seenUrls.size - initialSeen;
  log(`News crawl complete: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors, ${newSeen} new URLs tracked`);

  return { downloaded, skipped, errors, newSeen };
}

module.exports = { crawlNews };
