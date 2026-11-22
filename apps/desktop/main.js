/**
 * Vaporzr desktop panel — a thin Electron shell around the web control panel.
 *
 * There is deliberately no panel code in here. The window loads the live
 * `/panel` page, so a panel change ships the moment the bot is deployed and
 * this app never has to be rebuilt to pick it up. What the shell adds is what a
 * browser tab does not give you: a real window with a taskbar/Start-menu entry,
 * remembered size and zoom, and a reload that works even when the page's own
 * controls are the thing that misbehaved (the audio fix is a panel button, but
 * a wedged page needs the menu).
 *
 * Load order matters: the login cookie lives in the persistent Electron
 * session, so an access key is entered once and survives restarts.
 */
import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Default target; override with VAPORZR_URL or `--url=`. */
const DEFAULT_URL = 'https://www.vaporzr.app/panel';

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function normalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return DEFAULT_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // A bare host is more useful as the panel than as a 404 on the site root.
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/panel';
    return url.toString();
  } catch {
    return DEFAULT_URL;
  }
}

const target = normalizeUrl(process.env.VAPORZR_URL || argValue('--url'));
const targetOrigin = new URL(target).origin;

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* a read-only profile is not worth crashing the app over */
  }
}

/** Keep a restored window on a display that still exists. */
function clampToDisplay(bounds) {
  const { width, height } = bounds;
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') {
    return { width, height };
  }
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(a.x + a.width, bounds.x + width) - Math.max(a.x, bounds.x);
    const overlapY = Math.min(a.y + a.height, bounds.y + height) - Math.max(a.y, bounds.y);
    return overlapX > 120 && overlapY > 120;
  });
  return visible ? bounds : { width, height };
}

let win = null;

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const bounds = maximized || win.isFullScreen() ? readState() : win.getBounds();
  writeState({
    ...bounds,
    maximized,
    zoom: win.webContents.getZoomFactor(),
  });
}

function showShellError(reason) {
  if (!win || win.isDestroyed()) return;
  console.warn(`[desktop] panel unreachable: ${target} — ${reason}`);
  win.loadFile(path.join(here, 'error.html'));
}

function buildMenu() {
  const reload = () => win?.webContents.reloadIgnoringCache();
  const template = [
    {
      label: 'Vaporzr',
      submenu: [
        {
          label: 'Reload panel',
          accelerator: 'CmdOrCtrl+R',
          click: reload,
        },
        {
          label: 'Reload (ignore cache)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: reload,
        },
        { type: 'separator' },
        {
          label: 'Toggle developer tools',
          accelerator: 'F12',
          click: () => win?.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom in',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => zoomBy(0.1),
        },
        {
          label: 'Zoom out',
          accelerator: 'CmdOrCtrl+-',
          click: () => zoomBy(-0.1),
        },
        {
          label: 'Reset zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => setZoom(1),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open panel in browser',
          click: () => void shell.openExternal(target),
        },
        {
          label: 'About Vaporzr',
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About Vaporzr',
              message: `Vaporzr desktop ${app.getVersion()}`,
              detail: `Panel: ${target}\nElectron ${process.versions.electron}\n\nUnsigned beta build.`,
              buttons: ['OK'],
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setZoom(factor) {
  if (!win || win.isDestroyed()) return;
  const clamped = Math.min(3, Math.max(0.5, Math.round(factor * 100) / 100));
  win.webContents.setZoomFactor(clamped);
  writeState({ zoom: clamped });
}

function zoomBy(delta) {
  setZoom((win?.webContents.getZoomFactor() ?? 1) + delta);
}

function createWindow() {
  const saved = readState();
  const bounds = clampToDisplay({
    width: saved.width ?? 1280,
    height: saved.height ?? 860,
    x: saved.x,
    y: saved.y,
  });

  win = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 480,
    title: 'Vaporzr',
    backgroundColor: '#0b1026',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      // The panel is untrusted-ish web content: it gets no Node, no preload,
      // and its own sandbox. Everything it needs is already an HTTP endpoint.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  if (saved.zoom && saved.zoom !== 1) win.webContents.setZoomFactor(saved.zoom);
  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => win?.show());

  win.webContents.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED: a new navigation replaced this one, not a real failure.
    if (!isMainFrame || code === -3) return;
    console.warn(`[desktop] load failed for ${failedUrl}: ${description} (${code})`);
    showShellError(`${description} (${code})`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn(`[desktop] renderer gone: ${details.reason}`);
    if (details.reason !== 'clean-exit') {
      dialog
        .showMessageBox(win, {
          type: 'warning',
          title: 'Vaporzr',
          message: 'The panel stopped responding.',
          detail: 'Reload the window to reconnect.',
          buttons: ['Reload', 'Close'],
        })
        .then(({ response }) => {
          if (response === 0) win?.webContents.reload();
        });
    }
  });

  // The error page carries no page data at all: its two buttons are fixed
  // `vaporzr-panel://` links, and the real target is substituted here. That
  // keeps a URL the page could tamper with out of every navigation sink.
  win.webContents.on('will-navigate', (event, url) => {
    if (url === 'vaporzr-panel://retry') {
      event.preventDefault();
      void win.loadURL(target).catch((err) => {
        showShellError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    if (url === 'vaporzr-panel://browser') {
      event.preventDefault();
      void shell.openExternal(target);
      return;
    }
    if (new URL(url).origin === targetOrigin) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  for (const evt of ['resize', 'move', 'maximize', 'unmaximize']) {
    win.on(evt, saveBounds);
  }
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
  });

  void win.loadURL(target).catch((err) => {
    console.warn(`[desktop] initial load failed: ${err instanceof Error ? err.message : err}`);
    showShellError(err instanceof Error ? err.message : String(err));
  });

  return win;
}

// A second launch focuses the running window instead of opening a duplicate
// panel that would fight the first one for the now-playing card.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // The panel plays short notification sounds; do not require a click first.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
