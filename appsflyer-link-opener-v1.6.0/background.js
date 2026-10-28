const DEFAULT_APPS = [
  { name: 'Angel One', appId: 'com.msf.angelmobile' },
  { name: 'Jar', appId: 'com.jar.app' }
];

const DEFAULT_SETTINGS = {
  tabGroup: 'new',
  batchSize: 7,
  batchDelaySec: 10
};

const SETTLE_DELAY_MS = 10_000;
const ERROR_RETRY_LIMIT = 5;
const LOADING_RETRY_LIMIT = 2;
const LOADING_WATCHDOG_MS = 30_000;
const HISTORY_TTL_MS = 30 * 60 * 1000;
const HISTORY_MAX_RUNS = 20;
const PER_TAB_CREATION_DELAY_MS = 250;

const tabState = new Map();
const historyRuns = new Map();
const batchTimers = new Map();
let storageReady = false;
let storageReadyPromise = null;
let storageWriteChain = Promise.resolve();

function normalizeStoredRun(run) {
  if (!run || !run.id) return null;
  return {
    ...run,
    id: String(run.id),
    links: Array.isArray(run.links) ? run.links : [],
    items: Array.isArray(run.items) ? run.items : [],
    options: run.options || {},
    createdAt: Number(run.createdAt) || Date.now(),
    updatedAt: Number(run.updatedAt) || Number(run.createdAt) || Date.now(),
    status: run.status || 'running',
    total: Number(run.total) || 0,
    opened: Number(run.opened) || 0,
    waiting: Number(run.waiting) || 0,
    retrying: Number(run.retrying) || 0,
    failed: Number(run.failed) || 0,
    completed: Number(run.completed) || 0,
    nextIndex: Number(run.nextIndex) || 0,
    batchNumber: Number(run.batchNumber) || 0,
    totalBatches: Number(run.totalBatches) || 0,
    groupId: Number.isFinite(Number(run.groupId)) ? Number(run.groupId) : null,
    groupTitle: String(run.groupTitle || '')
  };
}

function pruneHistoryInMemory() {
  const now = Date.now();
  for (const [id, run] of historyRuns) {
    const expired = now - Number(run.updatedAt || run.createdAt || 0) > HISTORY_TTL_MS;
    const finished = run.status !== 'running';
    if (expired && finished) historyRuns.delete(id);
  }
  // Never evict an active job just to enforce the finished-history cap.
  // Active jobs must remain available so their remaining batches/retries can continue.
  const finishedRuns = [...historyRuns.values()]
    .filter(run => run.status !== 'running')
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  while (finishedRuns.length > HISTORY_MAX_RUNS) {
    const oldest = finishedRuns.pop();
    if (oldest) historyRuns.delete(oldest.id);
  }
}

async function loadPersistentState() {
  if (storageReady) return;
  if (storageReadyPromise) return storageReadyPromise;
  storageReadyPromise = (async () => {
    const data = await chrome.storage.local.get({
      apps: DEFAULT_APPS,
      afloSettings: DEFAULT_SETTINGS,
      afloHistory: [],
      afloTabState: {}
    });

    const runs = Array.isArray(data.afloHistory) ? data.afloHistory : [];
    for (const raw of runs) {
      const run = normalizeStoredRun(raw);
      if (run) historyRuns.set(run.id, run);
    }
    pruneHistoryInMemory();

    const storedTabs = data.afloTabState && typeof data.afloTabState === 'object' ? data.afloTabState : {};
    for (const [tabIdText, rawState] of Object.entries(storedTabs)) {
      const tabId = Number(tabIdText);
      if (!Number.isFinite(tabId) || !rawState?.jobId) continue;
      tabState.set(tabId, rawState);
    }

    // Rebuild active tab tracking after a service-worker restart.
    for (const [tabId, state] of [...tabState]) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (state.completed || !tab) {
          if (state.completed) tabState.delete(tabId);
        }
      } catch {
        tabState.delete(tabId);
      }
    }

    await persistHistoryAndTabs();
    storageReady = true;
  })();
  return storageReadyPromise;
}

function queueStorageWrite(task) {
  storageWriteChain = storageWriteChain.then(task).catch(() => {});
  return storageWriteChain;
}

