#!/usr/bin/env node

/**
 * Website Link Crawler with WebSocket Support
 *
 * This version outputs JSON events to stdout for WebSocket communication
 */

// Import required packages
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const URLParse = require('url-parse');
const { URL } = require('url');
const { createClient } = require('redis');

// Configuration from environment variables
const config = {
  websiteUrl: process.env.WEBSITE_URL || 'https://example.com',
  maxDepth: parseInt(process.env.MAX_DEPTH || '10', 10),
  concurrency: parseInt(process.env.CONCURRENCY || '5', 10),
  redisHost: process.env.REDIS_HOST || '127.0.0.1',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || '',
  redisDb: parseInt(process.env.REDIS_DB || '0', 10),
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || 'tracer:',
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '10000', 10),
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (compatible; TraceBot/1.0)',
  cleanupRedis: process.env.CLEANUP_REDIS === 'true' || false,
  skipDataImages: process.env.SKIP_DATA_IMAGES !== 'false' || true,
  excludePatterns: process.env.EXCLUDE_PATTERNS ? process.env.EXCLUDE_PATTERNS.split(',').map(p => p.trim()) : []
};

// Create Redis client
let redisClient;

// Helper functions for Redis operations
async function createRedisClient() {
  try {
    const client = createClient({
      url: `redis://${config.redisPassword ? config.redisPassword + '@' : ''}${config.redisHost}:${config.redisPort}/${config.redisDb}`,
    });

    client.on('error', err => emitError('Redis Client Error: ' + err.message));
    await client.connect();
    return client;
  } catch (error) {
    emitError('Failed to create Redis client: ' + error.message);
    process.exit(1);
  }
}

// Queue for managing crawl tasks
const queue = [];
let activeTasks = 0;
const MAX_ACTIVE_TASKS = config.concurrency;

// Visited URLs to prevent duplicate crawling
const visitedUrls = new Set();

// Parse URL to get base domain and protocol
const baseUrl = new URLParse(config.websiteUrl);
const baseDomain = baseUrl.hostname;
const baseProtocol = baseUrl.protocol;

// Asset types to track
const ASSET_TYPES = {
  LINK: 'link',
  CSS: 'css',
  SCRIPT: 'script',
  IMAGE: 'image',
  OTHER: 'other'
};

// WebSocket event emitters
function emitEvent(type, data) {
  console.log(JSON.stringify({ type, ...data }));
}

function emitProgress(checked, total) {
  emitEvent('progress', { checked, total });
}

function emitUrlChecked(url, status, domain, sourcePages) {
  emitEvent('url-checked', { url, status, domain, sourcePages: sourcePages || [] });
}

function emitError(message) {
  console.error(message);
}

function emitSummary(stats) {
  emitEvent('summary', { stats });
}

/**
 * Check if a URL is an inbound link (same domain)
 */
function isInboundLink(url) {
  try {
    const parsedUrl = new URLParse(url);
    return parsedUrl.hostname === baseDomain;
  } catch (e) {
    return false;
  }
}

/**
 * Get domain from URL
 */
