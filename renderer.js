'use strict';

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  logs: [],
  filter: 'all',
  search: '',
  autoScroll: true,
  connectedCount: 0,
  appInfo: null,
  sessionStartedAt: Date.now(),
  theme: 'dark',
  devices: [],
  projectPath: null,
  projectCommand: null,
  projectStatus: 'stopped',
  lastLogFingerprint: null,
  recents: [],
  metroReadyLogId: null,   // id of the "Waiting on…" log entry, for highlight
  activePreset: null,      // currently applied device preset key
};

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  statusDot:          $('status-dot'),
  statusLabel:        $('status-label'),
  logList:            $('log-list'),
  emptyState:         $('empty-state'),
  logSearch:          $('log-search'),
  clearSearch:        $('clear-search'),
  clearBtn:           $('clear-btn'),
  autoscrollBtn:      $('autoscroll-btn'),
  exportBtn:          $('export-btn'),
  exportMenu:         $('export-menu'),
  exportJson:         $('export-json'),
  exportTxt:          $('export-txt'),
  statTotal:          $('stat-total'),
  statErrors:         $('stat-errors'),
  statWarns:          $('stat-warns'),
  filteredNote:       $('filtered-note'),
  devicePresetBadge:  $('device-preset-badge'),
  appNameDisplay:     $('app-name-display'),
  appBundleDisplay:   $('app-bundle-display'),
  portDisplay:        $('port-display'),
  copyToast:          $('copy-toast'),
  filterBtns:         document.querySelectorAll('.filter-btn'),
  navItems:           document.querySelectorAll('.nav-item'),
  devicesList:        $('devices-list'),
  devicesEmpty:       $('devices-empty'),
  themeBtns:          document.querySelectorAll('.theme-btn'),
  historyRefreshBtn:  $('history-refresh-btn'),
  sessionList:        $('session-list'),
  sessionEmptyState:  $('session-empty-state'),
  replayEmpty:        $('replay-empty'),
  replayHeader:       $('replay-header'),
  replayLogList:      $('replay-log-list'),
  replayAppName:      $('replay-app-name'),
  replayDate:         $('replay-date'),
  replayStatTotal:    $('replay-stat-total'),
  replayStatErrors:   $('replay-stat-errors'),
  replayStatWarns:    $('replay-stat-warns'),
  // project toolbar (logs view)
  projectPath:        $('project-path'),
  projectCommand:     $('project-command'),
  selectProjectBtn:   $('select-project-btn'),
  startProjectBtn:    $('start-project-btn'),
  stopProjectBtn:     $('stop-project-btn'),
  metroShortcuts:     $('metro-shortcuts'),
  devicePickerBtn:    $('device-picker-btn'),
  // projects view
  addProjectBtn:      $('add-project-btn'),
  recentList:         $('recent-list'),
  recentEmpty:        $('recent-empty'),
  recentsLabel:       $('recents-label'),
  runningCard:        $('running-project-card'),
  runningName:        $('running-project-name'),
  runningPath:        $('running-project-path'),
  runningCmd:         $('running-project-cmd'),
  rcStopBtn:          $('rc-stop-btn'),
  rcViewLogsBtn:      $('rc-view-logs-btn'),
};

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const port = await window.rni.getServerPort();
  els.portDisplay.textContent = port;

  await initTheme();
  bindEvents();
  registerIPC();

  // Auto-scroll is on by default — assert it explicitly (rather than just
  // relying on the initial state value) so it can never start off out of
  // sync with the toggle button's visual state.
  state.autoScroll = true;
  els.autoscrollBtn.classList.add('active');

  renderLogs();

  const existing = await window.rni.getConnectedClients();
  if (existing.length > 0) { state.devices = existing; renderDevices(); }

  const project = await window.rni.getProjectStatus();
  if (project.path) {
    state.projectPath    = project.path;
    state.projectCommand = project.command;
    renderProjectInfo();
  }
  updateProjectControls(project.running ? 'running' : 'stopped');

  state.recents = await window.rni.listRecents();
  renderRecents();
}

