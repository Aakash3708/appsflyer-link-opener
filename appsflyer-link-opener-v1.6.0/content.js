let settleTimer = null;

function isAppsFlyer404() {
  const path = window.location.pathname.replace(/\/+$/, '').toLowerCase();
  if (path === '/auth/error404') return true;

  const text = (document.body?.innerText || '').toLowerCase();
  return text.includes("we couldn't find that page") &&
    text.includes('the page might have moved or is no longer available');
}

function scheduleSettleCheck(pageUrl, delayMs) {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'pageSettled',
      pageUrl: window.location.href,
      is404: isAppsFlyer404()
    }).catch(() => {});
  }, Number(delayMs) || 10_000);
}

function showManualRetry({ pid, url, errorRetries, loadingRetries, reason }) {
  const old = document.getElementById('af-link-opener-manual-retry');
  if (old) old.remove();

  const message = reason === 'loading-stuck-limit'
    ? `The page stayed loading through ${Number(loadingRetries) || 2} loading retries.`
    : `The page still returned an AppsFlyer error after ${Number(errorRetries) || 5} error retries.`;

  const overlay = document.createElement('div');
  overlay.id = 'af-link-opener-manual-retry';
  overlay.innerHTML = `
    <div class="aflo-panel">
      <div class="aflo-title">AppsFlyer link needs a manual retry</div>
      <div class="aflo-subtitle">PID: <strong>${escapeHtml(pid)}</strong></div>
      <div class="aflo-label">Correct URL</div>
      <input class="aflo-url" value="${escapeHtml(url)}" readonly>
      <div class="aflo-actions">
        <button class="aflo-copy">Copy URL</button>
        <button class="aflo-select">Select URL</button>
      </div>
      <div class="aflo-help">${escapeHtml(message)} Chrome does not allow an extension to type into the browser address bar. Click <strong>Copy URL</strong>, then press <strong>Ctrl+L</strong>, <strong>Ctrl+V</strong>, and <strong>Enter</strong>.</div>
    </div>
  `;
  document.documentElement.appendChild(overlay);

  const input = overlay.querySelector('.aflo-url');
  const copyBtn = overlay.querySelector('.aflo-copy');
  const selectBtn = overlay.querySelector('.aflo-select');

  copyBtn.addEventListener('click', async () => {
    try {
      input.focus();
      input.select();
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1500);
    } catch {
      input.focus();
      input.select();
      copyBtn.textContent = 'Selected — Ctrl+C';
    }
  });

  selectBtn.addEventListener('click', () => {
    input.focus();
    input.select();
  });

  input.focus();
  input.select();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'scheduleSettleCheck') {
    scheduleSettleCheck(message.pageUrl, message.delayMs);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'checkNow') {
    sendResponse({ ok: true, is404: isAppsFlyer404(), url: window.location.href });
    return true;
  }

  if (message?.type === 'showManualRetry') {
    showManualRetry(message);
    sendResponse({ ok: true });
    return true;
  }
});

scheduleSettleCheck(window.location.href, 10_000);
