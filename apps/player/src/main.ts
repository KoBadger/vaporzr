import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import path from 'node:path';

const www = path.join(__dirname, '..');

const BOT_PORT = Number(process.env.VAPORZR_PORT ?? 4876);
const SHOW_PLAYER = process.env.VAPORZR_SHOW_PLAYER === '1';
const VISUALIZER = process.env.VAPORZR_VISUALIZER !== '0';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let playerWindow: BrowserWindow | null = null;
let visualizerWindow: BrowserWindow | null = null;

function createPlayerWindow(): void {
  playerWindow = new BrowserWindow({
    width: 480,
    height: 360,
    show: SHOW_PLAYER,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  playerWindow.loadFile(path.join(www, 'player.html'), { query: { port: String(BOT_PORT) } });
  if (SHOW_PLAYER) playerWindow.webContents.openDevTools({ mode: 'detach' });
  playerWindow.on('closed', () => {
    playerWindow = null;
  });
}

function createVisualizerWindow(): void {
  visualizerWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#05060f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  visualizerWindow.loadFile(path.join(www, 'visualizer.html'), { query: { port: String(BOT_PORT) } });
  visualizerWindow.on('closed', () => {
    visualizerWindow = null;
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
  createPlayerWindow();
  if (VISUALIZER) createVisualizerWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPlayerWindow();
      if (VISUALIZER) createVisualizerWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

export { BOT_PORT };
