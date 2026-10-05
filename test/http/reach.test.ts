// Who may ask what (design.md "Reaching the UI across the LAN"): a request is local or LAN by its
// peer address and Host, and a LAN request needs a UI session for every /api/ route.
import { describe, expect, it } from 'vitest';
import { classifyRequest, type Lan } from '../../src/http/reach.ts';

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
