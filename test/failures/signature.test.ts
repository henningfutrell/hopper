// A failure's signature (issue #509): its error text normalised — ids, paths, numbers and times stripped — and
// hashed, so one cause on many jobs is one signature, and two causes are two. Known causes match by their text.
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAUSES, matchCause } from '../../src/failures/causes.ts';
import { normalise, signatureOf } from '../../src/failures/signature.ts';

const SOCKET = (dir: string) => `herdr: Error: Socket path too long: ${dir}/herdr-1234/control.sock (108 bytes max)`;

describe('normalise', () => {
  it('strips paths, numbers, ids, hashes, urls and times, and folds case and spaces', () => {
    expect(normalise('Job 6f1c0e0e-2d0b-4f7e-9a53-0d9d3a1b2c3d failed at 2026-10-08T12:00:01.123Z on /home/u/hopper-jobs/x:  exit 137'))
      .toBe('job <id> failed at <time> on <path>: exit <n>');
    expect(normalise('fetch https://api.github.com/repos/o/r/issues/12 gave 502 at 12:04:55')).toBe('fetch <url> gave <n> at <time>');
    expect(normalise('commit 0702781abc not found')).toBe('commit <id> not found');
    expect(normalise('\u001b[31mERROR\u001b[0m   Disk\tfull')).toBe('error disk full');
  });

  it('keeps words: a word is never taken for an id', () => {
    expect(normalise('facade decade accede')).toBe('facade decade accede');
  });

  it('empty text normalises to empty', () => {
    expect(normalise('')).toBe('');
    expect(normalise('   ')).toBe('');
  });

  it('is bounded: a long text is cut', () => {
    expect(normalise('x '.repeat(5000)).length).toBeLessThanOrEqual(400);
  });
});

describe('signatureOf', () => {
  it('the same cause on different jobs, machines, dirs and times has one signature', () => {
    const a = signatureOf(SOCKET('/tmp/hopper-scratch/83312587-884b-43d9-b291-d19686d82d99'));
    const b = signatureOf(SOCKET('/home/someone/.hopper-scratch/0a1b2c3d-0000-4000-8000-000000000000/deep/er'));
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(a.normalised).toBe('herdr: error: socket path too long: <path> (<n> bytes max)');
  });

  it('two causes have two signatures', () => {
    expect(signatureOf('No space left on device').signature).not.toBe(signatureOf('not logged in').signature);
  });
});

describe('matchCause', () => {
  const cause = (text: string) => matchCause(text, signatureOf(text).signature, [])?.id;

  it('names the four shared causes the issue tests with', () => {
    expect(cause(SOCKET('/tmp/x'))).toBe('socket-path-too-long');
    expect(cause('gh: authentication failed. Run gh auth login to authenticate')).toBe('login-expired');
    expect(cause('claude: Not logged in · Please run /login')).toBe('login-expired');
    expect(cause('write /work/x: ENOSPC: no space left on device')).toBe('disk-full');
    expect(cause('machine desk did not reconnect within 60 s after the daemon restart')).toBe('machine-offline');
    expect(cause('ssh: connect to host box port 22: No route to host')).toBe('machine-offline');
  });

  it('names transient hiccups and job-specific ends', () => {
    expect(cause('interrupted by daemon restart')).toBe('daemon-restart');
    expect(cause('read ECONNRESET')).toBe('network');
    expect(cause('herdr: agent did not start')).toBe('start-race');
    expect(cause('question unanswered')).toBe('question-unanswered');
    expect(cause('invalid payload for executor test: prompt must be a string')).toBe('invalid-spec');
  });

  it('no known cause matches an unknown text', () => {
    expect(cause('HOPPER_FAILED the tests do not pass')).toBeUndefined();
  });

  it('a cause the user named for a signature wins over the built-in ones', () => {
    const text = 'read ECONNRESET';
    const { signature } = signatureOf(text);
    const named = matchCause(text, signature, [{ signature, name: 'Proxy drops', description: 'the office proxy', decision: 'hold' }]);
    expect(named).toMatchObject({ id: `named:${signature}`, name: 'Proxy drops', cls: 'shared', decision: 'hold' });
  });

  it('every built-in cause has a name, a description and a decision that fits its class', () => {
    for (const c of BUILTIN_CAUSES) {
      expect(c.name.length, c.id).toBeGreaterThan(0);
      expect(c.description.length, c.id).toBeGreaterThan(0);
      if (c.cls === 'transient') expect(c.decision).toBe('retry');
      if (c.cls === 'shared') expect(['hold', 'redirect']).toContain(c.decision);
      if (c.cls === 'job') expect(c.decision).toBe('person');
    }
  });
});
