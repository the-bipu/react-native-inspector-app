const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rni', {
  // ── Server ────────────────────────────────────────────────────────────────
  getServerPort:      () => ipcRenderer.invoke('get:server-port'),
  getConnectedClients:() => ipcRenderer.invoke('get:connected-clients'),

  // ── Project lifecycle ─────────────────────────────────────────────────────
  selectProject:      ()      => ipcRenderer.invoke('project:select'),
  validateProject:    (dir)   => ipcRenderer.invoke('project:validate', dir),
  startProject:       (dir)   => ipcRenderer.invoke('project:start', dir),
  stopProject:        ()      => ipcRenderer.invoke('project:stop'),
  getProjectStatus:   ()      => ipcRenderer.invoke('project:status'),
  sendStdin:          (cmd)   => ipcRenderer.invoke('project:stdin', cmd),

  // ── Recent projects ───────────────────────────────────────────────────────
  listRecents:        ()        => ipcRenderer.invoke('recents:list'),
  removeRecent:       (p)       => ipcRenderer.invoke('recents:remove', p),
  renameRecent:       (p, n)    => ipcRenderer.invoke('recents:rename', p, n),

  // ── Session history ───────────────────────────────────────────────────────
  saveSession:        (s)   => ipcRenderer.invoke('session:save', s),
  listSessions:       ()    => ipcRenderer.invoke('session:list'),
  loadSession:        (id)  => ipcRenderer.invoke('session:load', id),

  // ── Preferences & theme ───────────────────────────────────────────────────
  getPrefs:           ()    => ipcRenderer.invoke('prefs:get'),
  setPrefs:           (p)   => ipcRenderer.invoke('prefs:set', p),
  getSystemTheme:     ()    => ipcRenderer.invoke('prefs:system-theme'),

  // ── Device picker ─────────────────────────────────────────────────────────
  pickerGetPresets:   ()          => ipcRenderer.invoke('picker:get-presets'),
  pickerOpen:         ()          => ipcRenderer.invoke('picker:open'),
  pickerApply:        (presetKey) => ipcRenderer.invoke('picker:apply', presetKey),
  pickerCancel:       ()          => ipcRenderer.invoke('picker:cancel'),

  // ── Device preview (webview) controls ─────────────────────────────────────
  reloadPreview:       () => ipcRenderer.invoke('preview:reload'),
  openPreviewDevtools: () => ipcRenderer.invoke('preview:open-devtools'),

  // ── Actions ───────────────────────────────────────────────────────────────
  openExternal:       (url)   => ipcRenderer.send('open:external', url),

  // ── IPC event subscriptions ───────────────────────────────────────────────
  on: (channel, callback) => {
    const allowed = [
      'ws:server-started', 'ws:server-error',
      'ws:client-connected', 'ws:client-disconnected',
      'ws:devices-updated', 'ws:raw',
      'app:info',
      'log:entry',
      'project:status',
      'recents:updated',
      'theme:system-changed',
      'metro:ready',
      'device:preset-applied',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});