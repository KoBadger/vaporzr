import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

const tokensPath = () => path.join(config.dataDir, 'tokens.json');

export const tokenStore = {
  load(): StoredTokens | null {
    try {
      return JSON.parse(fs.readFileSync(tokensPath(), 'utf8')) as StoredTokens;
    } catch {
      return null;
    }
  },
  save(tokens: StoredTokens): void {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(tokensPath(), JSON.stringify(tokens, null, 2), 'utf8');
  },
};
