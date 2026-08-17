const { app, BrowserWindow, ipcMain, Menu, shell, nativeTheme, dialog, screen, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const WebSocket = require('ws');

if (!app.isPackaged) {
  try {
    require('electron-reload')(__dirname, {
      electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
    });
  } catch (e) {}
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const RECENTS_FILE = path.join(app.getPath('userData'), 'recent-projects.json');
const PREFS_FILE   = path.join(app.getPath('userData'), 'prefs.json');
const SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions');
const MAX_RECENTS  = 20;

// ─── Device presets ───────────────────────────────────────────────────────────
// These are the logical CSS pixel sizes used for the device preview window's
// content area (the <webview> that loads the running project).

const DEVICE_PRESETS = {
  iphone15pro:   { label: 'iPhone 15 Pro',   w: 393,  h: 852  },
  pixel8:        { label: 'Pixel 8',          w: 412,  h: 915  },
  ipadpro11:     { label: 'iPad Pro 11"',     w: 834,  h: 1194 },
  galaxytab:     { label: 'Galaxy Tab S9',    w: 800,  h: 1280 },
  responsive:    { label: 'Responsive',       w: null, h: null },
};

// ─── Session storage ──────────────────────────────────────────────────────────

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function saveSession(session) {
  try {
    ensureSessionsDir();
    fs.writeFileSync(
      path.join(SESSIONS_DIR, `session-${session.id}.json`),
      JSON.stringify(session, null, 2),
      'utf8'
    );
  } catch (e) {
    console.error('[RNI] Failed to save session:', e.message);
  }
}

function listSessions() {
  try {
    ensureSessionsDir();
    return fs.readdirSync(SESSIONS_DIR)
      .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          return {
            id: s.id,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            appName: s.appName,
            platform: s.platform,
            logCount: (s.logs || []).length,
            errorCount: (s.logs || []).filter((l) => l.level === 'error').length,
            warnCount:  (s.logs || []).filter((l) => l.level === 'warn').length,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch (e) {
    return [];
  }
}

function loadSession(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `session-${id}.json`), 'utf8'));
  } catch (e) { return null; }
}

// ─── Recent projects ──────────────────────────────────────────────────────────

function loadRecents() {
  try {
    const raw = fs.readFileSync(RECENTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function saveRecents(recents) {
  try {
    fs.writeFileSync(RECENTS_FILE, JSON.stringify(recents, null, 2), 'utf-8');
  } catch (e) {}
}

function upsertRecent(entry) {
  const recents = loadRecents();
  const idx = recents.findIndex((r) => r.path === entry.path);
  let merged = entry;
  if (idx !== -1) {
    merged = { ...recents[idx], ...entry };
    recents.splice(idx, 1);
  }
  recents.unshift(merged);
  const trimmed = recents.slice(0, MAX_RECENTS);
  saveRecents(trimmed);
  return trimmed;
}

// ─── Preferences ──────────────────────────────────────────────────────────────

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); }
  catch { return { theme: 'system' }; }
}

function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf8'); }
  catch (e) {}
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow    = null;
let pickerWindow  = null;   // the device-picker dialog
let previewWindow = null;   // the device preview window (webview of the running project)

const PREVIEW_HEADER_H = 42;   // header bar height inside the preview window
const PREVIEW_MIN_W    = 320;
const PREVIEW_MIN_H    = 480;

// ── Fit-to-screen helper ─────────────────────────────────────────────────
// Clamps a requested window size so it always fits within the current
// display's usable work area (i.e. excluding the OS taskbar/menu bar/dock),
// leaving a small margin so the window never butts right up against the
// screen edges. This is what stops tall device presets (iPad, tablets, etc.)
// from spawning a window taller than the laptop's actual screen.
const SCREEN_FIT_MARGIN = 40; // px kept clear around the window

function fitToScreen(reqW, reqH) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    || screen.getPrimaryDisplay();
  const work = display.workAreaSize;
  return {
    width:  Math.min(reqW, Math.max(work.width  - SCREEN_FIT_MARGIN, 320)),
    height: Math.min(reqH, Math.max(work.height - SCREEN_FIT_MARGIN, 240)),
  };
}