// ── Theme ──────────────────────────────────────────────────────────────────

async function initTheme() {
  const prefs = await window.rni.getPrefs();
  state.theme = prefs.theme || 'dark';
  await applyTheme(state.theme);
  updateThemeBtns();
}

async function applyTheme(theme) {
  let resolved = theme;
  if (theme === 'system') resolved = await window.rni.getSystemTheme();
  document.documentElement.setAttribute('data-theme', resolved);
}

function updateThemeBtns() {
  els.themeBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.theme === state.theme));
}

// ── IPC listeners ──────────────────────────────────────────────────────────

function registerIPC() {
  window.rni.on('project:status', (data) => {
    if (data.path)    state.projectPath    = data.path;
    if (data.command) state.projectCommand = data.command;
    if (data.path || data.command) renderProjectInfo();
    updateProjectControls(data.status);
    updateRunningCard();

    // Reset metro-ready highlight when project stops/restarts
    if (data.status === 'stopped' || data.status === 'starting' || data.status === 'exited') {
      state.metroReadyLogId = null;
    }
  });

  window.rni.on('recents:updated', (recents) => {
    state.recents = recents;
    renderRecents();
  });

  window.rni.on('ws:server-started', ({ port }) => {
    els.portDisplay.textContent = port;
  });

  window.rni.on('ws:client-connected', ({ connectedCount }) => {
    state.connectedCount = connectedCount;
    state.sessionStartedAt = Date.now();
    if (connectedCount === 1 && !state.appInfo) setStatus('reconnecting', 'Connecting…');
  });

  window.rni.on('ws:client-disconnected', ({ clientId, connectedCount }) => {
    state.connectedCount = connectedCount;
    state.devices = state.devices.filter((d) => d.clientId !== clientId);
    renderDevices();
    if (connectedCount === 0) {
      if (state.logs.length > 0) persistSession();
      setStatus('disconnected', 'Waiting for app…');
      state.appInfo = null;
      els.appNameDisplay.textContent   = 'No app connected';
      els.appBundleDisplay.textContent = '—';
    } else {
      setStatus('connected', `${connectedCount} connected`);
    }
  });

  window.rni.on('ws:devices-updated', (devices) => {
    state.devices = devices;
    renderDevices();
  });

  window.rni.on('app:info', ({ appName, bundleId, platform }) => {
    state.appInfo = { appName, bundleId, platform };
    const name = appName || 'Unknown App';
    const plat = platform ? ` · ${platform}` : '';
    setStatus('connected', `${name}${plat}`);
    els.appNameDisplay.textContent   = name;
    els.appBundleDisplay.textContent = bundleId || '—';
  });

  window.rni.on('log:entry', (entry) => ingestEntry(entry));

  // ── Metro ready: highlight the "Waiting on…" line ────────────────────────
  window.rni.on('metro:ready', ({ port }) => {
    // The log entry for this line will already have metroReady=true and will
    // have been stored in state.metroReadyLogId by ingestEntry(). Here we just
    // scroll to it if auto-scroll is off.
    if (state.metroReadyLogId) {
      const node = els.logList.querySelector(`[data-id="${state.metroReadyLogId}"]`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // ── Device preset applied ─────────────────────────────────────────────────
  window.rni.on('device:preset-applied', (data) => {
    state.activePreset = data.presetKey;
    updatePresetBadge(data);
  });

  window.rni.on('theme:system-changed', async ({ isDark }) => {
    if (state.theme === 'system') {
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    }
  });
}

// ── Device preset badge ────────────────────────────────────────────────────

function updatePresetBadge(data) {
  if (!data || data.responsive) {
    els.devicePresetBadge.textContent = '⊞ Responsive';
    els.devicePresetBadge.className   = 'preset-badge responsive';
    els.devicePresetBadge.classList.remove('hidden');
  } else {
    els.devicePresetBadge.textContent = `📱 ${data.label}  ${data.deviceW}×${data.deviceH}`;
    els.devicePresetBadge.className   = 'preset-badge fixed';
    els.devicePresetBadge.classList.remove('hidden');
  }
}

// ── Log ingestion ──────────────────────────────────────────────────────────

function logFingerprint(entry) {
  return `${entry.source || 'app'}|${entry.level}|${argsToString(entry.args)}`;
}

function ingestEntry(entry) {
  const fp = logFingerprint(entry);

  if (fp === state.lastLogFingerprint && state.logs.length > 0) {
    const last = state.logs[state.logs.length - 1];
    last.repeatCount = (last.repeatCount || 1) + 1;
    const node = els.logList.querySelector(`[data-id="${last.id}"]`);
    if (node) {
      let badge = node.querySelector('.log-repeat-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'log-repeat-badge';
        const copyBtn = node.querySelector('.log-copy');
        node.insertBefore(badge, copyBtn);
      }
      badge.textContent = `×${last.repeatCount}`;
    }
    updateStats();
    return;
  }

  state.lastLogFingerprint = fp;

  // Tag metro-ready entries so we can highlight them
  if (entry.metroReady) {
    state.metroReadyLogId = entry.id;
  }

  state.logs.push(entry);

  const visible = entryMatchesFilter(entry);
  if (visible) {
    appendLogEntry(entry, state.search, els.logList);
    updateStats();
    if (state.autoScroll) scrollToBottom();
  } else {
    updateStats();
  }
  updateEmptyState();
}

// ── Events ─────────────────────────────────────────────────────────────────

function bindEvents() {
  // Nav switching
  els.navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      els.navItems.forEach((n) => n.classList.toggle('active', n === item));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
      if (view === 'history') loadSessionList();
      if (view === 'projects') renderRecents();
    });
  });

  // Filter buttons
  els.filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      els.filterBtns.forEach((b) => b.classList.toggle('active', b === btn));
      renderLogs();
    });
  });

  // Search
  els.logSearch.addEventListener('input', () => {
    state.search = els.logSearch.value.trim();
    els.clearSearch.classList.toggle('hidden', !state.search);
    renderLogs();
  });
  els.clearSearch.addEventListener('click', () => {
    els.logSearch.value = ''; state.search = '';
    els.clearSearch.classList.add('hidden');
    renderLogs(); els.logSearch.focus();
  });

  // Clear logs
  els.clearBtn.addEventListener('click', () => {
    if (state.logs.length > 0) persistSession();
    state.logs = []; state.lastLogFingerprint = null;
    state.metroReadyLogId = null;
    state.sessionStartedAt = Date.now();
    renderLogs();
  });

  // Auto-scroll
  els.autoscrollBtn.addEventListener('click', () => {
    state.autoScroll = !state.autoScroll;
    els.autoscrollBtn.classList.toggle('active', state.autoScroll);
    if (state.autoScroll) scrollToBottom();
  });
  els.logList.addEventListener('scroll', () => {
    // Ignore scroll events caused by our own programmatic scrollToBottom()
    // calls — otherwise the resulting scroll event can be mistaken for the
    // user scrolling away and incorrectly flip auto-scroll off.
    if (suppressScrollCheck) return;
    const atBottom = els.logList.scrollHeight - els.logList.scrollTop - els.logList.clientHeight < 40;
    if (!atBottom && state.autoScroll) {
      state.autoScroll = false;
      els.autoscrollBtn.classList.remove('active');
    }
  });

  // Export menu
  els.exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = els.exportBtn.getBoundingClientRect();
    els.exportMenu.style.top  = `${btn.bottom + 4}px`;
    els.exportMenu.style.left = `${btn.right - 120}px`;
    els.exportMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => els.exportMenu.classList.add('hidden'));
  els.exportJson.addEventListener('click', () => exportLogs('json'));
  els.exportTxt.addEventListener('click',  () => exportLogs('txt'));

  // ── Device picker button ─────────────────────────────────────────────────
  els.devicePickerBtn.addEventListener('click', () => {
    window.rni.pickerOpen();
  });

  // History refresh
  els.historyRefreshBtn.addEventListener('click', () => loadSessionList());

  // Logs view — project controls
  els.selectProjectBtn.addEventListener('click', async () => {
    const project = await window.rni.selectProject();
    if (!project) return;
    state.projectPath    = project.path;
    state.projectCommand = project.command;
    renderProjectInfo();
    updateProjectControls('stopped');
  });

  els.startProjectBtn.addEventListener('click', async () => {
    if (!state.projectPath) {
      const project = await window.rni.selectProject();
      if (!project) return;
      state.projectPath    = project.path;
      state.projectCommand = project.command;
      renderProjectInfo();
    }
    try {
      await window.rni.startProject(state.projectPath);
      switchView('logs');
    } catch (err) {
      ingestEntry({ id: `ui-error-${Date.now()}`, level: 'error', source: 'system', args: [err.message || String(err)], timestamp: Date.now() });
    }
  });

  els.stopProjectBtn.addEventListener('click', () => window.rni.stopProject());

  // Metro shortcut buttons
  document.querySelectorAll('.shortcut-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd;
      const sent = await window.rni.sendStdin(cmd);
      if (sent) {
        ingestEntry({ id: `cmd-${Date.now()}`, level: 'info', source: 'system', args: [`→ Sent: ${cmd}`], timestamp: Date.now() });
      }

      // The managed project process isn't attached to a real TTY, so those
      // keypress-style stdin commands often never reach Metro. Reload and
      // Debugger additionally act directly on the device preview window
      // (the webview showing the running app), which always works.
      if (cmd === 'r') {
        const reloaded = await window.rni.reloadPreview();
        if (!reloaded) {
          ingestEntry({ id: `cmd-warn-${Date.now()}`, level: 'warn', source: 'system', args: ['No device preview is open to reload — open one from the device picker.'], timestamp: Date.now() });
        }
      } else if (cmd === 'j') {
        const opened = await window.rni.openPreviewDevtools();
        if (!opened) {
          ingestEntry({ id: `cmd-warn-${Date.now()}`, level: 'warn', source: 'system', args: ['No device preview is open to debug — open one from the device picker.'], timestamp: Date.now() });
        }
      }
    });
  });

  // Projects view — add project
  els.addProjectBtn.addEventListener('click', async () => {
    const project = await window.rni.selectProject();
    if (!project) return;
    if (!project.valid) {
      ingestEntry({ id: `val-${Date.now()}`, level: 'error', source: 'system', args: [project.reason || 'Not a valid RN project.'], timestamp: Date.now() });
      return;
    }
    state.projectPath    = project.path;
    state.projectCommand = project.command;
    renderProjectInfo();
    state.recents = await window.rni.listRecents();
    renderRecents();
    try {
      await window.rni.startProject(project.path);
      switchView('logs');
    } catch (err) {
      ingestEntry({ id: `ui-error-${Date.now()}`, level: 'error', source: 'system', args: [err.message || String(err)], timestamp: Date.now() });
    }
  });

  // Running card buttons
  els.rcStopBtn.addEventListener('click', () => window.rni.stopProject());
  els.rcViewLogsBtn.addEventListener('click', () => switchView('logs'));

  // Theme buttons
  els.themeBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.theme = btn.dataset.theme;
      await window.rni.setPrefs({ theme: state.theme });
      await applyTheme(state.theme);
      updateThemeBtns();
    });
  });
}

