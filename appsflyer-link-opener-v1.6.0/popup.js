const $ = id => document.getElementById(id);

const DEFAULT_SETTINGS = { tabGroup: 'new', batchSize: 7, batchDelaySec: 10 };
let apps = [];
let currentLinks = [];
let currentJobId = null;
let groupNameTouched = false;
let settings = { ...DEFAULT_SETTINGS };
let historyTimer = null;
let jobTimer = null;
let workspaceSaveTimer = null;

function showStatus(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.className = `status${error ? ' error' : ''}`;
}

async function message(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function formatTime(ts) {
  return new Date(Number(ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatStatus(status) {
  return ({
    running: 'Running',
    complete: 'Complete',
    success: 'Success',
    failed: 'Failed',
    manual: 'Manual retry',
    retrying: 'Retrying',
    loading: 'Loading',
    'waiting-selection': 'Waiting for selection',
    queued: 'Queued',
    'closed-before-complete': 'Closed'
  })[status] || status || 'Unknown';
}

function renderApps() {
  const select = $('appSelect');
  const previous = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select an app';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  apps.forEach((app) => {
    const opt = document.createElement('option');
    opt.value = String(app.appId);
    opt.textContent = `${app.name} — ${app.appId}`;
    select.appendChild(opt);
  });
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Custom App ID / URL';
  select.appendChild(custom);
  if (previous && [...select.options].some(o => o.value === previous)) select.value = previous;
  else {
    const saved = window.__savedWorkspace?.appSelect;
    if (saved === 'custom' || workspaceAppSelectionIsValid()) select.value = String(saved);
    else select.value = '';
  }
  renderPresetManager();
  syncSelectedApp(false);
}

function workspaceAppSelectionIsValid() {
  const saved = String(window.__savedWorkspace?.appSelect || '');
  return Boolean(saved) && apps.some(app => String(app.appId) === saved);
}

function renderPresetManager() {
  const root = $('presetList');
  root.innerHTML = '';
  apps.forEach((app) => {
    const div = document.createElement('div');
    div.className = 'preset';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('strong');
    name.textContent = app.name;
    const id = document.createElement('span');
    id.textContent = app.appId;
    meta.append(name, id);

    const actions = document.createElement('div');
    actions.className = 'row';

    const edit = document.createElement('button');
    edit.className = 'ghost';
    edit.textContent = 'Edit';
    edit.onclick = () => {
      div.innerHTML = '';
      const form = document.createElement('div');
      form.className = 'row';
      const nameInput = document.createElement('input');
      nameInput.value = app.name;
      nameInput.placeholder = 'Preset name';
      const idInput = document.createElement('input');
      idInput.value = app.appId;
      idInput.placeholder = 'App ID';

      const save = document.createElement('button');
      save.className = 'secondary';
      save.textContent = 'Save';
      save.onclick = async () => {
        const nextName = nameInput.value.trim();
        const nextAppId = idInput.value.trim();
        if (!nextName || !nextAppId) return showStatus('Enter both preset name and App ID.', true);
        const normalizedId = nextAppId.toLowerCase();
        const duplicate = apps.some(other => other !== app && String(other.appId).trim().toLowerCase() === normalizedId);
        if (duplicate) return showStatus('A preset with that App ID already exists.', true);
        const oldAppId = app.appId;
        app.name = nextName;
        app.appId = nextAppId;
        await message('saveApps', { apps });
        if ($('appSelect').value === oldAppId) {
          $('appSelect').value = nextAppId;
          if (!groupNameTouched || $('groupName').value === `AppsFlyer - ${app.name}`) $('groupName').value = `AppsFlyer - ${nextName}`;
          $('appInput').value = nextAppId;
          invalidateLinks();
        }
        renderApps();
        $('appSelect').value = nextAppId;
        syncSelectedApp(false);
        scheduleWorkspaceSave();
        showStatus(`Updated preset: ${nextName}.`);
      };

      const cancel = document.createElement('button');
      cancel.className = 'ghost';
      cancel.textContent = 'Cancel';
      cancel.onclick = () => renderApps();

      form.append(nameInput, idInput, save, cancel);
      div.appendChild(form);
      nameInput.focus();
    };

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Delete';
    del.onclick = async () => {
      apps = apps.filter(other => other !== app);
      await message('saveApps', { apps });
      if ($('appSelect').value === app.appId) {
        $('appSelect').value = '';
        $('appInput').value = '';
        invalidateLinks();
      }
      renderApps();
      showStatus('Preset deleted.');
      scheduleWorkspaceSave();
    };

    actions.append(edit, del);
    div.append(meta, actions);
    root.appendChild(div);
  });
}

function syncSelectedApp(resetGroup = true) {
  const value = $('appSelect').value;
  if (!value) {
    if (value === '' && !window.__savedWorkspace?.appSelect) $('appInput').value = $('appInput').value || '';
    if (resetGroup && !groupNameTouched) $('groupName').value = '';
    invalidateLinks();
    return;
  }
  if (value === 'custom') {
    if (!window.__savedWorkspace?.appInput || $('appInput').value === '') $('appInput').value = window.__savedWorkspace?.appInput || '';
    if (resetGroup && !groupNameTouched) $('groupName').value = window.__savedWorkspace?.groupName || '';
    invalidateLinks();
    scheduleWorkspaceSave();
    return;
  }
  const app = apps.find(item => String(item.appId) === String(value));
  if (app) {
    $('appInput').value = app.appId;
    if ((resetGroup || !$('groupName').value.trim()) && !groupNameTouched) {
      $('groupName').value = `AppsFlyer - ${app.name}`;
    }
  }
  invalidateLinks();
  scheduleWorkspaceSave();
}

function invalidateLinks() {
  currentLinks = [];
  const preview = $('preview');
  preview.textContent = '';
  preview.classList.add('hidden');
  updateOpenButton();
}

function updateOpenButton() {
  $('openBtn').textContent = `Open URLs (${currentLinks.length})`;
}

function buildOptions() {
  return {
    ignoreDuplicates: $('ignoreDuplicates').checked,
    reverseOrder: $('reverseOrder').checked,
    randomOrder: $('randomOrder').checked,
    handleSearchQueries: $('searchQueries').checked,
    handleNonAppsFlyerUrlsAsSearch: $('searchQueries').checked
  };
}

async function buildLinks() {
  const result = await message('buildLinks', {
    appId: $('appInput').value,
    pids: $('pids').value,
    ...buildOptions()
  });
  currentLinks = result.links;
  $('preview').classList.remove('hidden');
  const orderLabel = $('randomOrder').checked ? 'random' : $('reverseOrder').checked ? 'reverse' : 'input';
  $('preview').textContent = currentLinks.map((x, i) => `${i + 1}. ${x.pid}${x.type === 'search' ? ' [search]' : ''}\n${x.url}`).join('\n\n');
  showStatus(`${currentLinks.length} URL${currentLinks.length === 1 ? '' : 's'} ready • order: ${orderLabel}. Batch: ${settings.batchSize} • ${settings.batchDelaySec}s.`);
  updateOpenButton();
  await saveWorkspaceNow();
  return result;
}

async function extractUrls() {
  const result = await message('extractUrls', { value: $('pids').value });
  $('extractedUrls').value = result.urls.join('\n');
  $('extractedCount').textContent = result.urls.length;
  $('extractedCard').classList.toggle('hidden', result.urls.length === 0);
  if (!result.urls.length) showStatus('No AppsFlyer integrated-partner URLs found in the input.', true);
  else showStatus(`Extracted ${result.urls.length} AppsFlyer URL${result.urls.length === 1 ? '' : 's'}.`);
  scheduleWorkspaceSave();
}

function useExtractedUrls() {
  const urls = $('extractedUrls').value.trim();
  if (!urls) return;
  $('pids').value = urls;
  invalidateLinks();
  showStatus('Extracted URLs copied into the main input.');
  scheduleWorkspaceSave();
}

async function saveSettingsNow() {
  settings = {
    ...settings,
    tabGroup: $('tabGroup').value === 'none' ? 'none' : 'new',
    batchSize: clampNumber($('batchSizeSetting').value, 1, 500, 7),
    batchDelaySec: clampNumber($('batchDelaySetting').value, 0, 300, 10)
  };
  await message('saveSettings', { settings });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getWorkspace() {
  return {
    appSelect: $('appSelect').value,
    appInput: $('appInput').value,
    pids: $('pids').value,
    extractedUrls: $('extractedUrls').value,
    groupName: $('groupName').value,
    groupNameTouched,
    ignoreDuplicates: $('ignoreDuplicates').checked,
    randomOrder: $('randomOrder').checked,
    reverseOrder: $('reverseOrder').checked,
    searchQueries: $('searchQueries').checked,
    tabGroup: $('tabGroup').value,
    doNotLoad: $('doNotLoad').checked,
    preserveInput: $('preserveInput').checked,
    currentLinks
  };
}

function scheduleWorkspaceSave() {
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(saveWorkspaceNow, 250);
}

async function saveWorkspaceNow() {
  try { await message('saveWorkspace', { workspace: getWorkspace() }); } catch {}
}

function restoreWorkspace(workspace) {
  window.__savedWorkspace = workspace || {};
  const ws = window.__savedWorkspace;
  currentLinks = Array.isArray(ws.currentLinks) ? ws.currentLinks : [];
  $('pids').value = ws.pids || '';
  $('appInput').value = ws.appInput || '';
  $('extractedUrls').value = ws.extractedUrls || '';
  $('extractedCount').textContent = (ws.extractedUrls || '').split('\n').filter(Boolean).length;
  $('extractedCard').classList.toggle('hidden', !$('extractedUrls').value.trim());
  $('ignoreDuplicates').checked = ws.ignoreDuplicates !== false;
  $('randomOrder').checked = Boolean(ws.randomOrder);
  $('reverseOrder').checked = Boolean(ws.reverseOrder);
  $('searchQueries').checked = Boolean(ws.searchQueries);
  $('tabGroup').value = ws.tabGroup === 'none' ? 'none' : 'new';
  $('doNotLoad').checked = Boolean(ws.doNotLoad);
  $('preserveInput').checked = ws.preserveInput !== false;
  $('groupName').value = ws.groupName || '';
  groupNameTouched = Boolean(ws.groupNameTouched);
  updateOpenButton();
  if (currentLinks.length) {
    $('preview').classList.remove('hidden');
    $('preview').textContent = currentLinks.map((x, i) => `${i + 1}. ${x.pid}\n${x.url}`).join('\n\n');
  }
}

function applySettingsUi() {
  $('tabGroup').value = settings.tabGroup === 'none' ? 'none' : 'new';
  $('batchSizeSetting').value = settings.batchSize;
  $('batchDelaySetting').value = settings.batchDelaySec;
}

function renderHistory(history) {
  const root = $('historyList');
  if (!history.length) {
    root.innerHTML = '<div class="empty">No recent runs.</div>';
    return;
  }

  root.innerHTML = history.map(run => {
    const failedItems = run.items.filter(i => ['manual', 'failed', 'closed-before-complete'].includes(i.status));
    const retryingItems = run.items.filter(i => i.status === 'retrying');
    const headline = `${run.groupTitle || 'AppsFlyer run'} • ${formatTime(run.createdAt)}`;
    const summary = `${run.total} URLs • ${run.completed} success • ${run.failed} failed${retryingItems.length ? ` • ${retryingItems.length} retrying` : ''}`;
    const statusClass = run.status === 'complete' && run.failed ? 'warn' : run.status === 'complete' ? 'ok' : 'active';
    const details = run.items.map((item, idx) => `
      <div class="historyItem">
        <div class="historyItemTop">
          <span class="itemNo">${idx + 1}</span>
          <span class="itemPid">${escapeHtml(item.pid)}</span>
          <span class="badge ${item.status === 'manual' ? 'manual' : item.status === 'success' ? 'ok' : item.status === 'retrying' ? 'retry' : ''}">${escapeHtml(formatStatus(item.status))}</span>
        </div>
        <div class="historyUrl">${escapeHtml(item.url)}</div>
        <div class="historyMeta">Error retries: ${Number(item.errorRetries) || 0} • Loading retries: ${Number(item.loadingRetries) || 0}${item.lastRetryReason ? ` • ${escapeHtml(item.lastRetryReason)}` : ''}</div>
        <button class="copyHistoryBtn" data-url="${escapeHtml(item.url)}">Copy URL</button>
      </div>
    `).join('');

    return `
      <details class="historyRun" ${failedItems.length ? 'open' : ''}>
        <summary>
          <div class="runSummary">
            <div><strong>${escapeHtml(headline)}</strong><span>${escapeHtml(summary)}</span></div>
            <span class="badge ${statusClass}">${escapeHtml(formatStatus(run.status))}</span>
          </div>
        </summary>
        <div class="runDetails">
          <div class="batchMeta">Batch ${Number(run.batchNumber) || 0}/${Number(run.totalBatches) || 0} • Size ${Number(run.batchSize) || 7} • Delay ${Number(run.batchDelaySec) || 0}s</div>
          ${details}
          <button class="removeRunBtn ghost full" data-run-id="${escapeHtml(run.id)}">Remove this run</button>
        </div>
      </details>
    `;
  }).join('');

  root.querySelectorAll('.copyHistoryBtn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(btn.dataset.url || '');
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy URL'; }, 1200);
      } catch {
        showStatus('Copy failed. Select the URL from the history entry.', true);
      }
    });
  });

  root.querySelectorAll('.removeRunBtn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.preventDefault();
      await message('deleteHistoryRun', { jobId: btn.dataset.runId });
      await refreshHistory();
    });
  });
}

