// Issue #741: Machines shows an ssh target's herdr client and herdr server versions, so a client older than its
// server is seen before a job fails on it.
import { describe, expect, it } from 'vitest';
import { herdrText } from '../../ui/src/model/machines.ts';

describe('the herdr versions on Machines', () => {
  const base = { id: 'seat', label: 'seat', maxLanes: 1, online: true, executors: [], ssh: 'agent@seat' };

  it('client and server, each with its protocol, and the binary the hopper calls', () => {
    expect(herdrText({ ...base, herdr: { session: 'hopper', client: { version: '0.7.5', protocol: 17, binary: '/usr/local/bin/herdr' }, server: { version: '0.9.3', protocol: 22 } } }))
      .toBe('client 0.7.5 (protocol 17, /usr/local/bin/herdr), server 0.9.3 (protocol 22)');
  });

  it('only what the probe read', () => {
    expect(herdrText({ ...base, herdr: { session: 'hopper', server: { version: '0.9.3', protocol: 22 } } })).toBe('server 0.9.3 (protocol 22)');
  });

  it('none read, or no herdr: null', () => {
    expect(herdrText({ ...base, herdr: { session: 'hopper' } })).toBeNull();
    expect(herdrText(base)).toBeNull();
  });
});