// ── View switching helper ──────────────────────────────────────────────────

function switchView(view) {
  els.navItems.forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
}

// ── Project UI ─────────────────────────────────────────────────────────────

function renderProjectInfo() {
  els.projectPath.textContent    = state.projectPath    || 'No project selected';
  els.projectPath.title          = state.projectPath    || '';
  els.projectCommand.textContent = state.projectCommand ? `Command: ${state.projectCommand}` : 'Select a React Native project to begin';
}

function updateProjectControls(status) {
  state.projectStatus = status;
  const running = status === 'starting' || status === 'running';
  els.startProjectBtn.disabled    = running || !state.projectPath;
  els.stopProjectBtn.disabled     = !running;
  els.selectProjectBtn.disabled   = running;

  els.metroShortcuts.classList.toggle('hidden', !running);

  if (status === 'starting') {
    els.startProjectBtn.textContent = 'Starting…';
    setStatus('reconnecting', 'Starting project…');
  } else if (status === 'running') {
    els.startProjectBtn.textContent = 'Running';
  } else if (status === 'exited' || status === 'error') {
    els.startProjectBtn.textContent = 'Restart';
    els.startProjectBtn.disabled = false;
  } else {
    els.startProjectBtn.textContent = 'Start';
    if (!state.projectPath) els.startProjectBtn.disabled = true;
  }

  updateRunningCard();
}

