import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vaporzr', {
  getConfig: (): { botPort: string; botHost: string } => ({
    botPort: new URLSearchParams(window.location.search).get('port') ?? '4876',
    botHost: '127.0.0.1',
  }),
  minimizeWindow: (): void => ipcRenderer.send('win:minimize'),
  closeWindow: (): void => ipcRenderer.send('win:close'),
  /** Overlay: toggle click-through passthrough (true = mouse goes through the window). */
  setOverlayPassthrough: (pass: boolean): void => ipcRenderer.send('overlay:setPassthrough', pass),
  /** Overlay: hide the window (bring it back with Ctrl+Shift+O). */
  hideOverlay: (): void => ipcRenderer.send('overlay:hide'),
  onOverlayPassthrough: (cb: (pass: boolean) => void): void => {
    ipcRenderer.on('overlay:passthrough', (_event, pass: boolean) => cb(pass));
  },
});