function currentHistoryArray() {
  pruneHistoryInMemory();
  return [...historyRuns.values()].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}

function currentTabStateObject() {
  const out = {};
  for (const [tabId, state] of tabState) {
    if (!state.completed) out[String(tabId)] = state;
  }
  return out;
}

function persistHistoryAndTabs() {
  const history = currentHistoryArray();
  const tabs = currentTabStateObject();
  return queueStorageWrite(() => chrome.storage.local.set({ afloHistory: history, afloTabState: tabs }));
}

function touchRun(job) {
  job.updatedAt = Date.now();
  if (job.status !== 'running' && job.completed + job.failed < job.total) job.status = 'running';
  historyRuns.set(job.id, job);
  pruneHistoryInMemory();
  void persistHistoryAndTabs();
}

async function loadApps() {
  await loadPersistentState();
  const data = await chrome.storage.local.get('apps');
  // Missing key = first run, so expose built-ins. An explicitly stored [] means
  // the user intentionally removed all presets and must remain empty.
  if (!Object.prototype.hasOwnProperty.call(data, 'apps')) return DEFAULT_APPS.map(app => ({ ...app }));
  return Array.isArray(data.apps) ? data.apps : [];
}

async function saveApps(apps) {
  await loadPersistentState();
  await chrome.storage.local.set({ apps });
}

async function loadSettings() {
  await loadPersistentState();
  const data = await chrome.storage.local.get({ afloSettings: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...(data.afloSettings || {}) };
}

async function saveSettings(settings) {
  await loadPersistentState();
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  await chrome.storage.local.set({ afloSettings: merged });
  return merged;
}

async function loadWorkspace() {
  await loadPersistentState();
  const data = await chrome.storage.local.get({ afloWorkspace: {} });
  return data.afloWorkspace || {};
}

async function saveWorkspace(workspace) {
  await loadPersistentState();
  await chrome.storage.local.set({ afloWorkspace: workspace || {} });
}

function normalizeAppId(value) {
  return String(value || '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+/, '').split('/')[0];
}

function extractAppIdFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const marker = '/marketplace/integrated-partners/';
    const idx = url.pathname.toLowerCase().indexOf(marker);
    if (idx === -1) return '';
    const rest = url.pathname.slice(idx + marker.length).split('/').filter(Boolean);
    return rest[0] || '';
  } catch {
    return '';
  }
}

function extractPidFromUrl(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    const marker = '/marketplace/integrated-partners/';
    const idx = url.pathname.toLowerCase().indexOf(marker);
    if (idx === -1) return '';
    const rest = url.pathname.slice(idx + marker.length).split('/').filter(Boolean);
    return rest[1] || '';
  } catch {
    return '';
  }
}

function isAppsFlyerPartnerUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.hostname.toLowerCase() === 'hq1.appsflyer.com' &&
      url.pathname.toLowerCase().includes('/marketplace/integrated-partners/');
  } catch {
    return false;
  }
}

function buildUrl(appId, pid) {
  return `https://hq1.appsflyer.com/marketplace/integrated-partners/${encodeURIComponent(appId)}/${encodeURIComponent(pid)}`;
}

function extractUrlsFromText(text) {
  const input = String(text || '');
  const matches = input.match(/https?:\/\/[^\s<>"']+/gi) || [];
  return [...new Set(matches.map(s => s.replace(/[),.;!\]}]+$/, '')))].filter(Boolean);
}

function parseInputItems(text) {
  return String(text || '')
    .split(/\n|\r|,|;|\t/)
    .map(s => s.trim())
    .filter(Boolean);
}

