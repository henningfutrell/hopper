// Issue #741: an ssh target's herdr client and the herdr server it talks to, as the probe reads them. A client
// whose protocol the server does not take fails every job start there, so the probe names it: the machine then
// takes no new job, and Machines shows the versions.
import { describe, expect, it } from 'vitest';
import { herdrMismatch, readHerdrStatus } from '../../src/machines/herdr-version.ts';

const SERVER = 'status: running\nversion: 0.9.3\nprotocol: 22\ncompatible: yes\nsocket: /x/herdr.sock\n';
const CLIENT = 'version: 0.9.3\nchannel: stable\nprotocol: 22\nbinary: /home/u/.local/bin/herdr\n';
const OLD_CLIENT = 'version: 0.7.5\nchannel: stable\nprotocol: 17\nbinary: /usr/local/bin/herdr\n';

describe('readHerdrStatus', () => {
  it('a client the server takes: both versions, no herdr problem', () => {
    expect(readHerdrStatus(SERVER, CLIENT)).toEqual({
      running: true,
      versions: { client: { version: '0.9.3', protocol: 22, binary: '/home/u/.local/bin/herdr' }, server: { version: '0.9.3', protocol: 22 } },
    });
  });

  it('the server says the client is not compatible: a herdr problem with both versions and the client binary', () => {
    const r = readHerdrStatus(SERVER.replace('compatible: yes', 'compatible: no'), OLD_CLIENT);
    expect(r.running).toBe(true);
    expect(r.herdrProblem).toBe('its herdr client 0.7.5 (protocol 17, /usr/local/bin/herdr) is not compatible with its herdr server 0.9.3 (protocol 22): install the server\'s herdr there');
  });

  it('no compatible line: a client protocol older than the server\'s is a herdr problem', () => {
    const r = readHerdrStatus(SERVER.replace('compatible: yes\n', ''), OLD_CLIENT);
    expect(r.herdrProblem).toMatch(/^its herdr client 0\.7\.5 \(protocol 17, \/usr\/local\/bin\/herdr\) is not compatible with its herdr server 0\.9\.3 \(protocol 22\)/);
  });

  it('a server not running: not running, no versions read from it', () => {
    expect(readHerdrStatus('status: not running\nsocket: /x/herdr.sock\n')).toEqual({ running: false, versions: {} });
  });

  it('a client that cannot say its own status: the server\'s versions only', () => {
    expect(readHerdrStatus(SERVER)).toEqual({ running: true, versions: { server: { version: '0.9.3', protocol: 22 } } });
  });
});

describe('herdrMismatch', () => {
  it('herdr\'s own protocol error: a herdr problem with both protocols', () => {
    expect(herdrMismatch('herdr: client protocol 17 is older than server protocol 22')).toBe(
      'its herdr client (protocol 17) is not compatible with its herdr server (protocol 22): install the server\'s herdr there');
  });

  it('any other error: none', () => {
    expect(herdrMismatch('ssh laptop: connection refused')).toBeUndefined();
  });
});
