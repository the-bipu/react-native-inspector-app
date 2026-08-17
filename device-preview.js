'use strict';

// Applied immediately (before the rest of the page paints) so there's no
// flash of the wrong theme — same approach as picker.js.
(function applyInitialTheme() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
})();

document.addEventListener('DOMContentLoaded', () => {
  const params      = new URLSearchParams(window.location.search);
  const responsive  = params.get('responsive') === 'true';
  const label       = params.get('label') || 'Device';
  const w           = params.get('w');
  const h           = params.get('h');
  const initialUrl  = params.get('url') || '';

  const deviceLabelEl = document.getElementById('device-label');
  const deviceDimsEl  = document.getElementById('device-dims');
  const urlForm       = document.getElementById('url-form');
  const urlInput      = document.getElementById('url-input');
  const reloadBtn     = document.getElementById('reload-btn');
  const closeBtn      = document.getElementById('close-btn');
  const webview       = document.getElementById('preview-webview');
  const placeholder    = document.getElementById('placeholder');
  const loadError      = document.getElementById('load-error');
  const loadErrorDetail= document.getElementById('load-error-detail');
  const loadingBar      = document.getElementById('loading-bar');
  const retryBtn        = document.getElementById('retry-btn');

  deviceLabelEl.textContent = label;
  deviceDimsEl.textContent  = responsive ? 'Free resize' : (w && h ? `${w} × ${h}` : '');

  // The page's viewport now always matches exactly what's visible on
  // screen (see CSS: the webview fills #device-frame at 100% width and
  // height), so there's no separate "true device pixel" size to force
  // onto it here. That avoids two problems: (1) letterboxing/gutters
  // down the sides when a tall device would otherwise need shrinking to
  // fit the screen's height, and (2) position:fixed content (like a
  // bottom tab bar) rendering outside the visible area.

  function normalizeUrl(value) {
    const v = (value || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    return `http://${v}`;
  }

  function showPlaceholder() {
    placeholder.classList.remove('hidden');
    loadError.classList.add('hidden');
    webview.classList.add('hidden');
  }

  function showError(detail) {
    loadErrorDetail.textContent = detail || 'Make sure the project is running.';
    loadError.classList.remove('hidden');
    placeholder.classList.add('hidden');
    webview.classList.add('hidden');
  }

  function showWebview() {
    placeholder.classList.add('hidden');
    loadError.classList.add('hidden');
    webview.classList.remove('hidden');
  }

  function navigateTo(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) { showPlaceholder(); return; }
    urlInput.value = url;
    loadingBar.classList.remove('hidden');
    loadingBar.style.width = '30%';
    showWebview();
    try {
      webview.src = url;
    } catch (e) {
      showError(e.message);
    }
  }

  webview.addEventListener('did-start-loading', () => {
    loadingBar.classList.remove('hidden');
    loadingBar.style.width = '55%';
  });
  webview.addEventListener('did-stop-loading', () => {
    loadingBar.style.width = '100%';
    setTimeout(() => loadingBar.classList.add('hidden'), 200);
  });
  webview.addEventListener('did-fail-load', (e) => {
    // -3 is an aborted navigation (e.g. redirect chain), not a real failure — ignore it.
    if (e.errorCode === -3) return;
    loadingBar.classList.add('hidden');
    showError(`${urlInput.value || 'The dev server'} isn't responding (${e.errorDescription || e.errorCode}).`);
  });

  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    navigateTo(urlInput.value);
  });

  reloadBtn.addEventListener('click', () => {
    if (urlInput.value.trim()) navigateTo(urlInput.value);
  });

  retryBtn.addEventListener('click', () => {
    if (urlInput.value.trim()) navigateTo(urlInput.value);
  });

  closeBtn.addEventListener('click', () => window.close());

  if (initialUrl) {
    urlInput.value = initialUrl;
    navigateTo(initialUrl);
  } else {
    urlInput.value = '';
    showPlaceholder();
  }
});