async function refreshHistory() {
  try {
    const result = await message('getHistory');
    renderHistory(result.history || []);
    if (currentJobId) {
      const live = (result.history || []).find(run => String(run.id) === String(currentJobId));
      if (live) {
        showStatus(`Tabs: ${live.opened}/${live.total} • Waiting: ${live.waiting} • Success: ${live.completed} • Retrying: ${live.retrying} • Failed: ${live.failed} • Batch ${live.batchNumber}/${live.totalBatches}`);
        if (live.status === 'complete') currentJobId = null;
      }
    }
  } catch {}
}

function startHistoryPolling() {
  clearInterval(historyTimer);
  historyTimer = setInterval(refreshHistory, 1500);
}

async function init() {
  try {
    const [appResult, settingsResult, workspaceResult] = await Promise.all([
      message('getApps'), message('getSettings'), message('getWorkspace')
    ]);
    apps = appResult.apps || [];
    settings = { ...DEFAULT_SETTINGS, ...(settingsResult.settings || {}) };
    restoreWorkspace(workspaceResult.workspace || {});
    renderApps();
    applySettingsUi();
    if (!$('groupName').value.trim() && $('appSelect').value && $('appSelect').value !== 'custom') syncSelectedApp(false);
    updateOpenButton();
    await refreshHistory();
    startHistoryPolling();
  } catch (e) {
    showStatus(e.message, true);
  }
}

