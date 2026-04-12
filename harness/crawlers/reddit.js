/**
 * BillXM Harness — Reddit Crawler
 *
 * Searches targeted subreddits for posts containing medical bill images.
 * Uses Reddit's public JSON API (no auth required).
 * Downloads images to harness/inbox/ for the watcher to process.
 *
 * Rate limiting: max 60 req/min, 1s delay between requests.
 */

const fs = require('fs');
const path = require('path');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(HARNESS_ROOT, 'inbox');
const CONFIG_PATH = path.join(HARNESS_ROOT, 'config.json');
const SEEN_PATH = path.join(HARNESS_ROOT, 'seen_urls.json');

const USER_AGENT = 'BillXM-Harness/1.0 (medical bill research)';

// Image host patterns that indicate a direct image link
const IMAGE_HOSTS = [
  'i.redd.it',
  'i.imgur.com',
  'preview.redd.it'
];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

// ── Config ──────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function loadSeenUrls() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch (_) {
    return new Set();
  }
}

function saveSeenUrls(seenSet) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seenSet], null, 2));
}

// ── Helpers ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Extract a direct image URL from a Reddit post object.
 * Returns the URL string or null if no image found.
 */
function extractImageUrl(post) {
  const url = post.url || '';
  const domain = post.domain || '';

  // Direct image link (i.redd.it, i.imgur.com)
  if (IMAGE_HOSTS.some(h => domain.includes(h) || url.includes(h))) {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(ext)) return url;
    // i.redd.it sometimes has no extension — assume jpg
    if (domain === 'i.redd.it' && !ext) return url + '.jpg';
    return url;
  }

  // Reddit gallery — take the first image from media_metadata
  if (post.is_gallery && post.media_metadata) {
    const keys = Object.keys(post.media_metadata);
    for (const key of keys) {
      const item = post.media_metadata[key];
      if (item.s && item.s.u) {
        // URL is HTML-encoded in the API
        return item.s.u.replace(/&amp;/g, '&');
      }
    }
  }

  // Reddit-hosted image in preview
  if (post.preview && post.preview.images && post.preview.images.length > 0) {
    const source = post.preview.images[0].source;
    if (source && source.url) {
      return source.url.replace(/&amp;/g, '&');
    }
  }

  // Imgur page (not direct image) — try appending .jpg
  if (domain === 'imgur.com' && !url.includes('/a/') && !url.includes('/gallery/')) {
    return url + '.jpg';
  }

  return null;
}

/**
 * Determine the file extension from a URL.
 */
function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(ext)) return ext;
  } catch (_) {}
  return '.jpg'; // default
}

/**
 * Download a file from a URL and save it to the inbox.
 * Returns the local path or null on failure.
 */
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
    // Skip tiny files (< 10KB) — likely thumbnails or errors
    if (buffer.length < 10000) {
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

/**
 * Save metadata alongside the downloaded image.
 * Stored as {filename_without_ext}_meta.json in inbox/
 */
async function saveMetadata(filename, meta) {
  const base = path.basename(filename, path.extname(filename));
  const metaPath = path.join(INBOX, `${base}_meta.json`);
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

// ── Search a single subreddit ───────────────────────────────────

async function searchSubreddit(subreddit, query, config, seenUrls, log) {
  const maxPosts = (config.sources && config.sources.reddit && config.sources.reddit.max_posts_per_subreddit) || 50;
  const minUpvotes = (config.sources && config.sources.reddit && config.sources.reddit.min_upvotes) || 5;

  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&sort=new&limit=${Math.min(maxPosts, 100)}&restrict_sr=on&t=month`;

  log(`  GET r/${subreddit} q="${query}"`);

  let data;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!response.ok) {
      log(`  HTTP ${response.status} from r/${subreddit}`);
      return [];
    }
    data = await response.json();
  } catch (err) {
    log(`  FETCH ERROR r/${subreddit}: ${err.message}`);
    return [];
  }

  const posts = (data.data && data.data.children) || [];
  const results = [];

  for (const child of posts) {
    const post = child.data;
    if (!post) continue;

    // Skip low-quality posts
    if ((post.ups || 0) < minUpvotes) continue;

    // Skip already-seen posts
    const postUrl = post.url || '';
    const permalink = `https://www.reddit.com${post.permalink || ''}`;
    if (seenUrls.has(permalink) || seenUrls.has(postUrl)) continue;

    // Try to extract an image URL
    const imageUrl = extractImageUrl(post);
    if (!imageUrl) continue;

    // Skip already-seen image URLs
    if (seenUrls.has(imageUrl)) continue;

    results.push({
      imageUrl,
      postUrl: permalink,
      title: post.title || '',
      subreddit: post.subreddit || subreddit,
      author: post.author || '',
      upvotes: post.ups || 0,
      created: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : '',
      postId: post.id || ''
    });
  }

  return results;
}

// ── Main crawl function ─────────────────────────────────────────

async function crawlReddit(log) {
  const config = loadConfig();
  const redditConfig = (config.sources && config.sources.reddit) || {};

  if (redditConfig.enabled === false) {
    log('Reddit crawler is disabled in config');
    return { downloaded: 0, skipped: 0, errors: 0 };
  }

  const subreddits = redditConfig.subreddits || ['MedicalBill', 'medical_bills', 'HealthInsurance'];
  const queries = redditConfig.search_queries || ['hospital bill', 'medical bill', 'itemized bill'];

  const seenUrls = loadSeenUrls();
  const initialSeen = seenUrls.size;

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  log(`Reddit crawl starting: ${subreddits.length} subreddits × ${queries.length} queries`);

  for (const subreddit of subreddits) {
    for (const query of queries) {
      let results;
      try {
        results = await searchSubreddit(subreddit, query, config, seenUrls, log);
      } catch (err) {
        log(`  ERROR searching r/${subreddit}: ${err.message}`);
        errors++;
        continue;
      }

      log(`  r/${subreddit} q="${query}": ${results.length} candidates`);

      for (const result of results) {
        // Mark as seen regardless of download success
        seenUrls.add(result.postUrl);
        seenUrls.add(result.imageUrl);

        const ext = extFromUrl(result.imageUrl);
        const filename = `${todayStr()}_reddit_${result.postId}${ext}`;

        const localPath = await downloadImage(result.imageUrl, filename, log);
        if (localPath) {
          await saveMetadata(filename, {
            source: 'reddit',
            subreddit: result.subreddit,
            post_title: result.title,
            post_url: result.postUrl,
            image_url: result.imageUrl,
            author: result.author,
            upvotes: result.upvotes,
            post_date: result.created,
            crawled_at: new Date().toISOString()
          });
          downloaded++;
        } else {
          skipped++;
        }

        // Rate limit: 1 second between downloads
        await sleep(1000);
      }

      // Rate limit: 1 second between API requests
      await sleep(1000);
    }
  }

  // Save updated seen URLs
  saveSeenUrls(seenUrls);
  const newSeen = seenUrls.size - initialSeen;

  log(`Reddit crawl complete: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors, ${newSeen} new URLs tracked`);

  return { downloaded, skipped, errors, newSeen };
}

module.exports = { crawlReddit, searchSubreddit, extractImageUrl, downloadImage };
