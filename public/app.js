// WebSocket connection
const socket = io();

// DOM elements
const crawlForm = document.getElementById('crawlForm');
const urlInput = document.getElementById('url');
const maxDepthInput = document.getElementById('maxDepth');
const concurrencyInput = document.getElementById('concurrency');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resultsCard = document.getElementById('resultsCard');
const logCard = document.getElementById('logCard');
const statusBadge = document.getElementById('statusBadge');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const totalChecked = document.getElementById('totalChecked');
const totalSuccess = document.getElementById('totalSuccess');
const totalErrors = document.getElementById('totalErrors');
const totalWarnings = document.getElementById('totalWarnings');
const domainStats = document.getElementById('domainStats');
const logContainer = document.getElementById('logContainer');

// State
let crawlStats = {
    total: 0,
    checked: 0,
    success: 0,
    errors: 0,
    warnings: 0,
    domains: {},
    urlsByDomain: {}, // Store URLs by domain for dropdown
    sourcePagesByUrl: {} // Store source pages for each URL
};

// Load saved state on page load
function loadSavedState() {
    const savedData = sessionStorage.getItem('crawlData');
    if (savedData) {
        try {
            const data = JSON.parse(savedData);
            crawlStats = data;

            // Restore UI if there's data
            if (crawlStats.checked > 0) {
                resultsCard.classList.remove('hidden');
                logCard.classList.remove('hidden');
                statusBadge.textContent = 'Completed';
                statusBadge.className = 'status-badge';
                statusBadge.style.background = '#d0d0d0';
                statusBadge.style.color = '#000000';

                updateStatsDisplay();

                // Restore logs
                const savedLogs = sessionStorage.getItem('crawlLogs');
                if (savedLogs) {
                    logContainer.innerHTML = savedLogs;
                }
            }
        } catch (e) {
            console.error('Error loading saved state:', e);
        }
    }
}

// Form submit handler
crawlForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const url = urlInput.value.trim();
    const maxDepth = parseInt(maxDepthInput.value);
    const concurrency = parseInt(concurrencyInput.value);

    // Reset stats
    resetStats();

    // Show results and logs
    resultsCard.classList.remove('hidden');
    logCard.classList.remove('hidden');

    // Update UI
    startBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    statusBadge.textContent = 'Running';
    statusBadge.className = 'status-badge status-running';

    // Start crawl
    socket.emit('start-crawl', { url, maxDepth, concurrency });

    addLog(`Starting crawl for ${url}...`, 'success');
});

// Stop button handler
stopBtn.addEventListener('click', () => {
    socket.emit('stop-crawl');
    addLog('Stopping crawler...', 'warning');
});

// Socket event handlers
socket.on('crawler-started', (data) => {
    addLog(`Crawler started for ${data.url}`, 'success');
});

socket.on('crawler-event', (data) => {
    handleCrawlerEvent(data);
});

socket.on('crawler-log', (data) => {
    addLog(data.message);
});

socket.on('crawler-error', (data) => {
    addLog(data.message, 'error');
});

socket.on('crawler-complete', (data) => {
    addLog('Crawl completed!', 'success');
    statusBadge.textContent = 'Completed';
    statusBadge.className = 'status-badge';
    statusBadge.style.background = '#d0d0d0';
    statusBadge.style.color = '#000000';
    startBtn.disabled = false;
    stopBtn.classList.add('hidden');

    // Save state to sessionStorage
    saveCrawlState();
});

socket.on('crawler-stopped', () => {
    addLog('Crawler stopped by user', 'warning');
    statusBadge.textContent = 'Stopped';
    statusBadge.className = 'status-badge status-stopped';
    startBtn.disabled = false;
    stopBtn.classList.add('hidden');
});

// Handle crawler events
function handleCrawlerEvent(data) {
    switch (data.type) {
        case 'progress':
            updateProgress(data);
            break;
        case 'url-checked':
            updateUrlChecked(data);
            break;
        case 'summary':
            updateSummary(data);
            break;
        default:
            console.log('Unknown event type:', data);
    }
}

// Update progress
function updateProgress(data) {
    if (data.checked !== undefined) crawlStats.checked = data.checked;
    if (data.total !== undefined) crawlStats.total = data.total;

    const percentage = crawlStats.total > 0
        ? Math.round((crawlStats.checked / crawlStats.total) * 100)
        : 0;

    progressBar.style.width = percentage + '%';
    progressText.textContent = `${crawlStats.checked} / ${crawlStats.total}`;
    totalChecked.textContent = crawlStats.checked;

    // Save state periodically
    saveCrawlState();
}

