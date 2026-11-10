import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientIp, isLoopbackAddress } from '../clientIp.js';
import { isTailnetAddress } from '../access.js';

/** Minimal request stand-in: clientIp only reads the socket and two headers. */
function req(socket: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress: socket }, headers } as unknown as IncomingMessage;
}

describe('clientIp (tunnel-aware address)', () => {
  it('uses the socket address for a direct connection, ignoring headers', () => {
    // A remote client must not be able to name someone else's bucket.
    const r = req('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' });
    expect(clientIp(r)).toBe('203.0.113.9');
  });

  it('prefers CF-Connecting-IP when the socket is the local tunnel', () => {
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('falls back to the first X-Forwarded-For hop', () => {
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe('198.51.100.7');
  });

  it('ignores header values that are not addresses', () => {
    expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': 'evil.example' }))).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': '' }))).toBe('127.0.0.1');
  });

  it('treats the IPv4-mapped loopback form as loopback', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('100.101.1.2')).toBe(false);
  });
});

describe('isTailnetAddress (WEB_ACCESS=tailnet socket check)', () => {
  it('accepts the CGNAT range Tailscale uses', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.101.5.6')).toBe(true);
    expect(isTailnetAddress('100.127.255.254')).toBe(true);
  });

  it('rejects public addresses just outside it', () => {
    expect(isTailnetAddress('100.63.255.255')).toBe(false);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('192.168.1.5')).toBe(false);
    expect(isTailnetAddress('203.0.113.9')).toBe(false);
  });

  it('accepts Tailscale ULA and its IPv4-mapped form', () => {
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailnetAddress('::ffff:100.101.1.2')).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isTailnetAddress('')).toBe(false);
    expect(isTailnetAddress(undefined)).toBe(false);
    expect(isTailnetAddress('not-an-ip')).toBe(false);
  });
});