// Returns the usable work area (excludes taskbar/menu bar/dock) of the
// display closest to the cursor, falling back to the primary display.
function getWorkArea() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    || screen.getPrimaryDisplay();
  return display.workAreaSize;
}

// Web-view (Responsive) sizing — matches desktop-go's "just open it" behavior:
// no guessed fixed pixel size, the window opens straight away sized to a
// percentage of the laptop's actual screen height instead.
const WEB_VIEW_HEIGHT_PCT = 0.92; // within the 90–95% target range
const WEB_VIEW_WIDTH_PCT  = 0.78;

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function sendToPicker(channel, data) {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.webContents.send(channel, data);
  }
}

// Finds the guest <webview>'s WebContents living inside the device preview
// window — this is the actual page showing the running project, as opposed
// to previewWindow.webContents which is just the chrome around it (header,
// placeholder, etc). Reload/debugger commands need to act on this guest.
function getPreviewWebviewContents() {
  if (!previewWindow || previewWindow.isDestroyed()) return null;
  const hostId = previewWindow.webContents.id;
  return webContents.getAllWebContents().find((wc) => {
    if (wc.isDestroyed() || wc.getType() !== 'webview') return false;
    const host = wc.hostWebContents;
    return host && !host.isDestroyed() && host.id === hostId;
  }) || null;
}

// Resolves the theme actually in effect right now ('light' | 'dark'),
// following the same rule as the renderer: explicit pref wins, otherwise
// fall back to the OS theme.
function resolveTheme() {
  const prefs = loadPrefs();
  if (prefs.theme === 'light') return 'light';
  if (prefs.theme === 'dark') return 'dark';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// Opens the device-picker BrowserWindow (modal-like, no taskbar entry)
function createPickerWindow() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.focus();
    return;
  }

  const theme = resolveTheme();
  const bg = theme === 'light' ? '#f4f4f6' : '#0d0d0f';
  const { width: pickerW, height: pickerH } = fitToScreen(520, 560);

  pickerWindow = new BrowserWindow({
    width:           pickerW,
    height:          pickerH,
    resizable:       false,
    center:          true,
    backgroundColor: bg,
    frame:           false,
    titleBarStyle:   'hidden',
    skipTaskbar:     true,
    alwaysOnTop:     true,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    show: false,
  });

  // Pass the currently-resolved theme in as a query param so the picker
  // renders in the right theme from the very first paint instead of
  // defaulting to dark.
  pickerWindow.loadFile('picker.html', { query: { theme } });
  pickerWindow.once('ready-to-show', () => pickerWindow.show());
  pickerWindow.on('closed', () => { pickerWindow = null; });
}