function updateRunningCard() {
  const running = state.projectStatus === 'running' || state.projectStatus === 'starting';
  els.runningCard.classList.toggle('hidden', !running);
  if (running && state.projectPath) {
    const name = state.recents.find((r) => r.path === state.projectPath)?.name || pathBasename(state.projectPath);
    els.runningName.textContent = name;
    els.runningPath.textContent = state.projectPath;
    els.runningCmd.textContent  = state.projectCommand || '—';
  }
}

function pathBasename(p) {
  return p ? p.split(/[\\/]/).filter(Boolean).pop() : '—';
}

// ── Recents ────────────────────────────────────────────────────────────────

const ICONS = {
  run:    `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7Z"/></svg>`,
  edit:   `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  remove: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
};

function renderRecents() {
  els.recentList.innerHTML = '';
  if (!state.recents || state.recents.length === 0) {
    els.recentEmpty.style.display = 'flex';
    return;
  }
  els.recentEmpty.style.display = 'none';

  state.recents.forEach((recent) => {
    const isRunning = state.projectPath === recent.path &&
      (state.projectStatus === 'running' || state.projectStatus === 'starting');
    const li = document.createElement('li');
    li.className = `recent-item${isRunning ? ' is-running' : ''}`;
    li.dataset.path = recent.path;

    li.innerHTML = `
      <div class="recent-main">
        <span class="recent-name">${escapeHtml(recent.name || pathBasename(recent.path))}</span>
        <span class="recent-type-badge">${escapeHtml(recent.type || 'RN')}</span>
        ${isRunning ? '<span class="recent-running-badge">● Running</span>' : ''}
      </div>
      <span class="recent-path">${escapeHtml(recent.path)}</span>
      <span class="recent-cmd">${escapeHtml(recent.command || '')}</span>
      <div class="recent-actions">
        <button class="recent-icon-btn" data-action="run" title="${isRunning ? 'View Logs' : 'Run'}">${ICONS.run}</button>
        <button class="recent-icon-btn" data-action="edit" title="Rename">${ICONS.edit}</button>
        <button class="recent-icon-btn danger" data-action="remove" title="Remove">${ICONS.remove}</button>
      </div>
    `;
    els.recentList.appendChild(li);
  });
}

els.recentList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.recent-icon-btn');
  if (!btn) return;
  const li   = btn.closest('.recent-item');
  const p    = li?.dataset.path;
  const recent = state.recents.find((r) => r.path === p);
  if (!recent) return;

  const action = btn.dataset.action;

  if (action === 'run') {
    const isRunning = state.projectPath === p && (state.projectStatus === 'running' || state.projectStatus === 'starting');
    if (isRunning) { switchView('logs'); return; }
    state.projectPath    = p;
    state.projectCommand = recent.command;
    renderProjectInfo();
    updateProjectControls('stopped');
    try {
      await window.rni.startProject(p);
      switchView('logs');
    } catch (err) {
      ingestEntry({ id: `err-${Date.now()}`, level: 'error', source: 'system', args: [err.message || String(err)], timestamp: Date.now() });
    }
  } else if (action === 'edit') {
    startRenamingRecent(li, recent);
  } else if (action === 'remove') {
    const res = await window.rni.removeRecent(p);
    if (res.ok === false) { alert(res.reason); return; }
    state.recents = await window.rni.listRecents();
    renderRecents();
  }
});

function startRenamingRecent(li, recent) {
  const nameEl = li.querySelector('.recent-name');
  if (!nameEl) return;
  const cur = recent.name || pathBasename(recent.path);
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'recent-name-input'; inp.value = cur;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  let settled = false;
  const commit = async () => {
    if (settled) return; settled = true;
    const newName = inp.value.trim() || cur;
    if (newName !== cur) await window.rni.renameRecent(recent.path, newName);
    state.recents = await window.rni.listRecents();
    renderRecents();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') inp.blur();
    else if (ev.key === 'Escape') { settled = true; renderRecents(); }
  });
}

// ── Devices list ──────────────────────────────────────────────────────────

function renderDevices() {
  els.devicesList.querySelectorAll('.device-entry').forEach((el) => el.remove());
  if (state.devices.length === 0) { els.devicesEmpty.classList.remove('hidden'); return; }
  els.devicesEmpty.classList.add('hidden');
  state.devices.forEach((dev) => {
    const el = document.createElement('div');
    el.className = 'device-entry'; el.dataset.clientId = dev.clientId;
    const name = dev.appName || 'Connecting…';
    const plat = dev.platform || '';
    el.innerHTML = `
      <span class="device-entry-dot"></span>
      <div class="device-entry-info">
        <span class="device-entry-name">${escapeHtml(name)}</span>
        ${plat ? `<span class="device-entry-plat">${escapeHtml(plat)}</span>` : ''}
      </div>
    `;
    els.devicesList.insertBefore(el, els.devicesEmpty);
  });
}

// ── Session persistence ────────────────────────────────────────────────────

async function persistSession() {
  const session = {
    id: `${state.sessionStartedAt}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: state.sessionStartedAt,
    endedAt: Date.now(),
    appName: state.appInfo?.appName || (state.projectPath ? pathBasename(state.projectPath) : 'Unknown App'),
    platform: state.appInfo?.platform || null,
    logs: state.logs.map((l) => ({
      id: l.id, level: l.level, source: l.source || 'app',
      stream: l.stream || null, args: l.args, timestamp: l.timestamp,
      repeatCount: l.repeatCount || 1,
    })),
  };
  await window.rni.saveSession(session);
}

