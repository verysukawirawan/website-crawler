#!/usr/bin/env node

/**
 * Web Server for Tracer Crawler
 * Provides a web interface with WebSocket support for real-time crawler updates
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 7000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Store active crawler processes
const activeCrawlers = new Map();

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket connection handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Handle start crawl request
  socket.on('start-crawl', (data) => {
    const { url, maxDepth, concurrency } = data;

    console.log(`Starting crawl for ${url} (max depth: ${maxDepth}, concurrency: ${concurrency})`);

    // Stop any existing crawler for this socket
    if (activeCrawlers.has(socket.id)) {
      const existingCrawler = activeCrawlers.get(socket.id);
      existingCrawler.kill();
      activeCrawlers.delete(socket.id);
    }

    // Create environment variables for the crawler
    const env = {
      ...process.env,
      WEBSITE_URL: url,
      MAX_DEPTH: maxDepth.toString(),
      CONCURRENCY: concurrency.toString(),
      CLEANUP_REDIS: 'true',
      WEBSOCKET_MODE: 'true'
    };

    // Spawn the crawler process
    const crawler = spawn('node', ['crawler-ws.js'], {
      env,
      cwd: __dirname
    });

    activeCrawlers.set(socket.id, crawler);

    // Handle crawler stdout
    crawler.stdout.on('data', (data) => {
      const output = data.toString();

      // Try to parse as JSON for structured data
      try {
        const lines = output.trim().split('\n');
        lines.forEach(line => {
          if (line.trim()) {
            try {
              const jsonData = JSON.parse(line);
              socket.emit('crawler-event', jsonData);
            } catch (e) {
              // Not JSON, send as raw log
              socket.emit('crawler-log', { message: line });
            }
          }
        });
      } catch (e) {
        socket.emit('crawler-log', { message: output });
      }
    });

    // Handle crawler stderr
    crawler.stderr.on('data', (data) => {
      socket.emit('crawler-error', { message: data.toString() });
    });

    // Handle crawler exit
    crawler.on('close', (code) => {
      console.log(`Crawler process exited with code ${code}`);
      socket.emit('crawler-complete', { code });
      activeCrawlers.delete(socket.id);
    });

    // Send acknowledgment
    socket.emit('crawler-started', { url, maxDepth, concurrency });
  });

  // Handle stop crawl request
  socket.on('stop-crawl', () => {
    if (activeCrawlers.has(socket.id)) {
      const crawler = activeCrawlers.get(socket.id);
      crawler.kill();
      activeCrawlers.delete(socket.id);
      socket.emit('crawler-stopped');
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // Clean up any active crawlers
    if (activeCrawlers.has(socket.id)) {
      const crawler = activeCrawlers.get(socket.id);
      crawler.kill();
      activeCrawlers.delete(socket.id);
    }
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`\n🚀 Tracer Web Server is running on http://localhost:${PORT}`);
  console.log(`Open your browser and navigate to the URL above to start crawling.\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');

  // Kill all active crawlers
  activeCrawlers.forEach(crawler => crawler.kill());
  activeCrawlers.clear();

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