// Opens (or replaces) the device preview window: a separate window, sized to
// the chosen device's pixel dimensions, that loads a <webview> pointed at the
// project's dev server. The main app window is left untouched.
function createDevicePreviewWindow(presetKey) {
  const preset = DEVICE_PRESETS[presetKey];
  if (!preset) return;

  // Replace any existing preview window rather than stacking multiple.
  // NOTE: don't null out `previewWindow` here and let the old window's own
  // 'closed' handler do it later — that handler closes over this same
  // mutable variable, so if it fires *after* we've already assigned the
  // new window below, it wipes out the reference to the window we just
  // created. That's what caused "Cannot read properties of null (reading
  // 'show')" when switching devices quickly: the new window's own
  // 'ready-to-show' fired after the old window's stale 'closed' handler
  // had already nulled the shared variable out from under it.
  const staleWindow = previewWindow;
  if (staleWindow && !staleWindow.isDestroyed()) {
    staleWindow.removeAllListeners('closed');
    staleWindow.close();
  }
  previewWindow = null;

  const theme = resolveTheme();
  const bg = theme === 'light' ? '#f4f4f6' : '#0d0d0f';
  const responsive = preset.w === null;

  let rawW, rawH;
  if (responsive) {
    // Web view: open directly like desktop-go does — no hardcoded guess,
    // just take a percentage of the laptop's real screen size so it
    // always opens using most of the available height (90-95%), not a
    // fixed number that under-uses a big screen or overflows a small one.
    const work = getWorkArea();
    rawW = Math.round(work.width * WEB_VIEW_WIDTH_PCT);
    rawH = Math.round(work.height * WEB_VIEW_HEIGHT_PCT) + PREVIEW_HEADER_H;
  } else {
    rawW = preset.w;
    rawH = preset.h + PREVIEW_HEADER_H;
  }
  // Clamp the OUTER window to the screen — the webview inside still gets
  // the device's true pixel size (set via query.w/h below) and will simply
  // scroll if it's taller/wider than the clamped window.
  const { width: winW, height: winH } = fitToScreen(rawW, rawH);

  const win = new BrowserWindow({
    width:            winW,
    height:           winH,
    minWidth:         responsive ? PREVIEW_MIN_W : winW,
    minHeight:        responsive ? PREVIEW_MIN_H : winH,
    useContentSize:   true,
    resizable:        responsive,
    center:           true,
    backgroundColor:  bg,
    frame:            false,
    titleBarStyle:    'hidden',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       true, // required for the <webview> element used to preview the app
    },
    show: false,
  });
  previewWindow = win;

  const query = {
    theme,
    responsive: String(responsive),
    label: preset.label,
    headerH: String(PREVIEW_HEADER_H),
  };
  if (!responsive) {
    query.w = String(preset.w);
    query.h = String(preset.h);
  }
  if (lastMetroPort) query.url = `http://localhost:${lastMetroPort}`;

  win.loadFile('device-preview.html', { query });
  // Guard with an identity check: by the time these fire, `previewWindow`
  // may already point at a *newer* window (user picked another device
  // again before this one finished loading) — in that case this window
  // has already been superseded/closed, so leave the shared variable alone.
  win.once('ready-to-show', () => {
    if (previewWindow === win) win.show();
  });
  win.on('closed', () => {
    if (previewWindow === win) previewWindow = null;
  });

  // Let the main window know so it can show a small "previewing X" badge.
  if (responsive) {
    sendToWindow('device:preset-applied', { presetKey, responsive: true });
  } else {
    sendToWindow('device:preset-applied', {
      presetKey, responsive: false, deviceW: preset.w, deviceH: preset.h, label: preset.label,
    });
  }
}

function createWindow() {
  const { width, height } = fitToScreen(1280, 820);
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth:        Math.min(860, width),
    minHeight:       Math.min(580, height),
    backgroundColor: '#0d0d0f',
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame:           process.platform !== 'darwin',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  Menu.setApplicationMenu(null);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

let wss = null;
let connectedClients = new Map();
let clientIdCounter = 0;
const WS_PORT = 8097;

const LOG_DEDUP_WINDOW_MS = 100;
const recentLogKeys = new Map();

function isDuplicateLog(level, args) {
  const key = `${level}|${JSON.stringify(args)}`;
  const now = Date.now();
  const last = recentLogKeys.get(key);
  if (last && now - last < LOG_DEDUP_WINDOW_MS) return true;
  recentLogKeys.set(key, now);
  if (recentLogKeys.size > 500) {
    const cutoff = now - LOG_DEDUP_WINDOW_MS * 20;
    for (const [k, t] of recentLogKeys) if (t < cutoff) recentLogKeys.delete(k);
  }
  return false;
}

function buildDeviceList() {
  return Array.from(connectedClients.entries()).map(([id, c]) => ({
    clientId: id,
    ip: c.ip,
    clientKey: c.clientKey,
    connectedAt: c.connectedAt,
    appName: c.appInfo?.appName || null,
    platform: c.appInfo?.platform || null,
    bundleId: c.appInfo?.bundleId || null,
  }));
}

function handleClientMessage(clientId, msg) {
  const client = connectedClients.get(clientId);
  if (!client) return;
  if (msg.type === 'rni:log') {
    const level = msg.payload.level || 'log';
    const args  = msg.payload.args  || [];
    if (isDuplicateLog(level, args)) return;
    sendToWindow('log:entry', {
      clientId,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      level, args,
      source: 'app',
      timestamp: msg.payload.timestamp || Date.now(),
    });
  } else {
    sendToWindow('ws:raw', { clientId, msg });
  }
}

function startWebSocketServer() {
  wss = new WebSocket.Server({ port: WS_PORT }, () => {
    sendToWindow('ws:server-started', { port: WS_PORT });
  });

  wss.on('error', (err) => sendToWindow('ws:server-error', { message: err.message }));

  wss.on('connection', (ws, req) => {
    const clientId = ++clientIdCounter;
    const ip = req.socket.remoteAddress;

    let handshakeTimer = setTimeout(() => {
      if (!connectedClients.has(clientId)) ws.terminate();
    }, 2000);

    ws.once('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { ws.terminate(); return; }
      if (msg.type !== 'rni:app-info') { ws.terminate(); return; }
      clearTimeout(handshakeTimer);

      const clientKey = msg.payload?.clientKey || ip;
      for (const [oldId, oldClient] of connectedClients.entries()) {
        if (oldClient.clientKey === clientKey) {
          oldClient.suppressDisconnect = true;
          oldClient.ws.terminate();
          connectedClients.delete(oldId);
        }
      }

      connectedClients.set(clientId, {
        ws, appInfo: msg.payload, ip, clientKey,
        connectedAt: Date.now(), suppressDisconnect: false,
      });

      sendToWindow('ws:client-connected', { clientId, ip, connectedCount: connectedClients.size });
      sendToWindow('app:info', { clientId, ...msg.payload });
      sendToWindow('ws:devices-updated', buildDeviceList());

      ws.on('message', (raw2) => {
        try { handleClientMessage(clientId, JSON.parse(raw2.toString())); }
        catch (e) {}
      });
    });

    ws.on('close', () => {
      const client = connectedClients.get(clientId);
      if (client?.suppressDisconnect) { connectedClients.delete(clientId); return; }
      connectedClients.delete(clientId);
      sendToWindow('ws:client-disconnected', { clientId, connectedCount: connectedClients.size });
      sendToWindow('ws:devices-updated', buildDeviceList());
    });

    ws.on('error', (err) => console.error(`[RNI] Client #${clientId} error:`, err.message));
  });
}

