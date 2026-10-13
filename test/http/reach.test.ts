// Who may ask what (design.md "Reaching the UI across the LAN"): a request is local or LAN by its
// peer address and Host, and a LAN request needs a UI session for every /api/ route.
import { describe, expect, it } from 'vitest';
import { classifyRequest, lanHosts, publicHosts, publicOriginOf, type Lan } from '../../src/http/reach.ts';

const PORT = 4790;
const lan: Lan = { names: ['server', '192.0.2.29'], peers: ['192.0.2.0/24', '100.64.0.0/10'] };
const off: Lan = { names: [], peers: [] };

describe('classifyRequest', () => {
  it('a loopback peer naming 127.0.0.1 or localhost with the port is local', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LOCALHOST:${PORT}`]) {
        expect(classifyRequest({ host, peer }, PORT, lan), `${peer} ${host}`).toEqual({ reach: 'local' });
        expect(classifyRequest({ host, peer }, PORT, off), `${peer} ${host}`).toEqual({ reach: 'local' });
      }
    }
  });

  it('a LAN name with the port is a LAN request, from a listed peer or from loopback', () => {
    for (const peer of ['192.0.2.7', '::ffff:192.0.2.7', '100.64.0.7', '127.0.0.1']) {
      for (const host of [`server:${PORT}`, `SERVER:${PORT}`, `192.0.2.29:${PORT}`]) {
        expect(classifyRequest({ host, peer }, PORT, lan), `${peer} ${host}`).toEqual({ reach: 'lan' });
      }
    }
  });

  it('a peer outside loopback and the LAN peers is refused 403, whatever Host it names', () => {
    for (const peer of ['198.51.100.5', '10.0.0.1', '::ffff:198.51.100.2', '2001:db8::1', undefined]) {
      const r = classifyRequest({ host: `server:${PORT}`, peer }, PORT, lan);
      expect(r, String(peer)).toMatchObject({ refuse: 403 });
    }
    expect(classifyRequest({ host: `server:${PORT}`, peer: '192.0.2.7' }, PORT, off)).toMatchObject({ refuse: 403 });
  });

  // A port a container publishes on its host's loopback (compose.yaml, issue #119) arrives from the
  // container network with the loopback Host the browser used: a LAN request, never a local one.
  it('a LAN peer naming a loopback Host with the port is a LAN request, not a local one', () => {
    expect(classifyRequest({ host: `127.0.0.1:${PORT}`, peer: '192.0.2.7' }, PORT, lan)).toEqual({ reach: 'lan' });
    expect(classifyRequest({ host: `localhost:${PORT}`, peer: '192.0.2.7' }, PORT, lan)).toEqual({ reach: 'lan' });
    expect(classifyRequest({ host: '127.0.0.1:4800', peer: '192.0.2.7' }, PORT, lan)).toMatchObject({ refuse: 421 });
  });

  it('any other Host is 421 (DNS rebinding), as before', () => {
    for (const host of ['evil.example', `evil.example:${PORT}`, 'server', `server:${PORT + 1}`, `server.evil.example:${PORT}`, '127.0.0.1', '']) {
      expect(classifyRequest({ host, peer: '127.0.0.1' }, PORT, lan), host).toMatchObject({ refuse: 421 });
    }
    expect(classifyRequest({ host: `server:${PORT}`, peer: '127.0.0.1' }, PORT, off)).toMatchObject({ refuse: 421 });
  });
});

// Remote access (issue #880): the tunnel's domain is set in the UI, so the Host guard reads it at each request. While
// remote access is on, its host is a public request's Host; off, it is any other name: 421.
describe('the remote access domain', () => {
  let url: string | undefined;
  const tunnel = { names: [], peers: ['10.0.0.0/8'], tunnelUrl: () => url };

  it('is a public request\'s Host from a LAN peer while remote access is on, and 421 once it is off', () => {
    url = 'https://h.example.ngrok.app';
    expect(classifyRequest({ host: 'h.example.ngrok.app', peer: '10.89.1.2' }, PORT, tunnel)).toEqual({ reach: 'public' });
    expect(publicHosts(tunnel)).toEqual(['h.example.ngrok.app']);
    expect(publicOriginOf(tunnel, 'H.example.ngrok.app')).toBe('https://h.example.ngrok.app');
    url = undefined;
    expect(classifyRequest({ host: 'h.example.ngrok.app', peer: '10.89.1.2' }, PORT, tunnel)).toMatchObject({ refuse: 421 });
    expect(publicOriginOf(tunnel, 'h.example.ngrok.app')).toBeUndefined();
  });

  it('stands beside the public URL: each is a public request\'s Host, and each its own origin', () => {
    url = 'https://h.example.ngrok.app';
    const both = { ...tunnel, publicUrl: 'https://hopper.example.com' };
    expect(publicHosts(both)).toEqual(['hopper.example.com', 'h.example.ngrok.app']);
    expect(publicOriginOf(both, 'hopper.example.com')).toBe('https://hopper.example.com');
    expect(classifyRequest({ host: 'hopper.example.com', peer: '10.89.1.2' }, PORT, both)).toEqual({ reach: 'public' });
  });
});

// A tailnet (issue #1024): the names and addresses this host has on its tailnet, found at runtime, and the hosts the
// admin allowed are LAN names, read at each request; while this host is on a tailnet, a peer in its ranges is a LAN peer.
describe('more LAN names and the tailnet', () => {
  let names: string[] = [];
  let on = false;
  const tailnet: Lan = { names: ['hopper'], peers: ['10.0.0.0/8'], moreNames: () => names, tailnet: () => on };

  it('a name read at the request is a LAN Host with the port, and 421 once it is gone', () => {
    names = ['box.example.ts.net', '100.101.102.103', 'fd7a:115c:a1e0::1'];
    for (const host of [`box.example.ts.net:${PORT}`, `BOX.example.ts.net:${PORT}`, `100.101.102.103:${PORT}`, `[fd7a:115c:a1e0::1]:${PORT}`]) {
      expect(classifyRequest({ host, peer: '10.89.0.4' }, PORT, tailnet), host).toEqual({ reach: 'lan' });
      expect(classifyRequest({ host, peer: '127.0.0.1' }, PORT, tailnet), host).toEqual({ reach: 'lan' });
    }
    expect(lanHosts(PORT, tailnet)).toEqual([`hopper:${PORT}`, `box.example.ts.net:${PORT}`, `100.101.102.103:${PORT}`, `[fd7a:115c:a1e0::1]:${PORT}`]);
    expect(classifyRequest({ host: 'box.example.ts.net', peer: '10.89.0.4' }, PORT, tailnet)).toMatchObject({ refuse: 421 });
    names = [];
    expect(classifyRequest({ host: `box.example.ts.net:${PORT}`, peer: '10.89.0.4' }, PORT, tailnet)).toMatchObject({ refuse: 421 });
  });

  it('a peer in the tailnet ranges is a LAN peer only while this host is on a tailnet', () => {
    names = ['box.example.ts.net'];
    on = false;
    for (const peer of ['100.100.1.2', 'fd7a:115c:a1e0::9']) expect(classifyRequest({ host: `box.example.ts.net:${PORT}`, peer }, PORT, tailnet), peer).toMatchObject({ refuse: 403 });
    on = true;
    for (const peer of ['100.100.1.2', '::ffff:100.100.1.2', 'fd7a:115c:a1e0::9']) expect(classifyRequest({ host: `box.example.ts.net:${PORT}`, peer }, PORT, tailnet), peer).toEqual({ reach: 'lan' });
    expect(classifyRequest({ host: `box.example.ts.net:${PORT}`, peer: '198.51.100.5' }, PORT, tailnet)).toMatchObject({ refuse: 403 });
    expect(classifyRequest({ host: `evil.example:${PORT}`, peer: '100.100.1.2' }, PORT, tailnet)).toMatchObject({ refuse: 421 });
    on = false;
  });
});