// ── Session history view ───────────────────────────────────────────────────

async function loadSessionList() {
  const sessions = await window.rni.listSessions();
  els.sessionList.innerHTML = '';
  if (sessions.length === 0) { els.sessionEmptyState.classList.remove('hidden'); return; }
  els.sessionEmptyState.classList.add('hidden');
  groupSessionsByDate(sessions).forEach(({ label, items }) => {
    const groupEl = document.createElement('div'); groupEl.className = 'session-group';
    const groupLabel = document.createElement('div'); groupLabel.className = 'session-group-label'; groupLabel.textContent = label;
    groupEl.appendChild(groupLabel);
    items.forEach((s) => {
      const el = document.createElement('button'); el.className = 'session-item'; el.dataset.id = s.id;
      const time     = formatSessionTime(s.startedAt);
      const duration = formatDuration(s.startedAt, s.endedAt);
      const name     = s.appName || 'Unknown App';
      const plat     = s.platform ? `· ${s.platform}` : '';
      el.innerHTML = `
        <div class="session-item-top">
          <span class="session-item-name">${escapeHtml(name)} <span class="session-item-platform">${plat}</span></span>
          <span class="session-item-time">${time}</span>
        </div>
        <div class="session-item-bottom">
          <span class="session-item-count">${s.logCount} entries</span>
          ${s.errorCount > 0 ? `<span class="session-item-errors">${s.errorCount} errors</span>` : ''}
          ${s.warnCount  > 0 ? `<span class="session-item-warns">${s.warnCount} warns</span>` : ''}
          <span class="session-item-duration">${duration}</span>
        </div>
      `;
      el.addEventListener('click', () => {
        document.querySelectorAll('.session-item').forEach((i) => i.classList.remove('active'));
        el.classList.add('active'); replaySession(s.id);
      });
      groupEl.appendChild(el);
    });
    els.sessionList.appendChild(groupEl);
  });
}