function getDomain(url) {
  try {
    const parsedUrl = new URLParse(url);
    return parsedUrl.hostname;
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Normalize URL to prevent duplicate crawling of the same resource
 */
function normalizeUrl(url, baseUrl) {
  try {
    // Fix protocol-relative URLs
    if (url.startsWith('//')) {
      url = `https:${url}`;
    }

    // If URL is relative, make it absolute
    if (url.startsWith('/')) {
      url = `${baseProtocol}//${baseDomain}${url}`;
    } else if (!url.startsWith('http')) {
      // Handle relative paths without leading slash
      const base = baseUrl.split('/').slice(0, -1).join('/');
      url = `${base}/${url}`;
    }

    // Remove trailing slash
    url = url.replace(/\/$/, '');

    // Remove hash part
    url = url.split('#')[0];

    // Remove some common query parameters that don't affect content
    try {
      const parsedUrl = new URL(url);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(param => {
        parsedUrl.searchParams.delete(param);
      });
      url = parsedUrl.toString();
    } catch (e) {
      // Ignore URL parsing errors
    }
  } catch (e) {
    // Ignore normalization errors
  }

  return url;
}

/**
 * Determine the type of asset from URL or tag
 */
function getAssetType(url, tag) {
  if (tag === 'a') return ASSET_TYPES.LINK;
  if (tag === 'link' && url.match(/\.css($|\?)/i)) return ASSET_TYPES.CSS;
  if (tag === 'script') return ASSET_TYPES.SCRIPT;
  if (tag === 'img') return ASSET_TYPES.IMAGE;
  if (url.match(/\.(jpg|jpeg|png|gif|svg|webp|ico)($|\?)/i)) return ASSET_TYPES.IMAGE;
  if (url.match(/\.(css)($|\?)/i)) return ASSET_TYPES.CSS;
  if (url.match(/\.(js)($|\?)/i)) return ASSET_TYPES.SCRIPT;
  return ASSET_TYPES.OTHER;
}

/**
 * Store crawl results in Redis
 */
async function storeResult(url, data) {
  try {
    // Ensure we have a valid status code
    if (data.status === undefined || data.status === null) {
      data.status = 0;
    }

    // Generate a Redis key for the URL
    const key = `${config.redisKeyPrefix}${Buffer.from(url).toString('base64')}`;
    const sourcePagesKey = `${config.redisKeyPrefix}sources:${Buffer.from(url).toString('base64')}`;

    // Process and convert data to strings
    const processedData = {};
    for (const [field, value] of Object.entries(data)) {
      processedData[field] = (value === null || value === undefined) ? '' : String(value);
    }

    // Store the data in Redis
    await redisClient.hSet(key, processedData);

    // Add URL to all_urls set
    await redisClient.sAdd(`${config.redisKeyPrefix}all_urls`, url);

    // Store source pages where this link was found
    if (data.referrer) {
      await redisClient.sAdd(sourcePagesKey, data.referrer);
    }

    if (data.sourcePages && Array.isArray(data.sourcePages)) {
      for (const sourcePage of data.sourcePages) {
        if (sourcePage) {
          await redisClient.sAdd(sourcePagesKey, sourcePage);
        }
      }
    }

    // Add URL to type set
    if (data.type) {
      await redisClient.sAdd(`${config.redisKeyPrefix}type:${data.type}`, url);
    }

    // Add URL to status set
    await redisClient.sAdd(`${config.redisKeyPrefix}status:${data.status}`, url);

    // Emit progress event
    if (data.status !== 0) {
      // Parse sourcePages from JSON string
      let sourcePages = [];
      try {
        if (data.sourcePages) {
          sourcePages = typeof data.sourcePages === 'string' ? JSON.parse(data.sourcePages) : data.sourcePages;
        }
      } catch (e) {
        // Ignore parse errors
      }
      emitUrlChecked(url, data.status, getDomain(url), sourcePages);
    }
  } catch (error) {
    emitError(`Error storing result for ${url}: ${error.message}`);
  }
}

/**
 * Extract links from HTML content
 */
function extractLinks($, baseUrl) {
  const links = [];

  // Extract href links
  $('a').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('data:image')) {
      links.push({
        url: normalizeUrl(href, baseUrl),
        tag: 'a',
        text: $(elem).text().trim()
      });
    }
  });

  // Extract CSS links
  $('link[rel="stylesheet"], link[type="text/css"]').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href) {
      links.push({
        url: normalizeUrl(href, baseUrl),
        tag: 'link',
        rel: $(elem).attr('rel')
      });
    }
  });

  // Extract scripts
  $('script').each((i, elem) => {
    const src = $(elem).attr('src');
    if (src) {
      links.push({
        url: normalizeUrl(src, baseUrl),
        tag: 'script'
      });
    }
  });

  // Extract images
  $('img').each((i, elem) => {
    const src = $(elem).attr('src');
    if (src && !src.startsWith('data:image')) {
      links.push({
        url: normalizeUrl(src, baseUrl),
        tag: 'img',
        alt: $(elem).attr('alt') || ''
      });
    }
  });

  return links;
}

/**
 * Check if a URL matches any of the exclusion patterns
 */
function isUrlExcluded(url) {
  if (!config.excludePatterns || config.excludePatterns.length === 0) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;

    return config.excludePatterns.some(pattern => pathname.startsWith(pattern));
  } catch (error) {
    return false;
  }
}

/**
 * Check if a URL should be crawled
 */
async function shouldCrawlUrl(url, referrer = '', depth = 0, sourcePages = []) {
  if (depth > config.maxDepth) return false;
  if (config.skipDataImages && url.startsWith('data:image')) return false;
  if (isUrlExcluded(url)) return false;
  return true;
}

/**
 * Check a single URL and extract links if needed
 */