// Update when a URL is checked
function updateUrlChecked(data) {
    const { url, status, domain, sourcePages } = data;

    // Update stats
    crawlStats.checked++;

    if (status >= 200 && status < 300) {
        crawlStats.success++;
    } else if (status >= 400) {
        crawlStats.errors++;
    } else if (status >= 300 && status < 400) {
        crawlStats.warnings++;
    }

    // Update domain stats
    if (domain) {
        if (!crawlStats.domains[domain]) {
            crawlStats.domains[domain] = { success: 0, error: 0, warning: 0 };
            crawlStats.urlsByDomain[domain] = [];
        }

        // Store URL with status
        crawlStats.urlsByDomain[domain].push({ url, status });

        // Store source pages for this URL
        if (sourcePages && sourcePages.length > 0) {
            crawlStats.sourcePagesByUrl[url] = sourcePages;
        }

        if (status >= 200 && status < 300) {
            crawlStats.domains[domain].success++;
        } else if (status >= 400) {
            crawlStats.domains[domain].error++;
        } else if (status >= 300 && status < 400) {
            crawlStats.domains[domain].warning++;
        }
    }

    // Update UI
    updateStatsDisplay();

    // Add log entry
    const statusClass = status >= 200 && status < 300 ? 'success'
        : status >= 400 ? 'error'
        : 'warning';

    addLog(`[${status}] ${truncateUrl(url, 80)}`, statusClass);

    // Save state periodically
    saveCrawlState();
}

// Update summary
function updateSummary(data) {
    if (data.stats) {
        crawlStats = { ...crawlStats, ...data.stats };
        updateStatsDisplay();
    }
}

// Update stats display
function updateStatsDisplay() {
    totalChecked.textContent = crawlStats.checked;
    totalSuccess.textContent = crawlStats.success;
    totalErrors.textContent = crawlStats.errors;
    totalWarnings.textContent = crawlStats.warnings;

    // Update domain stats
    updateDomainStats();
}

// Update domain statistics display
function updateDomainStats() {
    domainStats.innerHTML = '';

    const domains = Object.entries(crawlStats.domains)
        .sort((a, b) => {
            const totalA = a[1].success + a[1].error + a[1].warning;
            const totalB = b[1].success + b[1].error + b[1].warning;
            return totalB - totalA;
        });

    domains.forEach(([domain, stats]) => {
        const domainItem = document.createElement('div');
        domainItem.className = 'domain-item';

        // Create domain header
        const domainHeader = document.createElement('div');
        domainHeader.className = 'domain-header';
        domainHeader.innerHTML = `
            <span class="domain-name">${escapeHtml(domain)}</span>
            <span class="domain-count">
                <span style="color: #d0d0d0;">${stats.success}</span> /
                <span style="color: #ff6666;">${stats.error}</span>
            </span>
        `;

        // Add click handler to open new page
        domainHeader.addEventListener('click', () => {
            // Store current crawl data in sessionStorage
            sessionStorage.setItem('crawlData', JSON.stringify(crawlStats));

            // Open domain detail page in new tab
            window.open(`/domain.html?domain=${encodeURIComponent(domain)}`, '_blank');
        });

        domainItem.appendChild(domainHeader);
        domainStats.appendChild(domainItem);
    });
}

// Add log entry
function addLog(message, type = '') {
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry ${type ? 'log-' + type : ''}`;

    const timestamp = new Date().toLocaleTimeString();
    logEntry.textContent = `[${timestamp}] ${message}`;

    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;

    // Save logs to sessionStorage (throttled)
    saveLogs();
}

// Save logs to sessionStorage
let saveLogsTimeout;
function saveLogs() {
    clearTimeout(saveLogsTimeout);
    saveLogsTimeout = setTimeout(() => {
        sessionStorage.setItem('crawlLogs', logContainer.innerHTML);
    }, 1000);
}

// Save crawl state to sessionStorage
let saveCrawlStateTimeout;
function saveCrawlState() {
    clearTimeout(saveCrawlStateTimeout);
    saveCrawlStateTimeout = setTimeout(() => {
        sessionStorage.setItem('crawlData', JSON.stringify(crawlStats));
    }, 500);
}

// Reset stats
function resetStats() {
    crawlStats = {
        total: 0,
        checked: 0,
        success: 0,
        errors: 0,
        warnings: 0,
        domains: {},
        urlsByDomain: {},
        sourcePagesByUrl: {}
    };

    totalChecked.textContent = '0';
    totalSuccess.textContent = '0';
    totalErrors.textContent = '0';
    totalWarnings.textContent = '0';
    domainStats.innerHTML = '';
    logContainer.innerHTML = '';
    progressBar.style.width = '0%';
    progressText.textContent = '0 / 0';
}

// Utility functions
function truncateUrl(url, maxLength) {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + '...';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Connection status
socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    addLog('Connection lost. Trying to reconnect...', 'error');
});

socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    addLog('Failed to connect to server', 'error');
});

// Load saved state when page loads
loadSavedState();
