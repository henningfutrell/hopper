// Issue #695: the hopper's URL a job is given (HOPPER_URL: hopper-gh, git, hopper-skill, hopper-artifact, the job
// stream) is one the job's machine reaches. A client target's jobs go through its client door, on loopback there, so they
// need no name resolved; an ssh or container target gets the link base, the public URL, or an address before a bare name.
import { describe, expect, it } from 'vitest';
import { jobHopperUrl } from '../../src/github-proxy/reach.ts';

const HOPPER = { linkBase: '', lanNames: [] as string[], port: 4790 };
const ssh = { ssh: 'fleet' };
const client = (door?: string) => ({ client: { ...(door ? { door } : {}) } });

describe('the hopper\'s URL a job is given (issue #695)', () => {
  it('this machine: loopback', () => {
    expect(jobHopperUrl({ ...HOPPER, lanNames: ['hopper'], machine: {} })).toBe('http://127.0.0.1:4790');
  });

  it('a client target: its client door, never the name it dialled in at', () => {
    expect(jobHopperUrl({ ...HOPPER, lanNames: ['hopper'], machine: client('http://127.0.0.1:41234'), dialled: 'http://hopper:4790' })).toBe('http://127.0.0.1:41234');
  });

  it('a client target whose client has no door yet (an older client): the URL it dialled in at, else as an ssh target', () => {
    expect(jobHopperUrl({ ...HOPPER, machine: client(), dialled: 'http://192.0.2.10:4790' })).toBe('http://192.0.2.10:4790');
    expect(jobHopperUrl({ ...HOPPER, lanNames: ['hopper', '192.0.2.10'], machine: client() })).toBe('http://192.0.2.10:4790');
  });

  it('an ssh target: the link base first, then the public URL', () => {
    expect(jobHopperUrl({ ...HOPPER, linkBase: 'http://hopper.example.local:4790', publicUrl: 'https://hopper.example.com/x', lanNames: ['hopper'], machine: ssh })).toBe('http://hopper.example.local:4790');
    expect(jobHopperUrl({ ...HOPPER, publicUrl: 'https://hopper.example.com/x', lanNames: ['hopper'], machine: ssh })).toBe('https://hopper.example.com');
  });

  it('an ssh target: an address or a .local name before a bare container name', () => {
    expect(jobHopperUrl({ ...HOPPER, lanNames: ['hopper', '192.0.2.10'], machine: ssh })).toBe('http://192.0.2.10:4790');
    expect(jobHopperUrl({ ...HOPPER, lanNames: ['hopper', 'box.local'], machine: { docker: 'c1' } })).toBe('http://box.local:4790');
  });

  it('an ssh target with only a bare name: that name, which only a machine in the hopper\'s network reaches (the reach check says so)', () => {
    expect(jobHopperUrl({ ...HOPPER, lanNames: ['hopper'], machine: ssh })).toBe('http://hopper:4790');
  });

  it('an ssh target with no name at all: none, and its jobs get no way to the hopper', () => {
    expect(jobHopperUrl({ ...HOPPER, machine: ssh })).toBeUndefined();
  });
});
