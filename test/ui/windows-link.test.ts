// The Windows link in the UI (issue #712): what a machine card says of it, the fix for the networking mode found, and
// the machines the banner names — each WSL machine whose client found that Windows does not reach the hopper. Pure.
import { describe, expect, it } from 'vitest';
import type { WindowsLink } from '../../src/domain/types.ts';
import { brokenWindowsLinks, windowsLinkFix, windowsLinkText } from '../../ui/src/model/windows-link.ts';

const URL_ = 'http://localhost:4790/job/address';
const broken = (mode?: string): WindowsLink => ({ url: URL_, ...(mode ? { mode } : {}), ok: false, error: 'Unable to connect to the remote server', at: '2026-10-13T10:00:00.000Z' });

describe('the Windows link in the UI', () => {
  it('a card says whether Windows reaches the hopper, and in which mode', () => {
    expect(windowsLinkText({ url: URL_, mode: 'nat', ok: true, status: 200, at: '2026-10-13T10:00:00.000Z' })).toBe('Windows reaches it at localhost:4790 (NAT mode)');
    expect(windowsLinkText(broken('mirrored'))).toBe('Windows does not reach it at localhost:4790 (mirrored mode): Unable to connect to the remote server');
    expect(windowsLinkText(broken())).toBe('Windows does not reach it at localhost:4790: Unable to connect to the remote server');
  });

  it('only 127.0.0.1 answered: the card says so, and to open 127.0.0.1, as Windows tries ::1 first for localhost', () => {
    expect(windowsLinkText({ url: 'http://127.0.0.1:4790/job/address', mode: 'nat', ok: true, status: 204, at: '2026-10-13T10:00:00.000Z' }))
      .toBe('Windows reaches it at 127.0.0.1:4790 only, not at localhost (NAT mode). Windows tries ::1 first for localhost: open http://127.0.0.1:4790');
  });

  it('NAT mode: localhost forwarding first, then mirrored networking; always wsl --shutdown after', () => {
    const fix = windowsLinkFix(broken('nat'));
    expect(fix[0]).toContain('localhostForwarding=true');
    expect(fix[1]).toContain('networkingMode=mirrored');
    expect(fix[1]).toContain('http://127.0.0.1:4790');
    expect(fix.at(-1)).toContain('wsl --shutdown');
  });

  it('mirrored mode: open 127.0.0.1; never mirrored networking, which is on already', () => {
    const fix = windowsLinkFix(broken('mirrored'));
    expect(fix[0]).toContain('http://127.0.0.1:4790');
    expect(fix.join(' ')).not.toContain('networkingMode=mirrored');
    expect(fix.at(-1)).toContain('wsl --shutdown');
  });

  it('no mode read: both fixes, localhost forwarding and mirrored networking, or open 127.0.0.1; always wsl --shutdown after', () => {
    const fix = windowsLinkFix(broken());
    const text = fix.join(' ');
    expect(text).toContain('localhostForwarding=true');
    expect(text).toContain('networkingMode=mirrored');
    expect(text).toContain('http://127.0.0.1:4790');
    expect(fix.at(-1)).toContain('wsl --shutdown');
  });

  it('the banner names each online machine with a broken link, and no other', () => {
    const ok: WindowsLink = { url: URL_, ok: true, status: 204, at: '2026-10-13T10:00:00.000Z' };
    const m = (id: string, online: boolean, windowsLink?: WindowsLink) => ({ id, label: id.toUpperCase(), online, resources: { cores: 1, memTotalBytes: 1, memAvailableBytes: 1, ...(windowsLink ? { windowsLink } : {}) } });
    expect(brokenWindowsLinks([m('a', true, broken('nat')), m('b', true, ok), m('c', false, broken('nat')), m('d', true)]))
      .toEqual([{ id: 'a', name: 'A', link: broken('nat') }]);
  });

  it('the banner names a broken link the keep-alive loop on Windows reported, after the machines', () => {
    const ok: WindowsLink = { url: URL_, ok: true, status: 401, at: '2026-10-13T10:00:00.000Z' };
    const m = { id: 'a', label: 'A', online: true, resources: { cores: 1, memTotalBytes: 1, memAvailableBytes: 1, windowsLink: broken('nat') } };
    expect(brokenWindowsLinks([m], broken('mirrored'))).toEqual([
      { id: 'a', name: 'A', link: broken('nat') },
      { id: 'windows', name: 'Windows (the keep-alive loop)', link: broken('mirrored') },
    ]);
    expect(brokenWindowsLinks([], ok)).toEqual([]);
    expect(brokenWindowsLinks([], undefined)).toEqual([]);
  });
});