$('appSelect').addEventListener('change', () => {
  syncSelectedApp(true);
  scheduleWorkspaceSave();
});
$('appInput').addEventListener('input', () => {
  if ($('appSelect').value !== 'custom' && $('appInput').value.trim()) $('appSelect').value = 'custom';
  invalidateLinks();
  scheduleWorkspaceSave();
});
$('pids').addEventListener('input', () => { invalidateLinks(); scheduleWorkspaceSave(); });
$('groupName').addEventListener('input', () => { groupNameTouched = true; scheduleWorkspaceSave(); });
['ignoreDuplicates', 'randomOrder', 'reverseOrder', 'searchQueries', 'tabGroup', 'doNotLoad', 'preserveInput'].forEach(id => {
  $(id).addEventListener('change', () => {
    invalidateLinks();
    if (id === 'tabGroup') settings.tabGroup = $('tabGroup').value;
    scheduleWorkspaceSave();
  });
});

$('buildBtn').addEventListener('click', async () => {
  try { await buildLinks(); } catch (e) { showStatus(e.message, true); }
});

$('extractBtn').addEventListener('click', async () => {
  try { await extractUrls(); } catch (e) { showStatus(e.message, true); }
});

$('useExtractedBtn').addEventListener('click', useExtractedUrls);

$('openBtn').addEventListener('click', async () => {
  const button = $('openBtn');
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (!currentLinks.length) await buildLinks();
    if (!currentLinks.length) throw new Error('No valid URLs to open.');
    await saveWorkspaceNow();
    const groupMode = $('tabGroup').value;
    const selectedOption = $('appSelect').selectedOptions[0];
    const selectedName = selectedOption?.value && selectedOption.value !== 'custom' ? selectedOption.textContent.split(' — ')[0] : '';
    const groupName = $('groupName').value.trim() || (selectedName ? `AppsFlyer - ${selectedName}` : 'AppsFlyer Run');
    const result = await message('openLinks', {
      links: currentLinks,
      ignoreDuplicates: $('ignoreDuplicates').checked,
      randomOrder: $('randomOrder').checked,
      reverseOrder: $('reverseOrder').checked,
      tabGroup: groupMode,
      groupName,
      doNotLoadUntilSelected: $('doNotLoad').checked,
      batchSize: settings.batchSize,
      batchDelaySec: settings.batchDelaySec
    });
    currentJobId = result.job.id;
    showStatus(`Started ${result.job.total} URLs in batches of ${settings.batchSize}, ${settings.batchDelaySec}s apart.${groupMode === 'new' ? ` Group: ${groupName}.` : ''}`);
    await refreshHistory();
    if (!$('preserveInput').checked) {
      $('pids').value = '';
      $('extractedUrls').value = '';
      $('extractedCard').classList.add('hidden');
      currentLinks = [];
      $('preview').textContent = '';
      $('preview').classList.add('hidden');
      updateOpenButton();
      scheduleWorkspaceSave();
    }
  } catch (e) {
    showStatus(e.message, true);
  } finally {
    button.disabled = false;
  }
});