// ─── Managed project runner ───────────────────────────────────────────────────

let projectProcess  = null;
let projectPath     = null;
let projectCommand  = null;
let projectOutputBuffer = { stdout: '', stderr: '' };
let lastMetroPort   = null;
// Tracks whether we've already auto-opened the device picker for the
// current run, so it only pops up once per "Start" rather than every time
// a matching log line appears.
let autoPickerShownForRun = false;

function getPackageManager(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock')))      return 'yarn';
  return 'npm';
}

function detectProjectCommand(dir) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}

  const pm   = getPackageManager(dir);
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  let isExpo = 'expo' in deps;
  if (!isExpo) {
    try {
      const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
      if (appJson.expo) isExpo = true;
    } catch {}
  }

  if (pkg.scripts?.start) {
    if (pm === 'yarn') return { command: 'yarn',     args: ['start'], label: 'yarn start' };
    if (pm === 'pnpm') return { command: 'pnpm',     args: ['start'], label: 'pnpm start' };
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['start'], label: 'npm start' };
  }
  if (isExpo)                return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['expo', 'start'], label: 'npx expo start' };
  if ('react-native' in deps) return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['react-native', 'start'], label: 'npx react-native start' };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['start'], label: 'npm start' };
}

function detectProjectInfo(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return { valid: false, reason: 'No package.json found.' };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); }
  catch { return { valid: false, reason: 'package.json could not be read.' }; }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let isExpo = 'expo' in deps;
  if (!isExpo) {
    try {
      const appJson = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf-8'));
      if (appJson.expo) isExpo = true;
    } catch {}
  }

  const isRN = 'react-native' in deps;
  if (!isExpo && !isRN) return { valid: false, reason: "This doesn't look like a React Native or Expo project." };

  const detected = detectProjectCommand(dir);
  return {
    valid: true,
    name: pkg.name || path.basename(dir),
    type: isExpo ? 'Expo' : 'React Native',
    startCmd: detected.label,
  };
}

function emitProjectStatus(status, extra = {}) {
  sendToWindow('project:status', { status, projectPath, command: projectCommand, ...extra });
}

// ── Metro "ready" line detector ────────────────────────────────────────────
// Fires 'metro:ready' with the port when Metro says "Waiting on …:PORT"
const METRO_PORT_RE = /waiting on.*?:(\d+)/i;

