// Issue #741: the herdr the hopper owns on an ssh target. The hopper installs its own herdr at a versioned path there
// and calls it; when the session server runs another protocol, the hopper restarts the server from that path, but only
// when nothing there can be lost, never when the server is a container's main process, and once per version.
import { describe, expect, it } from 'vitest';
import { decideHerdrSwitch, herdrVersionOf, ownedHerdrPath, readOwnedFacts, type SwitchFacts } from '../../src/machines/herdr-owned.ts';

const IDLE: SwitchFacts = { version: '0.9.3', busy: false, panes: 0, container: false, server: { pid: 4242, ppid: 900 }, tried: false };

describe('decideHerdrSwitch', () => {
  it('no job, no pane, not a container\'s main process, not tried: switch', () => {
    expect(decideHerdrSwitch(IDLE)).toEqual({ switch: true });
  });

  it('a job runs there: no switch, it waits', () => {
    expect(decideHerdrSwitch({ ...IDLE, busy: true })).toEqual({ switch: false, why: 'a job runs there: its session server moves to herdr 0.9.3 once none does' });
  });

  it('panes are open in its session: no switch', () => {
    expect(decideHerdrSwitch({ ...IDLE, panes: 2 })).toEqual({ switch: false, why: '2 panes are open in its herdr session: its session server moves to herdr 0.9.3 once none is' });
  });

  it('its panes could not be counted: no switch', () => {
    const { panes: _, ...unknown } = IDLE;
    expect(decideHerdrSwitch(unknown)).toEqual({ switch: false, why: 'its herdr session\'s panes could not be counted: its session server stays as it is' });
  });

  it('the server is the container\'s main process (PID 1): never a switch; the image must change', () => {
    expect(decideHerdrSwitch({ ...IDLE, container: true, server: { pid: 1, ppid: 0 } })).toEqual({
      switch: false, why: 'its herdr session server is the container\'s main process: update the herdr its image puts in place to 0.9.3',
    });
  });

  it('the server\'s parent is the container\'s init: never a switch', () => {
    expect(decideHerdrSwitch({ ...IDLE, container: true, server: { pid: 31, ppid: 1 } })).toMatchObject({ switch: false, why: expect.stringContaining('container\'s main process') });
  });

  it('in a container, a server started by another process is switched', () => {
    expect(decideHerdrSwitch({ ...IDLE, container: true, server: { pid: 31, ppid: 12 } })).toEqual({ switch: true });
  });

  it('in a container, a server whose process is not found: no switch', () => {
    const { server: _, ...unseen } = IDLE;
    expect(decideHerdrSwitch({ ...unseen, container: true })).toMatchObject({ switch: false, why: expect.stringContaining('its herdr session server process was not found') });
  });

  it('on a host, a server whose process is not found is switched: herdr stops it itself', () => {
    const { server: _, ...unseen } = IDLE;
    expect(decideHerdrSwitch(unseen)).toEqual({ switch: true });
  });

  it('tried once for this version: never again, whatever else holds', () => {
    expect(decideHerdrSwitch({ ...IDLE, tried: true })).toEqual({
      switch: false, why: `its session server was moved to herdr 0.9.3 once and does not run it: restart it there with ~/${ownedHerdrPath('0.9.3')}`,
    });
    expect(decideHerdrSwitch({ ...IDLE, tried: true, busy: true })).toMatchObject({ why: expect.stringContaining('once') });
  });
});

describe('readOwnedFacts', () => {
  it('reads the platform, the install, the attempt, the container and the server process', () => {
    const out = 'noise\nhopper-herdr-platform Linux x86_64\nhopper-herdr-installed\nhopper-herdr-tried\nhopper-herdr-container\nhopper-herdr-panes 3\nhopper-herdr-server 1 0\n';
    expect(readOwnedFacts(out)).toEqual({ platform: 'Linux x86_64', installed: true, tried: true, container: true, panes: 3, server: { pid: 1, ppid: 0 } });
  });

  it('nothing said: not installed, not tried, no container, no server, panes unknown', () => {
    expect(readOwnedFacts('hopper-herdr-platform Linux aarch64\n')).toEqual({ platform: 'Linux aarch64', installed: false, tried: false, container: false });
  });
});

describe('herdrVersionOf', () => {
  it('reads herdr --version', () => {
    expect(herdrVersionOf('herdr 0.9.3\n')).toBe('0.9.3');
  });

  it('anything else is no version: it would not be a safe path', () => {
    expect(herdrVersionOf('herdr ../../x')).toBeUndefined();
    expect(herdrVersionOf('')).toBeUndefined();
  });
});