function cleanLinks(links, ignoreDuplicates) {
  const list = links.filter(x => x?.url);
  if (!ignoreDuplicates) return list;
  const seen = new Set();
  return list.filter(item => {
    const key = item.url.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildLinksFromInput(appIdInput, text, options = {}) {
  const rawAppId = String(appIdInput || '').trim();
  const appId = extractAppIdFromUrl(rawAppId) || normalizeAppId(rawAppId);
  const items = parseInputItems(text);
  const links = [];
  const extractedUrls = [];
  let unbuildablePidCount = 0;

  for (const item of items) {
    if (/^https?:\/\//i.test(item)) {
      if (isAppsFlyerPartnerUrl(item)) {
        const pid = extractPidFromUrl(item);
        if (pid) {
          links.push({ pid, url: item });
          extractedUrls.push(item);
        }
      } else if (options.handleNonAppsFlyerUrlsAsSearch) {
        const url = `https://www.google.com/search?q=${encodeURIComponent(item)}`;
        links.push({ pid: item, url, type: 'search' });
      }
      continue;
    }

    if (options.handleSearchQueries && /\s/.test(item)) {
      links.push({ pid: item, url: `https://www.google.com/search?q=${encodeURIComponent(item)}`, type: 'search' });
      continue;
    }

    if (appId) links.push({ pid: item, url: buildUrl(appId, item) });
    else unbuildablePidCount += 1;
  }

  return { appId, links, extractedUrls, unbuildablePidCount };
}

function orderLinks(links, { reverse = false, random = false } = {}) {
  const copy = [...links];
  if (random) {
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  if (reverse) return copy.reverse();
  return copy;
}

function isError404Url(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === 'hq1.appsflyer.com' &&
      parsed.pathname.replace(/\/+$/, '').toLowerCase() === '/auth/error404';
  } catch {
    return false;
  }
}

function alarmName(tabId, token) {
  return `af-watchdog:${tabId}:${token}`;
}

function batchAlarmName(jobId, batchNumber) {
  return `af-batch:${jobId}:${batchNumber}`;
}

async function clearWatchdog(state) {
  if (!state?.alarmName) return;
  try { await chrome.alarms.clear(state.alarmName); } catch {}
  state.alarmName = null;
}

function recomputeRetrying(job) {
  job.retrying = job.items.filter(item => item.status === 'retrying').length;
}

function findItem(job, tabId) {
  return job.items.find(item => Number(item.tabId) === Number(tabId));
}

function updateItem(job, tabId, patch) {
  const item = findItem(job, tabId);
  if (!item) return;
  Object.assign(item, patch);
}

function markCompleted(state) {
  if (!state || state.completed) return;
  const wasWaiting = state.awaitingSelection;
  state.completed = true;
  state.awaitingSelection = false;
  void clearWatchdog(state);
  const job = historyRuns.get(String(state.jobId));
  if (job) {
    recomputeRetrying(job);
    if (wasWaiting) job.waiting = Math.max(0, job.waiting - 1);
    job.completed += 1;
    updateItem(job, state.tabId, {
      status: 'success',
      finishedAt: Date.now(),
      errorRetries: state.errorRetries,
      loadingRetries: state.loadingRetries,
      lastRetryReason: state.lastRetryReason || ''
    });
    updateJobFinalStatus(job);
    touchRun(job);
  }
  tabState.delete(state.tabId);
  void persistHistoryAndTabs();
}

function markFailed(state, reason = '') {
  if (!state || state.completed) return;
  const wasWaiting = state.awaitingSelection;
  state.completed = true;
  state.awaitingSelection = false;
  void clearWatchdog(state);
  const job = historyRuns.get(String(state.jobId));
  if (job) {
    recomputeRetrying(job);
    if (wasWaiting) job.waiting = Math.max(0, job.waiting - 1);
    job.failed += 1;
    updateItem(job, state.tabId, {
      status: 'manual',
      finishedAt: Date.now(),
      errorRetries: state.errorRetries,
      loadingRetries: state.loadingRetries,
      lastRetryReason: reason || state.lastRetryReason || ''
    });
    updateJobFinalStatus(job);
    touchRun(job);
  }
  tabState.delete(state.tabId);
  void persistHistoryAndTabs();
}

function updateJobFinalStatus(job) {
  if (job.completed + job.failed < job.total) {
    job.status = 'running';
  } else {
    job.status = 'complete';
  }
}

async function showManualRetry(tabId, state, reason) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'showManualRetry',
      pid: state.pid,
      url: state.url,
      errorRetries: state.errorRetries,
      loadingRetries: state.loadingRetries,
      reason
    });
  } catch {
    // History in the extension still contains the PID + intended URL even if the page script is unavailable.
  }
}

