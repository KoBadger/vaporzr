import { describe, expect, it } from 'vitest';
import {
  isGroupChat,
  mentionsBot,
  parseCommand,
  provesOpenChat,
  routeText,
  stripBotMention,
  type IncomingText,
} from '../privacy.js';

const BOT = 'VaporzrBot';

function input(partial: Partial<IncomingText>): IncomingText {
  return { chatType: 'group', replyToBot: false, botUsername: BOT, ...partial };
}

describe('parseCommand', () => {
  it('splits a bare command and its arguments', () => {
    expect(parseCommand('/play daft punk', BOT)).toEqual({ command: 'play', args: 'daft punk' });
    expect(parseCommand('/queue', BOT)).toEqual({ command: 'queue', args: '' });
  });

  it('accepts a command addressed to this bot, case-insensitively', () => {
    expect(parseCommand('/play@vaporzrbot around the world', BOT)).toEqual({
      command: 'play',
      args: 'around the world',
    });
  });

  it('rejects a command addressed to another bot in the same group', () => {
    expect(parseCommand('/play@otherbot x', BOT)).toEqual({ otherBot: true });
  });

  it('is not fooled by text that merely starts with a slash', () => {
    expect(parseCommand('play x', BOT)).toBeNull();
    expect(parseCommand('/ bad', BOT)).toBeNull();
    expect(parseCommand('/no-dashes', BOT)).toBeNull();
  });

  it('keeps multi-line arguments intact', () => {
    expect(parseCommand('/play one\ntwo', BOT)).toEqual({ command: 'play', args: 'one\ntwo' });
  });
});

describe('stripBotMention', () => {
  it('removes a leading mention', () => {
    expect(stripBotMention('@VaporzrBot get lucky', BOT)).toBe('get lucky');
  });

  it('removes an inline mention and collapses the gap', () => {
    expect(stripBotMention('play   get lucky @vaporzrbot', BOT)).toBe('play get lucky');
  });

  it('leaves the text alone when the bot is unknown', () => {
    expect(stripBotMention('hello', '')).toBe('hello');
  });
});

describe('routeText', () => {
  it('treats any text in a private chat as a request', () => {
    expect(routeText(input({ chatType: 'private', text: 'daft punk' }))).toEqual({
      kind: 'request',
      text: 'daft punk',
    });
  });

  it('routes commands before anything else, in every chat type', () => {
    expect(routeText(input({ text: '/skip' }))).toEqual({ kind: 'command', command: 'skip', args: '' });
  });

  it('ignores commands aimed at another bot instead of answering them', () => {
    expect(routeText(input({ text: '/play@otherbot x' }))).toEqual({ kind: 'ignore', why: 'other-bot' });
  });

  it('accepts a reply to the bot under privacy mode', () => {
    expect(routeText(input({ text: 'get lucky', replyToBot: true }))).toEqual({
      kind: 'request',
      text: 'get lucky',
    });
  });

  it('accepts an @mention and strips it', () => {
    expect(routeText(input({ text: '@VaporzrBot get lucky' }))).toEqual({ kind: 'request', text: 'get lucky' });
  });

  it('drops unaddressed group text (privacy mode delivery rule)', () => {
    expect(routeText(input({ text: 'get lucky' }))).toEqual({ kind: 'ignore', why: 'privacy' });
  });

  it('ignores empty text and channel posts', () => {
    expect(routeText(input({ text: '   ' }))).toEqual({ kind: 'ignore', why: 'empty' });
    expect(routeText(input({ chatType: 'channel', text: 'song' }))).toEqual({ kind: 'ignore', why: 'channel' });
  });
});

describe('provesOpenChat', () => {
  it('is only true for an unaddressed group message', () => {
    expect(provesOpenChat(input({ text: 'just typing' }))).toBe(true);
    expect(provesOpenChat(input({ text: '/play x' }))).toBe(false);
    expect(provesOpenChat(input({ text: '@VaporzrBot x' }))).toBe(false);
    expect(provesOpenChat(input({ text: 'x', replyToBot: true }))).toBe(false);
  });

  it('never claims a private chat or a channel is "open"', () => {
    expect(provesOpenChat(input({ chatType: 'private', text: 'x' }))).toBe(false);
    expect(provesOpenChat(input({ chatType: 'channel', text: 'x' }))).toBe(false);
  });
});

describe('small helpers', () => {
  it('classifies group chats', () => {
    expect(isGroupChat('group')).toBe(true);
    expect(isGroupChat('supergroup')).toBe(true);
    expect(isGroupChat('private')).toBe(false);
  });

  it('finds a mention case-insensitively and rejects an empty username', () => {
    expect(mentionsBot('hey @vaporzrbot', BOT)).toBe(true);
    expect(mentionsBot('hey', BOT)).toBe(false);
    expect(mentionsBot('hey @vaporzrbot', '')).toBe(false);
  });
});
