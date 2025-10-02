#!/usr/bin/env node

/**
 * Website Link Crawler
 * 
 * Crawls a website and checks all links, CSS, images, and scripts.
 * - Follows redirects
 * - Stores results in Redis
 * - Only crawls inbound links (same domain)
 * - Only checks existence of outbound links
 */

// Import required packages
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const URLParse = require('url-parse');
const { URL } = require('url'); // Use Node's native URL for searchParams
const { createClient } = require('redis');
const path = require('path');
const fs = require('fs');

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
  // Exclude patterns - URLs starting with these patterns will be excluded from crawl
  // Format: comma-separated list of URL patterns (e.g., '/blog,/admin,/private')
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
    
    client.on('error', err => console.error('Redis Client Error', err));
    await client.connect();
    return client;
  } catch (error) {
    console.error('Failed to create Redis client:', error);
    process.exit(1);
  }
}

/**
 * Safely add to a Redis set
 */
async function safeSetAdd(key, value) {
  try {
    if (!value) return;
    await redisClient.sAdd(key, value);
  } catch (error) {
    console.error(`Error adding to set ${key}:`, error);
  }
}

/**
 * Safely get Redis set members
 */
async function safeSetMembers(key) {
  try {
    const keyType = await redisClient.type(key);
    if (keyType === 'set') {
      return await redisClient.sMembers(key);
    }
    return [];
  } catch (error) {
    console.error(`Error getting set members for ${key}:`, error);
    return [];
  }
}

/**
 * Safely get a Redis set cardinality
 */
async function safeSetCardinality(key) {
  try {
    const keyType = await redisClient.type(key);
    if (keyType === 'set') {
      return await redisClient.sCard(key);
    }
    return 0;
  } catch (error) {
    console.error(`Error getting set cardinality for ${key}:`, error);
    return 0;
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
      // Use Node's native URL for handling searchParams
      const parsedUrl = new URL(url);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(param => {
        parsedUrl.searchParams.delete(param);
      });
      url = parsedUrl.toString();
    } catch (e) {
      console.log(`Skipping query parameter cleanup for: ${url}`);
      // Don't log the full error as it might be noisy
    }
  } catch (e) {
    console.log(`Error normalizing URL: ${url}`, e);
  }

  return url;
}

/**
 * Truncate a URL for display purposes
 */
