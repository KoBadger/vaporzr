import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const www = path.join(__dirname, '..');
const LOGO = path.join(__dirname, '..', 'assets', 'logo.png');

const BOT_PORT = Number(process.env.VAPORZR_PORT ?? 4876);
const VISUALIZER = process.env.VAPORZR_VISUALIZER !== '0';
/** Transparent, always-on-top, click-through overlay window. */
const OVERLAY = process.env.VAPORZR_OVERLAY === '1';
/** Fullscreen "screensaver" variant of the overlay. */
const SCREENSAVER = process.env.VAPORZR_SCREENSAVER === '1';
const DEBUG = process.env.VAPORZR_DEBUG === '1';

/** Broadcast capture mode (OBS): chromeless, fixed size, no cursor, no throttling. */
const argValue = (flag: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
};
const BROADCAST = process.env.VAPORZR_BROADCAST === '1' || process.argv.includes('--broadcast');
const ALWAYS_ON_TOP = process.env.VAPORZR_ALWAYS_ON_TOP === '1' || process.argv.includes('--top');
/** Bot socket for a bot running on another machine, e.g. wss://host/ws. */
const WS_URL = process.env.VAPORZR_WS ?? argValue('--ws');
/** Share key for a keyed bot. A client that does not present it is a GUEST, and
 *  the bridge silently drops every `cmd` a guest sends — so without this the
 *  player's own play/seek/theme controls do nothing at all. Resolved from
 *  VAPORZR_KEY, --key=…, or a `.vaporzr-key` file beside the app (so it can be
 *  launched normally instead of needing an env var every time). */
const SHARE_KEY = ((): string => {
  const direct = process.env.VAPORZR_KEY ?? argValue('--key');
  if (direct) return direct;
  const file = process.env.VAPORZR_KEY_FILE ?? path.join(__dirname, '..', '..', '.vaporzr-key');
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  } catch {
    /* no key file — run as a guest, which the UI reports on its status line */
  }
  return '';
})();
/** The socket URL handed to the renderer, with the share key attached. */
const WS_TARGET = (() => {
  const base = WS_URL ?? `ws://127.0.0.1:${BOT_PORT}/ws`;
  if (!SHARE_KEY) return base;
  try {
    const u = new URL(base);
    if (!u.searchParams.has('key')) u.searchParams.set('key', SHARE_KEY);
    return u.toString();
  } catch {
    return base;
  }
})();
/** Socket URL with the key masked, so it is safe to log. */
const redactWs = (u: string): string => u.replace(/key=[^&]*/, 'key=***');
/** Broadcast window size (WxH) — keep it fixed so an OBS capture never shifts. */
const BROADCAST_SIZE = process.env.VAPORZR_SIZE ?? argValue('--size') ?? '1280x720';

// An occluded window stops painting on Windows, which freezes an OBS capture.
// Electron's backgroundThrottling:false is not enough on its own.
if (BROADCAST) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let activeWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlayPassthrough = true;

ipcMain.on('win:minimize', () => {
  activeWindow?.minimize();
});
ipcMain.on('win:close', () => {
  activeWindow?.close();
});
ipcMain.on('overlay:setPassthrough', (_event, pass: boolean) => {
  if (!overlayWindow) return;
  overlayPassthrough = Boolean(pass);
  overlayWindow.setIgnoreMouseEvents(overlayPassthrough, { forward: true });
  overlayWindow.webContents.send('overlay:passthrough', overlayPassthrough);
});
ipcMain.on('overlay:hide', () => {
  overlayWindow?.hide();
});

/** Open a link in the user's real browser. The overlay is a frameless
 *  always-on-top window: navigating it would replace the visual, and a plain
 *  target=_blank would spawn a bare Electron window instead. */
