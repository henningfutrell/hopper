// Remote access in the UI (ui/src/model/remote-access.ts, issue #880), pure: the status in one line, the authtoken's line,
// and the change a save sends — only what differs, the token only when one is typed, refused when the domain is no domain.
import { describe, expect, it } from 'vitest';
import { authtokenLine, remoteAccessSave, remoteAccessStatusLine } from '../../ui/src/model/remote-access.ts';
import type { RemoteAccessView } from '../../ui/src/model/wire.ts';

const V: RemoteAccessView = { enabled: true, domain: 'h.example.ngrok.app', url: 'https://h.example.ngrok.app', service: true, status: { state: 'up', url: 'https://h.example.ngrok.app' } };

describe('the remote access model', () => {
  it('says in one line where the tunnel is', () => {
    expect(remoteAccessStatusLine(V)).toBe('Up: agents reach the hopper\'s API at https://h.example.ngrok.app');
    expect(remoteAccessStatusLine({ ...V, enabled: false, status: { state: 'off' } })).toBe('Off: the hopper is not reached from the internet');
    expect(remoteAccessStatusLine({ ...V, status: { state: 'down', error: 'ngrok refused the authtoken' } })).toBe('Down: ngrok refused the authtoken');
    expect(remoteAccessStatusLine({ ...V, status: { state: 'down' } })).toBe('Down: the tunnel is starting');
    expect(remoteAccessStatusLine({ ...V, status: { state: 'no-service', error: 'the tunnel service has not asked' } })).toBe('No tunnel service: the tunnel service has not asked');
  });

  it('says whether an authtoken is kept, never its value', () => {
    expect(authtokenLine(V)).toBe('No authtoken kept.');
    expect(authtokenLine({ ...V, authtoken: { setBy: 'admin', setAt: '2026-10-12T10:00:00.000Z', last4: 'wxyz' } })).toMatch(/^Kept: ends in wxyz, set by admin, /);
  });

  it('a save sends only what differs, and the token only when one is typed', () => {
    expect(remoteAccessSave(V, { domain: 'h.example.ngrok.app', authtoken: '' })).toEqual({ ok: true, change: undefined });
    expect(remoteAccessSave(V, { domain: ' new.ngrok.app ', authtoken: '  tok_123  ' })).toEqual({ ok: true, change: { domain: 'new.ngrok.app', authtoken: 'tok_123' } });
    expect(remoteAccessSave({ ...V, domain: undefined }, { domain: '', authtoken: '' })).toEqual({ ok: true, change: undefined });
  });

  it('refuses a domain with a space or a path, and never sends an empty domain', () => {
    expect(remoteAccessSave(V, { domain: 'not a domain', authtoken: '' })).toEqual({ ok: false, error: 'Domain: the domain reserved at ngrok, such as hopper.example.ngrok.app' });
    expect(remoteAccessSave(V, { domain: 'h.example/path', authtoken: '' }).ok).toBe(false);
    expect(remoteAccessSave(V, { domain: '', authtoken: '' })).toEqual({ ok: false, error: 'Domain: the domain reserved at ngrok, such as hopper.example.ngrok.app' });
  });
});
