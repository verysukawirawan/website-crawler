# Tracer - Website Link Crawler

A powerful web crawler with real-time monitoring dashboard. Crawls websites to trace and analyze all links, CSS, images, and scripts. Features a modern black-themed web interface with WebSocket support for real-time updates.

## Features

### Crawler Features
- ✅ Crawls all links, CSS files, images, and scripts on a website
- ✅ Checks if links exist and follows redirects
- ✅ Saves results to Redis including URL, status code, redirect URL, source pages
- ✅ Crawls only inbound links (same domain)
- ✅ For outbound links, only checks existence
- ✅ Configurable depth and concurrency
- ✅ URL exclusion patterns support
- ✅ Smart data image handling

### Web Dashboard Features
- ✅ Real-time monitoring with WebSocket updates
- ✅ Live progress tracking
- ✅ Domain statistics with success/error counts
- ✅ Click domains to view detailed breakdown in new page
- ✅ Expandable URL lists showing source pages
- ✅ Copy buttons for URLs and source pages
- ✅ Black theme with light gray/light red color scheme
- ✅ Persistent state (data remains when navigating back)
- ✅ Live crawl logs with color coding

## Prerequisites

- **Node.js** (v14 or later)
- **Redis server** (running locally or remotely)
- **pnpm** (recommended) or npm/yarn

## Installation

### 1. Install Redis

**macOS (using Homebrew):**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
```

**Windows:**
Download from [Redis Windows](https://github.com/microsoftarchive/redis/releases)

### 2. Install Project Dependencies

Clone the repository and install dependencies:

```bash
git clone <your-repo-url>
cd tracer
pnpm install
```

If you don't have pnpm installed:
```bash
npm install -g pnpm
```

## Configuration

Create or edit the `.env` file in the project root:

```env
# Crawler Configuration
WEBSITE_URL=https://example.com    # The website to crawl
MAX_DEPTH=3                        # Maximum depth to crawl (1-10)
CONCURRENCY=5                      # Number of concurrent requests (1-20)

# Redis Configuration
REDIS_HOST=127.0.0.1              # Redis server host
REDIS_PORT=6379                   # Redis server port
REDIS_PASSWORD=                   # Leave empty if no password
REDIS_DB=0                        # Redis database number
REDIS_KEY_PREFIX=tracer:          # Prefix for Redis keys

# Timeout settings (in milliseconds)
REQUEST_TIMEOUT=10000             # Request timeout (default: 10s)

# User Agent
USER_AGENT=Mozilla/5.0 (compatible; TraceBot/1.0)

# Crawler behavior
CLEANUP_REDIS=true                # Clean up previous crawl data
SKIP_DATA_IMAGES=true             # Skip data:image URLs

# URL exclusion patterns (comma-separated paths to exclude from crawling)
# Example: EXCLUDE_PATTERNS=/blog,/admin,/private
EXCLUDE_PATTERNS=