ipcMain.on('open:external', (_event, url: unknown) => {
  const s = String(url ?? '');
  if (!/^https?:\/\//i.test(s)) return; // never hand anything else to the OS
  void shell.openExternal(s);
});

/** Never let a renderer spawn an Electron window; send its links to the browser. */
function hardenLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createVisualizerWindow(): void {
  // Broadcast mode pins an exact size so an OBS Window Capture never shifts,
  // and keeps the frame off (nothing but the visual on screen).
  const [bw, bh] = BROADCAST_SIZE.split('x').map((n) => Number(n));
  const width = BROADCAST && Number.isFinite(bw) ? bw : 1280;
  const height = BROADCAST && Number.isFinite(bh) ? bh : 720;
  const win = new BrowserWindow({
    width,
    height,
    minWidth: BROADCAST ? 320 : undefined,
    frame: false,
    resizable: !BROADCAST,
    movable: !BROADCAST,
    maximizable: !BROADCAST,
    fullscreenable: !BROADCAST,
    alwaysOnTop: BROADCAST && ALWAYS_ON_TOP,
    autoHideMenuBar: true,
    backgroundColor: '#05060f',
    icon: LOGO,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      plugins: true,
    },
  });
  activeWindow = win;
  if (BROADCAST) {
    win.setMenuBarVisibility(false);
    console.log(
      `[player] broadcast mode ${width}x${height} → ${redactWs(WS_TARGET)}`,
    );
  }
  if (DEBUG) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
      }
    });
  }
  win.webContents.on('console-message', (...args: unknown[]) => {
    if (!DEBUG) return;
    console.log('[renderer-visualizer]', JSON.stringify(args).slice(0, 3000));
  });
  hardenLinks(win);
  win.loadFile(path.join(www, 'visualizer.html'), {
    query: {
      port: String(BOT_PORT),
      ...(BROADCAST ? { broadcast: '1' } : {}),
      // Always pass the resolved target so the renderer inherits the share key.
      ws: WS_TARGET,
    },
  });
  win.on('closed', () => {
    if (activeWindow === win) activeWindow = null;
  });
}

function createOverlayWindow(screensaver: boolean): void {
  const win = new BrowserWindow({
    width: screensaver ? 1280 : 640,
    height: screensaver ? 720 : 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    icon: LOGO,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      plugins: true,
    },
  });
  overlayWindow = win;
  activeWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  if (screensaver) {
    win.setFullScreen(true);
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    const bounds = win.getBounds();
    win.setPosition(wa.x + wa.width - bounds.width - 24, wa.y + wa.height - bounds.height - 24);
  }
  // Click-through by default; Ctrl+Shift+V (or the win-pass button) unlocks it.
  win.setIgnoreMouseEvents(true, { forward: true });
  hardenLinks(win);
  win.loadFile(path.join(www, 'visualizer.html'), {
    query: {
      port: String(BOT_PORT),
      overlay: '1',
      screensaver: screensaver ? '1' : '0',
      ws: WS_TARGET,
    },
  });
  win.on('closed', () => {
    if (overlayWindow === win) overlayWindow = null;
    if (activeWindow === win) activeWindow = null;
  });
}

async function enableLoopbackCapture(): Promise<void> {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const source = sources[0];
          if (source) {
            callback({ video: source, audio: 'loopback' });
          } else {
            callback({ audio: 'loopback' });
          }
        })
        .catch(() => {
          callback({ audio: 'loopback' });
        });
    },
    { useSystemPicker: false },
  );
}

app.whenReady().then(async () => {
  await enableLoopbackCapture();
  if (OVERLAY) {
    if (SCREENSAVER) {
      createOverlayWindow(true);
    } else {
      createOverlayWindow(false);
    }
    globalShortcut.register('CommandOrControl+Shift+V', () => {
      if (!overlayWindow) return;
      overlayPassthrough = !overlayPassthrough;
      overlayWindow.setIgnoreMouseEvents(overlayPassthrough, { forward: true });
      overlayWindow.webContents.send('overlay:passthrough', overlayPassthrough);
    });
    globalShortcut.register('CommandOrControl+Shift+O', () => {
      if (!overlayWindow) return;
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
      } else {
        overlayWindow.show();
      }
    });
  } else if (VISUALIZER) {
    createVisualizerWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (OVERLAY) createOverlayWindow(SCREENSAVER);
      else if (VISUALIZER) createVisualizerWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
