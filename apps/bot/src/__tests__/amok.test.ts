import { describe, expect, it } from 'vitest';
import { amokSessionId, extractAmokReply, resetAmokSession } from '../amok.js';
import { V_ALIASES, V_DISPATCH_ALIASES } from '../aliases.js';

describe('Amok ("The Weasel") Discord integration', () => {
  it('registers V@weasel, V@amok, V@pauly, and V@w aliases', () => {
    expect(V_ALIASES.weasel).toBe('weasel');
    expect(V_ALIASES.amok).toBe('weasel');
    expect(V_ALIASES.pauly).toBe('weasel');
    expect(V_ALIASES.w).toBe('weasel');
    expect(V_DISPATCH_ALIASES.amok).toBe('weasel');
    expect(V_DISPATCH_ALIASES.pauly).toBe('weasel');
    expect(V_DISPATCH_ALIASES.w).toBe('weasel');
  });

  it('builds stable session IDs and rotates them on reset', () => {
    const first = amokSessionId('guild-123', 'user-456');
    const same = amokSessionId('guild-123', 'user-456');
    expect(first).toBe(same);

    resetAmokSession('guild-123', 'user-456');
    const afterReset = amokSessionId('guild-123', 'user-456');
    expect(afterReset).not.toBe(first);
  });

  it('extracts and joins text chunks from Dialogflow CX detectIntent responses', () => {
    const reply = extractAmokReply({
      queryResult: {
        responseMessages: [
          { text: { text: ["Hey buuuddy! What's shakin'?"] } },
          { text: { text: ['Keep wheezin the juice!'] } },
        ],
      },
    });
    expect(reply).toBe("Hey buuuddy! What's shakin'?\n\nKeep wheezin the juice!");
  });
});