function retryMessage(reason) {
  if (reason === 'loading-stuck') return 'loading-stuck';
  return 'error';
}

async function retryTab(tabId, reason) {
  await loadPersistentState();
  const state = tabState.get(tabId);
  if (!state || state.completed) return false;

  const type = retryMessage(reason);
  if (type === 'loading-stuck') {
    if (state.loadingRetries >= LOADING_RETRY_LIMIT) {
      markFailed(state, 'loading-stuck-limit');
      await showManualRetry(tabId, state, 'loading-stuck-limit');
      return false;
    }
    state.loadingRetries += 1;
  } else {
    if (state.errorRetries >= ERROR_RETRY_LIMIT) {
      markFailed(state, 'error-retry-limit');
      await showManualRetry(tabId, state, 'error-retry-limit');
      return false;
    }
    state.errorRetries += 1;
  }

  state.totalRetries += 1;
  state.lastRetryReason = reason;
  state.pageUrl = null;
  state.checkToken += 1;
  await clearWatchdog(state);

  const job = historyRuns.get(String(state.jobId));
  if (job) {
    updateItem(job, tabId, {
      status: 'retrying',
      errorRetries: state.errorRetries,
      loadingRetries: state.loadingRetries,
      lastRetryReason: reason,
      lastRetryAt: Date.now()
    });
    recomputeRetrying(job);
    touchRun(job);
  }

  try {
    await chrome.tabs.reload(tabId, { bypassCache: true });
    await scheduleWatchdog(tabId, state);
    void persistHistoryAndTabs();
    return true;
  } catch {
    markFailed(state, 'reload-failed');
    await showManualRetry(tabId, state, 'reload-failed');
    return false;
  }
}

async function scheduleWatchdog(tabId, state) {
  if (!state || state.completed || state.awaitingSelection) return;
  await clearWatchdog(state);
  const token = ++state.checkToken;
  const name = alarmName(tabId, token);
  state.alarmName = name;
  try {
    await chrome.alarms.create(name, { delayInMinutes: LOADING_WATCHDOG_MS / 60_000 });
  } catch {
    state.alarmName = null;
  }
  void persistHistoryAndTabs();
}

async function scheduleSettleCheck(tabId, pageUrl) {
  const state = tabState.get(tabId);
  if (!state || state.completed || state.awaitingSelection) return;
  state.pageUrl = pageUrl;
  await clearWatchdog(state);
  state.checkToken += 1;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'scheduleSettleCheck',
      pageUrl,
      delayMs: SETTLE_DELAY_MS
    });
    await scheduleWatchdog(tabId, state);
  } catch {
    await scheduleWatchdog(tabId, state);
  }
}

async function handleSettledPage(tabId, pageUrl, is404) {
  const state = tabState.get(tabId);
  if (!state || state.completed) return;
  if (state.pageUrl && state.pageUrl !== pageUrl) return;

  await clearWatchdog(state);

  if (is404) {
    await retryTab(tabId, '404');
    return;
  }

  markCompleted(state);
}

function createItemRecords(links) {
  return links.map(link => ({
    pid: link.pid,
    url: link.url,
    type: link.type || 'appsflyer',
    status: 'queued',
    tabId: null,
    errorRetries: 0,
    loadingRetries: 0,
    lastRetryReason: '',
    createdAt: Date.now()
  }));
}