# Web Server Configuration
PORT=7000                         # Web dashboard port
```

## Usage

### Web Dashboard (Recommended)

Start the web server with real-time monitoring:

```bash
pnpm web
```

Or:
```bash
pnpm dev
```

Then open your browser to:
```
http://localhost:7000
```

**Features:**
1. Enter website URL
2. Set max depth and concurrency
3. Click "Start Crawling"
4. Watch real-time progress
5. Click on domains to see detailed breakdown
6. Click on URLs to see source pages
7. Copy URLs with one click

### Command Line

Run the crawler directly (output to terminal):

```bash
pnpm start
```

Or:
```bash
node crawler.js
```

### Check Source Pages for a URL

To see which pages contain a specific URL:

```bash
node crawler.js --source "https://example.com/page"
```

## Web Dashboard Guide

### Main Dashboard

1. **Form Section**: Input URL, max depth, and concurrency
2. **Progress Bar**: Shows real-time crawl progress (checked/total)
3. **Statistics**: Total checked, success, errors, warnings
4. **Domain Statistics**: List of all domains found with counts
5. **Crawl Logs**: Real-time color-coded logs

### Domain Detail Page

Click on any domain to open a new page showing:

1. **Stats Summary**: Total, success, and error counts for the domain
2. **Success URLs**: All successful URLs (light gray)
   - Click to expand and see source pages
   - Copy button for each URL
3. **Error URLs**: All error URLs (light red)
   - Click to expand and see source pages
   - Copy button for each URL
4. **Source Pages**: Shows which pages contain each URL
   - Copy button for each source page

### Color Scheme

- **Background**: Black (#000000)
- **Success**: Light gray (#d0d0d0)
- **Error**: Light red (#ff6666)
- **UI Elements**: White text on dark backgrounds

## Redis Data Structure

The crawler stores the following data in Redis:

### Hash Keys (per URL)
Each URL is stored as: `tracer:<base64-encoded-url>`

Fields:
- `url` - The URL
- `status` - HTTP status code
- `contentType` - Content type
- `finalUrl` - Final URL after redirects
- `isRedirect` - 1 if redirected, 0 otherwise
- `referrer` - The page that linked to this URL
- `depth` - Crawl depth
- `type` - Asset type (link, css, script, image, other)
- `checkedAt` - Timestamp
- `isInbound` - 1 if same domain, 0 otherwise
- `sourcePages` - JSON array of pages containing this URL

### Sets
- `tracer:all_urls` - Set of all URLs crawled
- `tracer:type:link` - Set of all link URLs
- `tracer:type:css` - Set of all CSS URLs
- `tracer:type:script` - Set of all JavaScript URLs
- `tracer:type:image` - Set of all image URLs
- `tracer:status:200` - Set of all URLs with status 200
- `tracer:status:404` - Set of all URLs with status 404
- `tracer:sources:<base64-url>` - Set of pages where URL was found

## Project Structure

```
tracer/
├── crawler.js              # Main crawler (CLI)
├── crawler-ws.js          # WebSocket-enabled crawler
├── server.js              # Express + Socket.IO server
├── public/
│   ├── index.html         # Main dashboard
│   ├── app.js             # Dashboard JavaScript
│   ├── domain.html        # Domain detail page
│   └── domain.js          # Domain detail JavaScript
├── .env                   # Configuration file
├── package.json           # Dependencies
└── README.md             # This file
```

## Scripts

- `pnpm web` - Start web dashboard server
- `pnpm dev` - Start web dashboard server (alias)
- `pnpm start` - Run CLI crawler

## Troubleshooting

### Redis Connection Error

**Error**: `Redis Client Error`

**Solution**:
1. Ensure Redis is running:
   ```bash
   redis-cli ping
   # Should return: PONG
   ```
2. Check Redis host/port in `.env`
3. Start Redis if not running:
   ```bash
   # macOS
   brew services start redis

   # Linux
   sudo systemctl start redis-server
   ```

### Port Already in Use

**Error**: `EADDRINUSE: address already in use :::7000`

**Solution**:
Change the `PORT` in `.env` to a different port (e.g., 8000, 3000)

### Memory Issues with Large Sites

**Solution**:
- Reduce `MAX_DEPTH` (try 2 or 3)
- Reduce `CONCURRENCY` (try 2 or 3)
- Increase Node.js memory:
  ```bash
  NODE_OPTIONS=--max-old-space-size=4096 pnpm web
  ```

### Data Not Persisting After Browser Refresh

This is expected - data is stored in `sessionStorage` which clears on tab close. The data is only persisted when navigating between dashboard and domain detail pages within the same session.

## Advanced Usage

### URL Exclusion Patterns

Exclude specific URL patterns from crawling:

```env
EXCLUDE_PATTERNS=/blog,/admin,/private,/api
```

This will skip any URLs starting with these paths.

### Custom User Agent

Change the user agent to identify your crawler:

```env
USER_AGENT=Mozilla/5.0 (compatible; YourBot/1.0; +https://yoursite.com)
```

### Multiple Concurrent Crawls

You can run multiple crawls by using different Redis databases:

```env
# First crawl
REDIS_DB=0
REDIS_KEY_PREFIX=tracer1:

# Second crawl
REDIS_DB=1
REDIS_KEY_PREFIX=tracer2:
```

## Performance Tips

1. **Optimal Concurrency**: Start with 5, increase for faster servers
2. **Depth Control**: Use depth 2-3 for large sites, 5+ for small sites
3. **Redis Cleanup**: Set `CLEANUP_REDIS=true` for fresh crawls
4. **Timeout**: Increase `REQUEST_TIMEOUT` for slow servers

## Dependencies

- **express** - Web server
- **socket.io** - WebSocket for real-time updates
- **axios** - HTTP client for crawling
- **cheerio** - HTML parsing
- **redis** - Redis client
- **dotenv** - Environment configuration
- **url-parse** - URL parsing utilities

## License

ISC

## Contributing

Feel free to submit issues and enhancement requests!

## Support

For issues and questions, please open an issue on GitHub.
