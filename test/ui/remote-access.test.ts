// Remote access in the UI (ui/src/model/remote-access.ts, issues #880, #968), pure: the status in one line, a credential's
// line, the change a save sends — only what differs, the credential only when one is typed and has its provider's shape —
// and the copy-out panel's lines.
import { describe, expect, it } from 'vitest';
import { copyOut, credentialLine, draftOf, remoteAccessSave, remoteAccessStatusLine } from '../../ui/src/model/remote-access.ts';
import type { RemoteAccessView } from '../../ui/src/model/wire.ts';

const URL_ = 'https://hopper.example.com';
const V: RemoteAccessView = {
  enabled: true, provider: 'cloudflare', url: URL_, credentials: {}, service: true, status: { state: 'up', url: URL_ },
  links: { url: URL_, api: `${URL_}/api/`, apiToken: `${URL_}/ui/auth/api-token`, tokenRefresh: `${URL_}/ui/auth/token/refresh` },
};

describe('the remote access model', () => {
  it('says in one line where the tunnel is', () => {
    expect(remoteAccessStatusLine(V)).toBe(`Up: agents reach the hopper's API at ${URL_}`);
    expect(remoteAccessStatusLine({ ...V, enabled: false, status: { state: 'off' } })).toBe('Off: the hopper is not reached from the internet');
    expect(remoteAccessStatusLine({ ...V, status: { state: 'down', error: 'cloudflared has no connection' } })).toBe('Down: cloudflared has no connection');
    expect(remoteAccessStatusLine({ ...V, status: { state: 'down' } })).toBe('Down: the tunnel is starting');
    expect(remoteAccessStatusLine({ ...V, status: { state: 'no-service', error: 'the cloudflared service has not asked' } })).toBe('No tunnel service: the cloudflared service has not asked');
  });

  it('names a kept credential by its provider, never its value', () => {
    expect(credentialLine('cloudflare', undefined)).toBe('No Cloudflare Tunnel API token kept.');
    expect(credentialLine('ngrok', { setBy: 'ada', setAt: '2026-10-12T10:00:00.000Z', last4: 'wxyz' })).toMatch(/^ngrok API key kept: ends in wxyz, set by ada, /);
  });

  it('offers Cloudflare first when no provider is picked', () => {
    expect(draftOf({})).toEqual({ provider: 'cloudflare', credential: '', domain: '' });
    expect(draftOf({ provider: 'ngrok', domain: 'h.ngrok.app' })).toEqual({ provider: 'ngrok', credential: '', domain: 'h.ngrok.app' });
  });

  it('sends only what differs: the provider, a credential typed, the host name; empty lets the hopper pick one', () => {
    expect(remoteAccessSave(V, { provider: 'cloudflare', credential: '', domain: '' })).toEqual({ ok: true, change: undefined });
    expect(remoteAccessSave({}, { provider: 'cloudflare', credential: ` ${'c'.repeat(40)} `, domain: ' h.example.com ' })).toEqual({ ok: true, change: { provider: 'cloudflare', credential: 'c'.repeat(40), domain: 'h.example.com' } });
    expect(remoteAccessSave({ provider: 'cloudflare', domain: 'h.example.com' }, { provider: 'ngrok', credential: 'n'.repeat(30), domain: '' })).toEqual({ ok: true, change: { provider: 'ngrok', credential: 'n'.repeat(30), domain: null } });
  });

  it('refuses a credential not of its provider\'s shape and a host name that is none', () => {
    expect(remoteAccessSave(V, { provider: 'cloudflare', credential: 'short', domain: '' })).toEqual({ ok: false, error: 'API token: that is no Cloudflare Tunnel API token' });
    expect(remoteAccessSave(V, { provider: 'ngrok', credential: `${'n'.repeat(30)}-x`, domain: '' }).ok).toBe(false);
    expect(remoteAccessSave(V, { provider: 'cloudflare', credential: '', domain: 'not a domain' })).toEqual({ ok: false, error: 'Host name: a host name, such as hopper.example.com, or empty to let the hopper pick one' });
  });

  it('copies out the public URL and the URLs an agent calls, only while on', () => {
    expect(copyOut(V)).toEqual([
      { label: 'Public URL', value: URL_ }, { label: 'API', value: `${URL_}/api/` },
      { label: 'API-token exchange', value: `${URL_}/ui/auth/api-token` }, { label: 'Token refresh', value: `${URL_}/ui/auth/token/refresh` },
    ]);
    expect(copyOut({})).toEqual([]);
  });
});