function emitProjectOutput(source, chunk) {
  const key = source === 'stderr' ? 'stderr' : 'stdout';
  projectOutputBuffer[key] += chunk.toString();
  const parts = projectOutputBuffer[key].split(/\r?\n/);
  projectOutputBuffer[key] = parts.pop() || '';

  for (const line of parts) {
    if (!line && source === 'stdout') continue;
    const clean = line.replace(/\r/g, '');
    let level = 'log';
    if (/\b(warn|warning)\b/i.test(clean))                                   level = 'warn';
    if (/\b(error|failed|failure|exception|uncaught)\b/i.test(clean))        level = 'error';

    // Detect Metro ready line
    const portMatch = clean.match(METRO_PORT_RE);
    const isMetroReady = Boolean(portMatch);

    sendToWindow('log:entry', {
      id: `process-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      level,
      source: 'metro',
      stream: source,
      args: [clean],
      timestamp: Date.now(),
      metroReady: isMetroReady,
      metroPort: portMatch ? portMatch[1] : null,
    });

    if (isMetroReady) {
      lastMetroPort = portMatch[1];
      sendToWindow('metro:ready', { port: portMatch[1], line: clean });

      // The dev server is now actually listening on localhost — this is
      // the moment to prompt the user to pick a device/window size.
      if (!autoPickerShownForRun) {
        autoPickerShownForRun = true;
        createPickerWindow();
      }
    }
  }
}

function stopProjectProcess() {
  if (!projectProcess || projectProcess.killed) {
    projectProcess = null;
    emitProjectStatus('stopped');
    return;
  }
  const pid = projectProcess.pid;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else {
    projectProcess.kill('SIGTERM');
  }
  projectProcess = null;
  emitProjectStatus('stopped');
}

function startProjectProcess(dir) {
  if (projectProcess) stopProjectProcess();

  const detected = detectProjectCommand(dir);
  projectPath    = dir;
  projectCommand = detected.label;
  projectOutputBuffer = { stdout: '', stderr: '' };
  autoPickerShownForRun = false; // allow the picker to auto-open again for this new run
  lastMetroPort = null;

  emitProjectStatus('starting', { command: detected.label });
  sendToWindow('log:entry', {
    id: `process-start-${Date.now()}`,
    level: 'info', source: 'system',
    args: [`▶ Starting: ${detected.label}`, `Directory: ${dir}`],
    timestamp: Date.now(),
  });

  const child = spawn(detected.command, detected.args, {
    cwd: dir,
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: false,
    windowsHide: true,
  });
  projectProcess = child;

  child.stdout.on('data', (data) => emitProjectOutput('stdout', data));
  child.stderr.on('data', (data) => emitProjectOutput('stderr', data));
  child.on('spawn', () => emitProjectStatus('running', { pid: child.pid }));

  child.on('error', (err) => {
    sendToWindow('log:entry', {
      id: `process-error-${Date.now()}`,
      level: 'error', source: 'system',
      args: [`Could not start project: ${err.message}`],
      timestamp: Date.now(),
    });
    emitProjectStatus('error', { message: err.message });
    projectProcess = null;
  });

  child.on('close', (code, signal) => {
    if (projectProcess === child) projectProcess = null;
    for (const stream of ['stdout', 'stderr']) {
      if (projectOutputBuffer[stream]) emitProjectOutput(stream, '\n');
    }
    emitProjectStatus('exited', { code, signal });
    sendToWindow('log:entry', {
      id: `process-exit-${Date.now()}`,
      level: code === 0 ? 'info' : 'error',
      source: 'system',
      args: [`Project process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`],
      timestamp: Date.now(),
    });
  });
}

function sendStdinCommand(cmd) {
  if (!projectProcess || projectProcess.killed) return false;
  try {
    projectProcess.stdin.write(cmd);
    return true;
  } catch (e) {
    console.error('[RNI] Failed to write stdin:', e.message);
    return false;
  }
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('get:server-port', () => WS_PORT);
ipcMain.handle('get:connected-clients', () => buildDeviceList());

ipcMain.on('open:external', (_, url) => shell.openExternal(url));

// ── Device picker ──────────────────────────────────────────────────────────
ipcMain.handle('picker:get-presets', () => DEVICE_PRESETS);

ipcMain.handle('picker:open', () => {
  createPickerWindow();
  return true;
});

ipcMain.handle('picker:apply', (_, presetKey) => {
  createDevicePreviewWindow(presetKey);
  // Close picker window after applying
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
  return true;
});

ipcMain.handle('picker:cancel', () => {
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
  return true;
});

// ── Device preview (webview) controls ────────────────────────────────────
// These act directly on the running app's webview inside the preview
// window, since the managed project process isn't attached to a real TTY
// and its own interactive 'r'/'j' keypress commands generally can't reach
// it — this is what actually reloads the app / opens a debuggable console.
ipcMain.handle('preview:reload', () => {
  const wc = getPreviewWebviewContents();
  if (!wc) return false;
  wc.reload();
  return true;
});

ipcMain.handle('preview:open-devtools', () => {
  const wc = getPreviewWebviewContents();
  if (!wc) return false;
  if (wc.isDevToolsOpened()) {
    wc.devToolsWebContents && wc.devToolsWebContents.focus();
  } else {
    wc.openDevTools({ mode: 'detach' });
  }
  return true;
});

// Project
ipcMain.handle('project:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select React Native / Expo project',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const dir = result.filePaths[0];
  const info = detectProjectInfo(dir);
  return { path: dir, command: detectProjectCommand(dir).label, valid: info.valid, ...info };
});

ipcMain.handle('project:validate', (_, dir) => detectProjectInfo(dir));

ipcMain.handle('project:start', (_, dir) => {
  if (!dir || !fs.existsSync(dir)) throw new Error('Project directory does not exist.');
  startProjectProcess(dir);
  const info = detectProjectInfo(dir);
  const recents = upsertRecent({
    path: dir,
    name: info.name || path.basename(dir),
    type: info.type || '',
    command: detectProjectCommand(dir).label,
    lastRunAt: Date.now(),
  });
  sendToWindow('recents:updated', recents);
  return { path: dir, command: projectCommand };
});

ipcMain.handle('project:stop', () => {
  stopProjectProcess();
  return true;
});

ipcMain.handle('project:status', () => ({
  running: Boolean(projectProcess),
  path: projectPath,
  command: projectCommand,
  pid: projectProcess?.pid || null,
}));

ipcMain.handle('project:stdin', (_, cmd) => {
  return sendStdinCommand(cmd);
});

// Recents
ipcMain.handle('recents:list', () => loadRecents());

ipcMain.handle('recents:remove', (_, folderPath) => {
  if (projectPath === folderPath && projectProcess) {
    return { ok: false, reason: 'Project is currently running.' };
  }
  const recents = loadRecents().filter((r) => r.path !== folderPath);
  saveRecents(recents);
  return { ok: true, recents };
});

ipcMain.handle('recents:rename', (_, folderPath, newName) => {
  const recents = loadRecents();
  const entry = recents.find((r) => r.path === folderPath);
  if (!entry) return { ok: false, reason: 'Project not found.' };
  entry.name = newName;
  saveRecents(recents);
  return { ok: true, recents };
});

// Sessions
ipcMain.handle('session:save', (_, session) => { saveSession(session); return true; });
ipcMain.handle('session:list', () => listSessions());
ipcMain.handle('session:load', (_, id) => loadSession(id));

// Prefs / theme
ipcMain.handle('prefs:get', () => loadPrefs());
ipcMain.handle('prefs:set', (_, prefs) => {
  savePrefs(prefs);
  nativeTheme.themeSource = prefs.theme === 'light' ? 'light' : prefs.theme === 'dark' ? 'dark' : 'system';
  // Keep an already-open picker window in sync with a manual theme change.
  sendToPicker('theme:system-changed', { isDark: resolveTheme() === 'dark' });
  return true;
});
ipcMain.handle('prefs:system-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
nativeTheme.on('updated', () => {
  sendToWindow('theme:system-changed', { isDark: nativeTheme.shouldUseDarkColors });
  sendToPicker('theme:system-changed', { isDark: nativeTheme.shouldUseDarkColors });
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const prefs = loadPrefs();
  nativeTheme.themeSource = prefs.theme === 'light' ? 'light' : prefs.theme === 'dark' ? 'dark' : 'system';
  createWindow();
  startWebSocketServer();
});

app.on('window-all-closed', () => {
  stopProjectProcess();
  if (wss) wss.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});