async function checkUrl(url, referrer = '', depth = 0, sourcePages = []) {
  if (!await shouldCrawlUrl(url, referrer, depth, sourcePages)) {
    return;
  }

  // If we've already visited this URL, just add the new source page to the existing record
  if (visitedUrls.has(url)) {
    if (referrer) {
      const sourcePagesKey = `${config.redisKeyPrefix}sources:${Buffer.from(url).toString('base64')}`;
      await redisClient.sAdd(sourcePagesKey, referrer);
    }
    return;
  }

  visitedUrls.add(url);

  // Skip data URLs and treat them as status 200
  if (url.startsWith('data:image')) {
    if (config.skipDataImages) {
      await storeResult(url, {
        url: url.substring(0, 100) + '... (truncated)',
        originalUrl: url,
        status: 200,
        contentType: 'image/embedded',
        finalUrl: url,
        isRedirect: 0,
        referrer,
        depth,
        type: ASSET_TYPES.IMAGE,
        checkedAt: new Date().toISOString(),
        isInbound: 1,
        isDataImage: 1,
        sourcePages: JSON.stringify(sourcePages || [])
      });
      return;
    }
  }

  // Emit progress
  emitProgress(visitedUrls.size, visitedUrls.size + queue.length);

  // Determine if the URL is potentially an HTML resource or an asset like script, image, CSS, etc.
  const assetType = getAssetType(url, '');
  const shouldGetFullResponse = assetType === ASSET_TYPES.LINK;

  try {
    // Use HEAD for non-HTML resources to save bandwidth
    const method = shouldGetFullResponse ? 'get' : 'head';
    const response = await axios[method](url, {
      maxRedirects: 5,
      timeout: config.requestTimeout,
      validateStatus: false,
      headers: {
        'User-Agent': config.userAgent
      }
    });

    const statusCode = response.status;
    const finalUrl = response.request.res.responseUrl || url;
    const isRedirect = finalUrl !== url;
    const contentType = response.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    // Determine if inbound or outbound
    const isInbound = isInboundLink(url);

    // If we've used HEAD method and detected HTML content, we need to get the full response
    if (!shouldGetFullResponse && isHtml && isInbound && depth < config.maxDepth) {
      const fullResponse = await axios.get(url, {
        maxRedirects: 5,
        timeout: config.requestTimeout,
        validateStatus: false,
        headers: {
          'User-Agent': config.userAgent
        }
      });
      response.data = fullResponse.data;
    }

    // Store the result
    await storeResult(url, {
      url,
      status: statusCode,
      contentType,
      finalUrl: finalUrl,
      isRedirect: isRedirect ? 1 : 0,
      referrer,
      depth,
      type: isHtml ? ASSET_TYPES.LINK : getAssetType(url, ''),
      checkedAt: new Date().toISOString(),
      isInbound: isInbound ? 1 : 0,
      sourcePages: JSON.stringify(sourcePages || [])
    });

    // If HTML content and inbound link, extract links for further crawling
    if (isHtml && isInbound && depth < config.maxDepth) {
      const $ = cheerio.load(response.data);
      const links = extractLinks($, url);

      for (const link of links) {
        const assetType = getAssetType(link.url, link.tag);
        const isInbound = isInboundLink(link.url);

        // For inbound links, add to crawl queue if not yet visited
        if (isInbound && !visitedUrls.has(link.url)) {
          queue.push({
            url: link.url,
            referrer: url,
            depth: depth + 1,
            sourcePages: [...(sourcePages || []), url]
          });
        }
        // For outbound links, just check status but don't crawl
        else if (!isInbound && !visitedUrls.has(link.url)) {
          queue.push({
            url: link.url,
            referrer: url,
            depth: config.maxDepth,
            sourcePages: [...(sourcePages || []), url]
          });
        }

        // Store link in Redis
        await storeResult(link.url, {
          url: link.url,
          referrer: url,
          type: assetType,
          isInbound: isInbound ? 1 : 0,
          tag: link.tag,
          text: link.text || '',
          alt: link.alt || '',
          checkedAt: null,
          sourcePages: JSON.stringify([...(sourcePages || []), url])
        });
      }
    }
  } catch (error) {
    // Store error information
    await storeResult(url, {
      url,
      status: error.response?.status || 0,
      error: error.message,
      referrer,
      depth,
      type: getAssetType(url, ''),
      checkedAt: new Date().toISOString(),
      isInbound: isInboundLink(url) ? 1 : 0,
      sourcePages: JSON.stringify(sourcePages || [])
    });
  }
}

/**
 * Process the queue
 */
async function processQueue() {
  try {
    // If queue is empty and no active tasks, finish
    if (queue.length === 0 && activeTasks === 0) {
      await generateCrawlSummary();
      return;
    }

    // Fill up tasks to max concurrency
    while (activeTasks < MAX_ACTIVE_TASKS && queue.length > 0) {
      const task = queue.shift();
      activeTasks++;

      checkUrl(task.url, task.referrer, task.depth, task.sourcePages).finally(() => {
        activeTasks--;
        // Schedule next process
        setTimeout(processQueue, 0);
      });
    }
  } catch (error) {
    emitError('Error in processQueue: ' + error.message);
    if (redisClient) {
      await redisClient.quit().catch(() => {});
    }
    process.exit(1);
  }
}

/**
 * Generate crawl summary
 */
async function generateCrawlSummary() {
  try {
    const stats = {
      total: visitedUrls.size,
      checked: visitedUrls.size
    };

    emitSummary(stats);

    // Clean up and exit
    await redisClient.quit().catch(() => {});
    process.exit(0);
  } catch (err) {
    emitError('Error in summary generation: ' + err.message);
    if (redisClient) {
      await redisClient.quit().catch(() => {});
    }
    process.exit(1);
  }
}

/**
 * Main function to start the crawler
 */
async function main() {
  try {
    // Initialize Redis client
    redisClient = await createRedisClient();

    // Check if we should clean up previous Redis data
    if (config.cleanupRedis) {
      const keys = await redisClient.keys(`${config.redisKeyPrefix}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    }

    // Add the start URL to the queue
    queue.push({
      url: config.websiteUrl,
      referrer: '',
      depth: 0
    });

    // Start processing the queue
    processQueue();
  } catch (error) {
    emitError('Error in main function: ' + error.message);
    if (redisClient) {
      await redisClient.quit().catch(() => {});
    }
    process.exit(1);
  }
}

// Start the crawler
main().catch(err => {
  emitError('Error in main crawler execution: ' + err.message);
  process.exit(1);
});