$('settingsBtn').addEventListener('click', async () => {
  $('settings').classList.toggle('hidden');
  if (!$('settings').classList.contains('hidden')) {
    const result = await message('getSettings');
    settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
    applySettingsUi();
  }
});
$('closeSettingsBtn').addEventListener('click', () => $('settings').classList.add('hidden'));

$('saveBatchSettingsBtn').addEventListener('click', async () => {
  try {
    settings = {
      ...settings,
      batchSize: clampNumber($('batchSizeSetting').value, 1, 500, 7),
      batchDelaySec: clampNumber($('batchDelaySetting').value, 0, 300, 10)
    };
    await message('saveSettings', { settings });
    applySettingsUi();
    showStatus(`Batch settings saved: ${settings.batchSize} tabs every ${settings.batchDelaySec}s.`);
  } catch (e) { showStatus(e.message, true); }
});

$('addPresetBtn').addEventListener('click', async () => {
  const name = $('newPresetName').value.trim();
  const appId = $('newPresetId').value.trim();
  if (!name || !appId) return showStatus('Enter both preset name and App ID.', true);
  const normalizedId = appId.toLowerCase();
  if (apps.some(app => String(app.appId).trim().toLowerCase() === normalizedId)) {
    return showStatus('A preset with that App ID already exists.', true);
  }
  if (apps.some(app => String(app.name).trim().toLowerCase() === name.toLowerCase())) {
    return showStatus('A preset with that name already exists.', true);
  }
  apps.push({ name, appId });
  await message('saveApps', { apps });
  $('newPresetName').value = '';
  $('newPresetId').value = '';
  renderApps();
  $('appSelect').value = appId;
  groupNameTouched = false;
  syncSelectedApp(true);
  await saveWorkspaceNow();
  showStatus(`Added preset: ${name}.`);
});

$('clearHistoryBtn').addEventListener('click', async () => {
  await message('clearHistory');
  await refreshHistory();
  showStatus('Finished runs cleared.');
});

$('clearWorkspaceBtn').addEventListener('click', async () => {
  await message('clearWorkspace');
  window.__savedWorkspace = {};
  currentLinks = [];
  $('appSelect').value = '';
  $('appInput').value = '';
  $('pids').value = '';
  $('extractedUrls').value = '';
  $('extractedCard').classList.add('hidden');
  $('groupName').value = '';
  groupNameTouched = false;
  updateOpenButton();
  showStatus('Remembered work cleared.');
});

init();