async function openBatch(job) {
  if (job.nextIndex >= job.total) return [];
  const batchSize = Math.max(1, Math.min(500, Number(job.options.batchSize) || 7));
  const start = job.nextIndex;
  const end = Math.min(job.total, start + batchSize);
  const batchLinks = job.links.slice(start, end);
  const createdTabs = [];
  job.batchNumber += 1;

  for (let offset = 0; offset < batchLinks.length; offset += 1) {
    const item = batchLinks[offset];
    const itemIndex = start + offset;
    const tab = await chrome.tabs.create({
      url: job.options.loadImmediately ? item.url : 'about:blank',
      active: false
    });

    const isSearch = item.type === 'search';
    const state = {
      tabId: tab.id,
      jobId: job.id,
      pid: item.pid,
      url: item.url,
      totalRetries: 0,
      errorRetries: 0,
      loadingRetries: 0,
      completed: isSearch && job.options.loadImmediately,
      awaitingSelection: !job.options.loadImmediately,
      track: !isSearch,
      pageUrl: null,
      checkToken: 0,
      alarmName: null,
      lastRetryReason: null
    };

    tabState.set(tab.id, state);
    createdTabs.push(tab.id);

    updateItem(job, tab.id, {
      status: state.completed ? 'success' : state.awaitingSelection ? 'waiting-selection' : 'loading',
      tabId: tab.id,
      batch: job.batchNumber
    });

    if (!job.options.loadImmediately) {
      job.waiting += 1;
    } else if (!isSearch) {
      await scheduleWatchdog(tab.id, state);
    } else {
      job.completed += 1;
    }

    if (state.completed) tabState.delete(tab.id);
    job.opened += 1;
    touchRun(job);

    if (PER_TAB_CREATION_DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, PER_TAB_CREATION_DELAY_MS));
    }
  }

  job.nextIndex = end;
  touchRun(job);

  if (job.options.tabGroup === 'new' && createdTabs.length) {
    try {
      if (job.groupId == null) {
        job.groupId = await createTabGroup(createdTabs, job.groupTitle || 'AppsFlyer');
      } else {
        await chrome.tabs.group({ groupId: job.groupId, tabIds: createdTabs });
      }
    } catch {}
    touchRun(job);
  }

  return createdTabs;
}

async function createTabGroup(tabIds, title) {
  if (!tabIds.length) return null;
  try {
    const groupId = await chrome.tabs.group({ tabIds });
    const cleanTitle = String(title || '').trim();
    if (cleanTitle) {
      try { await chrome.tabGroups.update(groupId, { title: cleanTitle }); } catch {}
    }
    return groupId;
  } catch {
    return null;
  }
}

async function runScheduledNextBatch(jobId, expectedBatch) {
  await loadPersistentState();
  const key = `${jobId}:${expectedBatch}`;
  batchTimers.delete(key);
  try { await chrome.alarms.clear(batchAlarmName(jobId, expectedBatch)); } catch {}

  const job = historyRuns.get(String(jobId));
  if (!job || job.status === 'complete') return;
  if (expectedBatch !== job.batchNumber + 1) return;

  job.nextBatchScheduledAt = null;
  await openBatch(job);
  await scheduleNextBatch(job);
  updateJobFinalStatus(job);
  touchRun(job);
}

async function scheduleNextBatch(job) {
  if (job.nextIndex >= job.total) return;
  const nextBatchNumber = job.batchNumber + 1;
  const delaySec = Math.max(0, Math.min(300, Number(job.options.batchDelaySec) || 0));
  const delayMs = delaySec * 1000;
  const key = `${job.id}:${nextBatchNumber}`;
  const name = batchAlarmName(job.id, nextBatchNumber);

  job.nextBatchScheduledAt = Date.now() + delayMs;
  touchRun(job);

  // setTimeout gives short delays (e.g. the 10-second default) their intended timing
  // while a 30-second alarm acts as a recovery path if the MV3 service worker sleeps.
  const timer = setTimeout(() => { void runScheduledNextBatch(job.id, nextBatchNumber); }, delayMs);
  batchTimers.set(key, timer);

  try {
    const recoveryDelayMinutes = Math.max(0.5, delaySec / 60);
    await chrome.alarms.create(name, { delayInMinutes: recoveryDelayMinutes });
  } catch {
    // The in-memory timer remains the primary short-delay mechanism.
  }
}

