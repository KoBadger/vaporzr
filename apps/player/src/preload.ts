import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('vaporzr', {
  getConfig: (): { botPort: string; botHost: string } => ({
    botPort: new URLSearchParams(window.location.search).get('port') ?? '4876',
    botHost: '127.0.0.1',
  }),
});
