import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } from 'electron';
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
      `[player] broadcast mode ${width}x${height} → ${WS_URL ?? `ws://127.0.0.1:${BOT_PORT}/ws`}`,
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
  win.loadFile(path.join(www, 'visualizer.html'), {
    query: {
      port: String(BOT_PORT),
      ...(BROADCAST ? { broadcast: '1' } : {}),
      ...(WS_URL ? { ws: WS_URL } : {}),
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
  win.loadFile(path.join(www, 'visualizer.html'), {
    query: { port: String(BOT_PORT), overlay: '1', screensaver: screensaver ? '1' : '0' },
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