async function replaySession(id) {
  const session = await window.rni.loadSession(id);
  if (!session) return;
  const logs   = session.logs || [];
  const errors = logs.filter((l) => l.level === 'error').length;
  const warns  = logs.filter((l) => l.level === 'warn').length;
  els.replayEmpty.classList.add('hidden');
  els.replayHeader.classList.remove('hidden');
  els.replayLogList.classList.remove('hidden');
  els.replayAppName.textContent    = session.appName || 'Unknown App';
  els.replayDate.textContent       = formatFullDate(session.startedAt);
  els.replayStatTotal.textContent  = `${logs.length} ${logs.length === 1 ? 'entry' : 'entries'}`;
  els.replayStatErrors.textContent = `${errors} ${errors === 1 ? 'error' : 'errors'}`;
  els.replayStatWarns.textContent  = `${warns} ${warns === 1 ? 'warning' : 'warnings'}`;
  els.replayLogList.innerHTML = '';
  logs.forEach((entry) => appendLogEntry(entry, '', els.replayLogList));
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderLogs() {
  els.logList.innerHTML = '';
  getFilteredLogs().forEach((entry) => appendLogEntry(entry, state.search, els.logList));
  updateStats(); updateEmptyState();
  if (state.autoScroll) scrollToBottom();
}

function getFilteredLogs() {
  return state.logs.filter((entry) => {
    if (!entryMatchesFilter(entry)) return false;
    if (state.search) {
      const text = `${entry.source || 'app'} ${argsToString(entry.args)}`.toLowerCase();
      if (!text.includes(state.search.toLowerCase())) return false;
    }
    return true;
  });
}

function entryMatchesFilter(entry) {
  if (state.filter === 'all') return true;
  return entry.level === state.filter;
}

function appendLogEntry(entry, highlight = '', container = els.logList) {
  const el = document.createElement('div');

  // ── Metro-ready highlight ──────────────────────────────────────────────
  const isMetroReady = entry.metroReady === true || entry.id === state.metroReadyLogId;
  el.className = `log-entry level-${entry.level}${isMetroReady ? ' metro-ready-line' : ''}`;
  el.dataset.id = entry.id;
  el.setAttribute('role', 'listitem');

  const raw    = argsToString(entry.args);
  const text   = stripAnsi(raw);
  const displayText = highlight ? highlightText(text, highlight) : escapeHtml(text);
  const source = entry.source || 'app';
  const sourceLabel = source === 'metro' ? 'METRO' : source === 'system' ? 'SYS' : 'APP';
  const repeatBadge = (entry.repeatCount && entry.repeatCount > 1)
    ? `<span class="log-repeat-badge">×${entry.repeatCount}</span>` : '';

  // For metro-ready lines add a small "● Live" pill
  const readyPill = isMetroReady
    ? `<span class="metro-ready-pill">● Live</span>` : '';

  el.innerHTML = `
    <span class="log-timestamp">${formatTime(entry.timestamp)}</span>
    <span class="log-source source-${source}">${sourceLabel}</span>
    <span class="log-level-icon">${levelIcon(entry.level)}</span>
    <span class="log-body">${displayText}</span>
    ${readyPill}
    ${repeatBadge}
    <button class="log-copy" title="Copy" data-text="${escapeAttr(text)}">
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="4" y="4" width="7" height="7" rx="1"/>
        <path d="M1 8V2a1 1 0 011-1h6" stroke-linecap="round"/>
      </svg>
    </button>
  `;

  el.querySelector('.log-copy').addEventListener('click', (e) => {
    e.stopPropagation();
    copyText(e.currentTarget.dataset.text);
  });

  container.appendChild(el);
}

function updateStats() {
  const total    = state.logs.length;
  const errors   = state.logs.filter((l) => l.level === 'error').length;
  const warns    = state.logs.filter((l) => l.level === 'warn').length;
  const filtered = getFilteredLogs().length;
  const isFiltered = state.filter !== 'all' || state.search;
  els.statTotal.textContent  = `${total} ${total === 1 ? 'entry' : 'entries'}`;
  els.statErrors.textContent = `${errors} ${errors === 1 ? 'error' : 'errors'}`;
  els.statWarns.textContent  = `${warns} ${warns === 1 ? 'warning' : 'warnings'}`;
  els.filteredNote.classList.toggle('hidden', !isFiltered || filtered === total);
}

function updateEmptyState() {
  els.emptyState.classList.toggle('hidden', state.logs.length > 0);
}

// ── Status ─────────────────────────────────────────────────────────────────

function setStatus(s, label) {
  els.statusDot.className = `dot ${s}`;
  els.statusLabel.textContent = label;
}

// ── Export ─────────────────────────────────────────────────────────────────

function exportLogs(format) {
  const logs = getFilteredLogs();
  let content, filename, mime;
  if (format === 'json') {
    content  = JSON.stringify(logs.map((l) => ({
      timestamp: new Date(l.timestamp).toISOString(),
      level: l.level, source: l.source || 'app',
      message: stripAnsi(argsToString(l.args)),
      ...(l.repeatCount > 1 ? { repeatCount: l.repeatCount } : {}),
    })), null, 2);
    filename = `rni-logs-${dateStamp()}.json`; mime = 'application/json';
  } else {
    content  = logs.map((l) => {
      const msg    = stripAnsi(argsToString(l.args));
      const repeat = l.repeatCount > 1 ? ` (×${l.repeatCount})` : '';
      return `[${new Date(l.timestamp).toISOString()}] [${(l.source || 'app').toUpperCase()}] [${l.level.toUpperCase()}] ${msg}${repeat}`;
    }).join('\n');
    filename = `rni-logs-${dateStamp()}.txt`; mime = 'text/plain';
  }
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  els.exportMenu.classList.add('hidden');
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
}

function argsToString(args) {
  if (!args || args.length === 0) return '';
  return args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }).join(' ');
}