function truncateUrl(url, maxLength = 70) {
  if (!url) return '';
  if (url.length <= maxLength) return url;
  
  // Try to preserve the domain part
  try {
    const parsed = new URL(url);
    const domain = `${parsed.protocol}//${parsed.hostname}`;
    
    if (domain.length >= maxLength - 5) {
      // Domain itself is too long, truncate it
      return domain.substring(0, maxLength - 5) + '...';
    }
    
    // Keep domain and truncate path
    const pathMaxLength = maxLength - domain.length - 5;
    const truncatedPath = parsed.pathname.substring(0, pathMaxLength) + '...';
    return `${domain}${truncatedPath}`;
  } catch (e) {
    // If URL parsing fails, just truncate the string
    return url.substring(0, maxLength - 3) + '...';
  }
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
 * Fix protocol-relative URLs (starting with //)
 * @param {string} url - The URL to fix
 * @returns {string} - The fixed URL with https:// protocol
 */
function fixProtocolRelativeUrl(url) {
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  return url;
}

/**
 * Store crawl results in Redis
 */
async function storeResult(url, data) {
  try {
    // Fix protocol-relative URLs
    url = fixProtocolRelativeUrl(url);
    // Ensure we have a valid status code
    if (data.status === undefined || data.status === null) {
      data.status = 0; // Use 0 as a standard value for unknown status
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
    try {
      await redisClient.sAdd(`${config.redisKeyPrefix}all_urls`, url);
    } catch (error) {
      console.error(`Error adding URL to all_urls set: ${error.message}`);
    }
    
    // Store source pages where this link was found
    if (data.referrer) {
      try {
        await redisClient.sAdd(sourcePagesKey, data.referrer);
      } catch (error) {
        console.error(`Error adding referrer to sources: ${error.message}`);
      }
    }
    
    if (data.sourcePages && Array.isArray(data.sourcePages)) {
      for (const sourcePage of data.sourcePages) {
        if (sourcePage) {
          try {
            await redisClient.sAdd(sourcePagesKey, sourcePage);
          } catch (error) {
            console.error(`Error adding source page to sources: ${error.message}`);
          }
        }
      }
    }
    
    // Add URL to type set
    if (data.type) {
      await redisClient.sAdd(`${config.redisKeyPrefix}type:${data.type}`, url);
    }
    
    // Add URL to status set
    await redisClient.sAdd(`${config.redisKeyPrefix}status:${data.status}`, url);
    
    // Display URL and status code in the console in color
    if (data.status!=0) {  
      let statusColor = '\x1b[32m'; // Green for 200s
      if (data.status >= 300 && data.status < 400) statusColor = '\x1b[33m'; // Yellow for 300s
      if (data.status >= 400) statusColor = '\x1b[31m'; // Red for 400s and 500s
      /*console.log(`URL: ${url} - Status: ${statusColor}${data.status}\x1b[0m` + 
                  (data.isRedirect ? ` → ${data.finalUrl}` : ''));*/
    }
  } catch (error) {
    console.error(`Error storing result for ${url}:`, error);
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
    if (src) {
      // Skip data:image URLs from being added to the links array
      if (!src.startsWith('data:image')) {
        links.push({
          url: normalizeUrl(src, baseUrl),
          tag: 'img',
          alt: $(elem).attr('alt') || ''
        });
      }
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

    // Check if URL path starts with any of the exclude patterns
    return config.excludePatterns.some(pattern => {
      return pathname.startsWith(pattern);
    });
  } catch (error) {
    // If URL parsing fails, be conservative and don't exclude
    console.error(`Error checking URL exclusion for ${url}:`, error);
    return false;
  }
}

/**
 * Check if a URL should be crawled
 */
async function shouldCrawlUrl(url, referrer = '', depth = 0, sourcePages = []) {
  // Skip if max depth reached
  if (depth > config.maxDepth) {
    return false;
  }
  
  // Skip data image URLs if configured
  if (config.skipDataImages && url.startsWith('data:image')) {
    return false;
  }

  // Skip URLs that match exclusion patterns
  if (isUrlExcluded(url)) {
    return false;
  }

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
      // Add the referrer to the sources list if it's not already there
      await safeSetAdd(sourcePagesKey, referrer);
    }
    return;
  }
  
  visitedUrls.add(url);
  
  // Skip tracing URLs that start with data:image and treat them as status 200
  if (url.startsWith('data:image')) {
    if (config.skipDataImages) {
      console.log(`\x1b[36m[${depth}]\x1b[0m \x1b[33mSkipping data URL\x1b[0m`);
      
      // Store the result with status code 200
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
        isInbound: 1, // Consider data URLs as internal
        isDataImage: 1,
        sourcePages: JSON.stringify(sourcePages || [])
      });
      
      return;
    }
  }
  
  //console.log(`\x1b[36m[${depth}]\x1b[0m Checking: \x1b[1m${url}\x1b[0m`);
  
  // Determine if the URL is potentially an HTML resource or an asset like script, image, CSS, etc.
  const assetType = getAssetType(url, '');
  const shouldGetFullResponse = assetType === ASSET_TYPES.LINK;
  
  try {
    // Use HEAD for non-HTML resources (scripts, images, CSS, etc.) to save bandwidth
    const method = shouldGetFullResponse ? 'get' : 'head';
    const response = await axios[method](url, {
      maxRedirects: 5,
      timeout: config.requestTimeout,
      validateStatus: false, // Don't throw on error status codes
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
    // to extract links for further crawling
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
            depth: config.maxDepth, // Set to max depth to prevent further crawling
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
          checkedAt: null, // Will be updated when actually checked
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
    
    console.error(`Error checking ${url}: ${error.message}`);
  }
}

/**
 * Safe helper to check if a hash exists in Redis
 */
async function safeHashExists(key) {
  try {
    const keyType = await redisClient.type(key);
    return keyType === 'hash';
  } catch (error) {
    console.error(`Error checking hash type for ${key}:`, error);
    return false;
  }
}

/**
 * Process the queue
 */
async function processQueue() {
  try {
    // If queue is empty and no active tasks, generate summary
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
    console.error('Error in processQueue:', error);
    if (redisClient) {
      await redisClient.quit().catch(() => {});
    }
    process.exit(1);
  }
}

/**
 * Generate crawl summary and report
 */
async function generateCrawlSummary() {
  try {
    console.log('\n\x1b[1;32mCrawl complete! Summary:\x1b[0m');
    console.log(`Total URLs checked: ${visitedUrls.size}`);
    
    // Show counts by type
    for (const type of Object.values(ASSET_TYPES)) {
      const count = await safeSetCardinality(`${config.redisKeyPrefix}type:${type}`);
      console.log(`${type}: ${count}`);
    }
  
    // Count internal vs external URLs safely
    let internalCount = 0;
    let externalCount = 0;
    
    try {
      const urlKeys = await redisClient.keys(`${config.redisKeyPrefix}*`);
      const validKeys = urlKeys.filter(key => 
        !key.includes('all_urls') && 
        !key.includes('type:') && 
        !key.includes('status:') &&
        !key.includes('sources:'));
      
      for (const key of validKeys) {
        try {
          if (await safeHashExists(key)) {
            const isInbound = await redisClient.hGet(key, 'isInbound');
            if (isInbound === '1') {
              internalCount++;
            } else {
              externalCount++;
            }
          }
        } catch (error) {
          console.error(`Error processing key ${key}:`, error);
        }
      }
    } catch (error) {
      console.error('Error counting internal/external URLs:', error);
    }
    
    // External count calculated above
    console.log(`\nInternal URLs: ${internalCount}`);
    console.log(`External URLs: ${externalCount}`);
    
    // Get all status codes
    const statusKeys = await redisClient.keys(`${config.redisKeyPrefix}status:*`);
    const allStatusCodes = statusKeys.map(key => {
      const parts = key.split(':');
      return parts[parts.length - 1];
    });

    // Update the summary table with source URL data
    console.log('\n\x1b[1mSample URLs with source counts:\x1b[0m');
    
    // Get status buckets for internal URLs
    const statusBuckets = {};
    for (const status of allStatusCodes) {
      if(status==0) continue;
      statusBuckets[status] = [];
      const urlsWithStatus = await redisClient.sMembers(`${config.redisKeyPrefix}status:${status}`);
      for (const url of urlsWithStatus) {
        try {
          const urlKey = `${config.redisKeyPrefix}${Buffer.from(url).toString('base64')}`;
          const urlData = await redisClient.hGetAll(urlKey);
          if (urlData.isInbound === '1') {
            statusBuckets[status].push(url);
          }
        } catch (error) {
          console.error(`Error processing URL data for ${url}:`, error);
        }
      }
    }

    // For each status code, show a few sample URLs
    for (const status of Object.keys(statusBuckets)) {
      const internalUrls = statusBuckets[status];
      if (internalUrls.length === 0) continue;
      
      console.log(`\n\x1b[1mStatus ${getColoredStatusCode(status)} (${internalUrls.length} internal URLs):\x1b[0m`);
      const sampleUrls = internalUrls.slice(0, 5);
      for (const url of sampleUrls) {
        const urlKey = `${config.redisKeyPrefix}${Buffer.from(url).toString('base64')}`;
        const sourcePagesKey = `${config.redisKeyPrefix}sources:${Buffer.from(url).toString('base64')}`;
        const statusData = await redisClient.hGetAll(urlKey);
        let sourcePagesCount = 0;
        
        // Safely get source page count
        sourcePagesCount = await safeSetCardinality(sourcePagesKey);
        
        let foundOnText = '';
        if (sourcePagesCount > 0) {
          // Safely get source page samples
          const sourceSamples = await safeSetMembers(sourcePagesKey);
          const sourceToShow = sourceSamples.length > 0 ? sourceSamples[0] : '';
          foundOnText = sourcePagesCount === 1 
            ? ` (found on: ${truncateUrl(sourceToShow, 50)})` 
            : ` (found on ${sourcePagesCount} pages)`;
        }

        console.log(`- ${truncateUrl(url, 100)}${foundOnText}`);
      }
      
      if (internalUrls.length > 5) {
        console.log(`  ... and ${internalUrls.length - 5} more`);
      }
    }
    
    // Prepare the final report data
    const reportData = {
      summary: {
        total: visitedUrls.size,
        internal: internalCount,
        external: externalCount
      },
      types: {},
      statusCodes: {}
    };

    // Add type information
    for (const type of Object.values(ASSET_TYPES)) {
      reportData.types[type] = await safeSetCardinality(`${config.redisKeyPrefix}type:${type}`);
    }

    // Add status code information
    for (const status of allStatusCodes) {
      reportData.statusCodes[status] = {
        total: await safeSetCardinality(`${config.redisKeyPrefix}status:${status}`),
        internal: statusBuckets[status]?.length || 0,
        external: (await safeSetCardinality(`${config.redisKeyPrefix}status:${status}`)) - (statusBuckets[status]?.length || 0)
      };
    }

    // Write report to file
    try {
      const reportPath = path.join(__dirname, 'crawl-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
      console.log(`\nDetailed report written to ${reportPath}`);
    } catch (err) {
      console.error('Error writing report file:', err);
    }
    
    // Add a command reference to the report for looking up source URLs
    console.log('\n\x1b[1mTo view all source URLs for a specific URL:\x1b[0m');
    console.log('  node crawler.js --source "URL_HERE"');
    
    // Clean up and exit
    await redisClient.quit().catch(() => {});
  } catch (err) {
    console.error('Error in summary generation:', err);
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
    console.log(`Starting crawler for ${config.websiteUrl}`);
    console.log(`Max depth: ${config.maxDepth}, Concurrency: ${config.concurrency}`);
        
    // Initialize Redis client
    redisClient = await createRedisClient();
    console.log('Connected to Redis');
        
    // Check if we should clean up previous Redis data
    if (config.cleanupRedis) {
      console.log('Cleaning up previous crawl data from Redis...');
      const keys = await redisClient.keys(`${config.redisKeyPrefix}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
        console.log(`Deleted ${keys.length} keys from previous crawl.`);
      } else {
        console.log('No keys to delete.');
      }
    }
        
    if (config.skipDataImages) {
      console.log('Data image URLs will be skipped and marked with status 200');
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
    console.error('Error in main function:', error);
    if (redisClient) {
      await redisClient.quit().catch(() => {}); // Ignore errors on quit
    }
    process.exit(1);
  }
}

/**
 * Show all source pages for a specific URL
 */
async function showSourcePages(targetUrl) {
  try {
    console.log(`\x1b[1mFinding source pages for:\x1b[0m ${targetUrl}`);
    
    // Connect to Redis
    redisClient = await createRedisClient();
    console.log('Connected to Redis');
    
    const urlKey = `${config.redisKeyPrefix}${Buffer.from(targetUrl).toString('base64')}`;
    const sourcePagesKey = `${config.redisKeyPrefix}sources:${Buffer.from(targetUrl).toString('base64')}`;
    
    // Check if URL exists
    const exists = await redisClient.exists(urlKey);
    if (!exists) {
      console.log('\x1b[33mURL not found in the crawl database\x1b[0m');
      return;
    }
    
    // Get URL data
    const urlData = await redisClient.hGetAll(urlKey);
    console.log('\n\x1b[1mURL information:\x1b[0m');
    console.log(`Status: ${getColoredStatusCode(urlData.status)}`);
    console.log(`Type: ${urlData.type || 'unknown'}`);
    console.log(`Is internal: ${urlData.isInbound === '1' ? 'Yes' : 'No'}`);
    
    if (urlData.isRedirect === '1') {
      console.log(`Redirects to: ${urlData.finalUrl}`);
    }
    
    // Get source pages
    const sourcePages = await safeSetMembers(sourcePagesKey);
    
    console.log(`\n\x1b[1mFound on ${sourcePages.length} page(s):\x1b[0m`);
    if (sourcePages.length === 0) {
      console.log('No source pages recorded (this might be the starting URL)');
    } else {
      sourcePages.forEach(sourcePage => {
        console.log(`- ${sourcePage}`);
      });
    }
  } catch (error) {
    console.error('Error showing source pages:', error);
  } finally {
    if (redisClient) {
      await redisClient.quit().catch(() => {}); // Ignore errors on quit
    }
  }
}

/**
 * Get colored status code for console output
 */
function getColoredStatusCode(status) {
  const statusNum = parseInt(status, 10);
  if (statusNum >= 200 && statusNum < 300) return `\x1b[32m${status}\x1b[0m`; // Green
  if (statusNum >= 300 && statusNum < 400) return `\x1b[33m${status}\x1b[0m`; // Yellow
  if (statusNum >= 400) return `\x1b[31m${status}\x1b[0m`; // Red
  return `\x1b[37m${status}\x1b[0m`; // White/Default
}

// Check for command line arguments
if (process.argv.includes('--source') && process.argv.length > 3) {
  const sourceIndex = process.argv.indexOf('--source');
  if (sourceIndex >= 0 && sourceIndex + 1 < process.argv.length) {
    const targetUrl = process.argv[sourceIndex + 1];
    showSourcePages(targetUrl).catch(err => {
      console.error('Error showing source pages:', err);
      process.exit(1);
    });
  } else {
    console.error('Please provide a URL to check sources for: node crawler.js --source "URL"');
    process.exit(1);
  }
} else {
  // Start the crawler
  main().catch(err => {
    console.error('Error in main crawler execution:', err);
    process.exit(1);
  });
}