function jobSnapshot(job) {
  if (!job) return null;
  return JSON.parse(JSON.stringify({
    id: job.id,
    total: job.total,
    opened: job.opened,
    waiting: job.waiting,
    retrying: job.retrying,
    failed: job.failed,
    completed: job.completed,
    links: job.links,
    items: job.items,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    batchNumber: job.batchNumber,
    totalBatches: job.totalBatches,
    nextIndex: job.nextIndex,
    batchSize: job.options.batchSize,
    batchDelaySec: job.options.batchDelaySec,
    groupId: job.groupId,
    groupTitle: job.groupTitle
  }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await loadPersistentState();

    if (message?.type === 'getApps') {
      sendResponse({ apps: await loadApps() });
      return;
    }

    if (message?.type === 'saveApps') {
      await saveApps(message.apps || []);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'getSettings') {
      sendResponse({ settings: await loadSettings() });
      return;
    }

    if (message?.type === 'saveSettings') {
      sendResponse({ settings: await saveSettings(message.settings || {}) });
      return;
    }

    if (message?.type === 'getWorkspace') {
      sendResponse({ workspace: await loadWorkspace() });
      return;
    }

    if (message?.type === 'saveWorkspace') {
      await saveWorkspace(message.workspace || {});
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'getHistory') {
      await persistHistoryAndTabs();
      sendResponse({ history: currentHistoryArray().map(jobSnapshot) });
      return;
    }

    if (message?.type === 'deleteHistoryRun') {
      historyRuns.delete(String(message.jobId));
      await persistHistoryAndTabs();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'clearHistory') {
      for (const [id, run] of historyRuns) {
        if (run.status !== 'running') historyRuns.delete(id);
      }
      await persistHistoryAndTabs();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'clearWorkspace') {
      await chrome.storage.local.remove('afloWorkspace');
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'extractUrls') {
      const urls = extractUrlsFromText(message.value || '').filter(isAppsFlyerPartnerUrl);
      sendResponse({ urls });
      return;
    }

    if (message?.type === 'extractAppId') {
      sendResponse({ appId: extractAppIdFromUrl(message.value) });
      return;
    }

    if (message?.type === 'buildLinks') {
      const result = buildLinksFromInput(message.appId, message.pids, {
        handleSearchQueries: Boolean(message.handleSearchQueries),
        handleNonAppsFlyerUrlsAsSearch: Boolean(message.handleNonAppsFlyerUrlsAsSearch)
      });
      let links = cleanLinks(result.links, message.ignoreDuplicates !== false);
      if (!links.length) {
        throw new Error('Enter at least one PID or a valid AppsFlyer integrated-partner URL.');
      }
      // Full AppsFlyer partner URLs are self-sufficient; an App ID is only
      // required for plain PID items that had no URL to derive it from.
      if (!result.appId && result.unbuildablePidCount > 0) {
        throw new Error('Enter a valid App ID when using plain PIDs, or paste complete AppsFlyer partner URLs.');
      }
      links = orderLinks(links, {
        reverse: Boolean(message.reverseOrder),
        random: Boolean(message.randomOrder)
      });
      sendResponse({ appId: result.appId, links, extractedUrls: result.extractedUrls });
      return;
    }

    if (message?.type === 'openLinks') {
      let links = Array.isArray(message.links) ? message.links : [];
      if (!links.length) throw new Error('No links to open.');

      // The popup sends the already-built/ordered list. Re-ordering here would
      // make Preview disagree with the actual opening order.
      links = cleanLinks(links, message.ignoreDuplicates !== false);

      const batchSize = Math.max(1, Math.min(500, Number(message.batchSize) || 7));
      const batchDelaySec = Math.max(0, Math.min(300, Number(message.batchDelaySec) || 0));
      const totalBatches = Math.ceil(links.length / batchSize);
      const now = Date.now();
      const job = {
        id: `${now}-${crypto.randomUUID()}`,
        total: links.length,
        opened: 0,
        waiting: 0,
        retrying: 0,
        failed: 0,
        completed: 0,
        links,
        items: createItemRecords(links),
        createdAt: now,
        updatedAt: now,
        status: 'running',
        nextIndex: 0,
        batchNumber: 0,
        totalBatches,
        nextBatchScheduledAt: null,
        groupId: null,
        groupTitle: String(message.groupName || '').trim(),
        options: {
          tabGroup: message.tabGroup === 'none' ? 'none' : 'new',
          groupName: String(message.groupName || '').trim(),
          loadImmediately: !Boolean(message.doNotLoadUntilSelected),
          batchSize,
          batchDelaySec
        }
      };

      historyRuns.set(job.id, job);
      touchRun(job);
      await openBatch(job);
      await scheduleNextBatch(job);
      updateJobFinalStatus(job);
      touchRun(job);
      sendResponse({ ok: true, job: jobSnapshot(job) });
      return;
    }

    if (message?.type === 'getJob') {
      const job = historyRuns.get(String(message.jobId));
      sendResponse({ job: job ? jobSnapshot(job) : null });
      return;
    }

    if (message?.type === 'pageSettled') {
      if (!sender.tab?.id) {
        sendResponse({ ok: false });
        return;
      }
      await handleSettledPage(sender.tab.id, message.pageUrl || sender.tab.url || '', Boolean(message.is404));
      sendResponse({ ok: true });
      return;
    }
  })().catch(error => sendResponse({ error: error?.message || String(error) }));
  return true;
});

