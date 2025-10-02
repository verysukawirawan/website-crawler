// Get domain from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const domain = urlParams.get('domain');

// DOM elements
const domainNameEl = document.getElementById('domainName');
const loadingEl = document.getElementById('loading');
const contentEl = document.getElementById('content');
const totalUrlsEl = document.getElementById('totalUrls');
const successCountEl = document.getElementById('successCount');
const errorCountEl = document.getElementById('errorCount');
const successSectionEl = document.getElementById('successSection');
const errorSectionEl = document.getElementById('errorSection');
const successUrlsEl = document.getElementById('successUrls');
const errorUrlsEl = document.getElementById('errorUrls');
const noDataEl = document.getElementById('noData');

// Load domain data from sessionStorage
function loadDomainData() {
    if (!domain) {
        domainNameEl.textContent = 'Invalid Domain';
        loadingEl.style.display = 'none';
        noDataEl.style.display = 'block';
        contentEl.style.display = 'block';
        return;
    }

    domainNameEl.textContent = domain;

    // Get data from sessionStorage
    const crawlData = sessionStorage.getItem('crawlData');
    if (!crawlData) {
        loadingEl.style.display = 'none';
        noDataEl.style.display = 'block';
        contentEl.style.display = 'block';
        return;
    }

    const data = JSON.parse(crawlData);
    const domainUrls = data.urlsByDomain[domain];
    const domainSourcePages = data.sourcePagesByUrl || {};

    if (!domainUrls || domainUrls.length === 0) {
        loadingEl.style.display = 'none';
        noDataEl.style.display = 'block';
        contentEl.style.display = 'block';
        return;
    }

    // Separate success and error URLs
    const successUrls = domainUrls.filter(u => u.status >= 200 && u.status < 300);
    const errorUrls = domainUrls.filter(u => u.status >= 400);

    // Update stats
    totalUrlsEl.textContent = domainUrls.length;
    successCountEl.textContent = successUrls.length;
    errorCountEl.textContent = errorUrls.length;

    // Render success URLs
    if (successUrls.length > 0) {
        successSectionEl.style.display = 'block';
        successUrls.forEach(urlData => {
            const urlItem = createUrlItem(urlData, domainSourcePages[urlData.url] || [], 'success');
            successUrlsEl.appendChild(urlItem);
        });
    }

    // Render error URLs
    if (errorUrls.length > 0) {
        errorSectionEl.style.display = 'block';
        errorUrls.forEach(urlData => {
            const urlItem = createUrlItem(urlData, domainSourcePages[urlData.url] || [], 'error');
            errorUrlsEl.appendChild(urlItem);
        });
    }

    // Hide loading, show content
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
}

// Create URL item with expandable sources
function createUrlItem(urlData, sourcePages, type) {
    const urlItem = document.createElement('div');
    urlItem.className = `url-item ${type}`;

    const urlHeader = document.createElement('div');
    urlHeader.className = 'url-header';

    // Create status code
    const statusCode = document.createElement('span');
    statusCode.className = 'status-code';
    statusCode.textContent = urlData.status;

    // Create URL path
    const urlPath = document.createElement('span');
    urlPath.className = 'url-path';
    urlPath.textContent = urlData.url;

    // Create actions container
    const urlActions = document.createElement('div');
    urlActions.className = 'url-actions';

    // Create copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(urlData.url, copyBtn);
    });

    // Create toggle icon
    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'toggle-icon';
    toggleIcon.textContent = '▼';

    // Assemble header
    urlActions.appendChild(copyBtn);
    urlActions.appendChild(toggleIcon);
    urlHeader.appendChild(statusCode);
    urlHeader.appendChild(urlPath);
    urlHeader.appendChild(urlActions);

    const urlSources = document.createElement('div');
    urlSources.className = 'url-sources';

    if (sourcePages.length > 0) {
        const sourcesHeader = document.createElement('h4');
        sourcesHeader.textContent = `Found on ${sourcePages.length} page(s):`;
        urlSources.appendChild(sourcesHeader);

        sourcePages.forEach(sourcePage => {
            const sourceItem = document.createElement('div');
            sourceItem.className = 'source-item';

            const sourceUrl = document.createElement('span');
            sourceUrl.className = 'source-url';
            sourceUrl.textContent = sourcePage;

            const sourceCopyBtn = document.createElement('button');
            sourceCopyBtn.className = 'source-copy-btn';
            sourceCopyBtn.textContent = 'Copy';
            sourceCopyBtn.addEventListener('click', () => {
                copyToClipboard(sourcePage, sourceCopyBtn);
            });

            sourceItem.appendChild(sourceUrl);
            sourceItem.appendChild(sourceCopyBtn);
            urlSources.appendChild(sourceItem);
        });
    } else {
        const sourcesHeader = document.createElement('h4');
        sourcesHeader.textContent = 'Source pages not tracked';
        urlSources.appendChild(sourcesHeader);
    }

    // Toggle sources on click (but not when clicking copy button)
    urlHeader.addEventListener('click', (e) => {
        if (!e.target.classList.contains('copy-btn')) {
            urlSources.classList.toggle('expanded');
            toggleIcon.textContent = urlSources.classList.contains('expanded') ? '▲' : '▼';
        }
    });

    urlItem.appendChild(urlHeader);
    urlItem.appendChild(urlSources);

    return urlItem;
}

// Utility function
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Copy to clipboard function
function copyToClipboard(text, button) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = button.textContent;
        button.textContent = 'Copied!';
        button.classList.add('copied');

        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        button.textContent = 'Failed';
        setTimeout(() => {
            button.textContent = 'Copy';
        }, 2000);
    });
}

// Load data when page loads
loadDomainData();