function formatTime(ts) {
  const d  = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatSessionTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatFullDate(ts) {
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start, end) {
  const ms = (end || Date.now()) - start;
  const s  = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
}

function levelIcon(level) {
  const icons = { log: '›', warn: '⚠', error: '✕', info: 'ℹ' };
  return icons[level] || '›';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function highlightText(text, query) {
  const escaped = escapeHtml(text);
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(`(${escapedQuery})`, 'gi'), '<mark>$1</mark>');
}

function groupSessionsByDate(sessions) {
  const today     = startOfDay(new Date());
  const yesterday = new Date(today - 86400000);
  const lastWeek  = new Date(today - 7 * 86400000);
  const groups = [
    { label: 'Today', items: [] }, { label: 'Yesterday', items: [] },
    { label: 'Last Week', items: [] }, { label: 'Older', items: [] },
  ];
  sessions.forEach((s) => {
    const d = new Date(s.startedAt);
    if (d >= today)          groups[0].items.push(s);
    else if (d >= yesterday) groups[1].items.push(s);
    else if (d >= lastWeek)  groups[2].items.push(s);
    else                     groups[3].items.push(s);
  });
  return groups.filter((g) => g.items.length > 0);
}

function startOfDay(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0); return d;
}

let suppressScrollCheck = false;
function scrollToBottom() {
  suppressScrollCheck = true;
  els.logList.scrollTop = els.logList.scrollHeight;
  requestAnimationFrame(() => { suppressScrollCheck = false; });
}

let toastTimer = null;
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    els.copyToast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.copyToast.classList.add('hidden'), 2000);
  });
}

// ── Start ──────────────────────────────────────────────────────────────────
init();