chrome.tabs.onActivated.addListener(async activeInfo => {
  await loadPersistentState();
  const state = tabState.get(activeInfo.tabId);
  if (!state || state.completed || !state.awaitingSelection) return;

  state.awaitingSelection = false;
  const job = historyRuns.get(String(state.jobId));
  if (job) {
    job.waiting = Math.max(0, job.waiting - 1);
    updateItem(job, activeInfo.tabId, { status: 'loading' });
    touchRun(job);
  }

  try {
    await chrome.tabs.update(activeInfo.tabId, { url: state.url });
    if (state.track) await scheduleWatchdog(activeInfo.tabId, state);
    else markCompleted(state);
  } catch {
    markFailed(state, 'navigation-failed');
    await showManualRetry(activeInfo.tabId, state, 'navigation-failed');
  }
});

chrome.webNavigation.onCompleted.addListener(async details => {
  await loadPersistentState();
  if (details.frameId !== 0) return;
  const state = tabState.get(details.tabId);
  if (!state || state.completed || state.awaitingSelection) return;

  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (isError404Url(tab.url || '')) {
      await retryTab(details.tabId, '404');
      return;
    }
    await scheduleSettleCheck(details.tabId, tab.url || '');
  } catch {}
});

chrome.webNavigation.onErrorOccurred.addListener(async details => {
  await loadPersistentState();
  if (details.frameId !== 0) return;
  const state = tabState.get(details.tabId);
  if (!state || state.completed || state.awaitingSelection) return;
  if (details.error === 'net::ERR_ABORTED') return;
  await retryTab(details.tabId, `navigation-error:${details.error || 'unknown'}`);
});

chrome.alarms.onAlarm.addListener(async alarm => {
  await loadPersistentState();

  if (alarm.name.startsWith('af-batch:')) {
    const [, jobId, batchNumberText] = alarm.name.split(':');
    await runScheduledNextBatch(String(jobId), Number(batchNumberText));
    return;
  }

  if (!alarm.name.startsWith('af-watchdog:')) return;
  const [, tabIdText, tokenText] = alarm.name.split(':');
  const tabId = Number(tabIdText);
  const token = Number(tokenText);
  const state = tabState.get(tabId);
  if (!state || state.completed || state.checkToken !== token || state.awaitingSelection) return;
  state.alarmName = null;

  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';

    if (isError404Url(url)) {
      await retryTab(tabId, '404');
      return;
    }

    // Only a tab that is still genuinely loading gets the special loading-stuck retry.
    if (tab.status === 'loading' || !url) {
      await retryTab(tabId, 'loading-stuck');
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'checkNow' });
      if (response?.is404) {
        await retryTab(tabId, '404');
        return;
      }
      if (response?.ok !== true) {
        await retryTab(tabId, 'page-check-failed');
        return;
      }
    } catch {
      // The page is not confirmed healthy. Treat an unavailable check as an
      // inconclusive/error attempt rather than silently recording Success.
      await retryTab(tabId, 'page-check-failed');
      return;
    }

    markCompleted(state);
  } catch {
    markFailed(state, 'tab-check-failed');
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await loadPersistentState();
  const state = tabState.get(tabId);
  if (!state) return;
  void clearWatchdog(state);
  tabState.delete(tabId);

  const job = historyRuns.get(String(state.jobId));
  if (job && !state.completed) {
    const item = findItem(job, tabId);
    if (item) item.status = 'closed-before-complete';
    markFailed(state, 'tab-closed');
  } else {
    void persistHistoryAndTabs();
  }
});

void loadPersistentState();
