// `node src/main.ts --help` (issue #68): how to run the daemon, every setting it reads with its
// default, where to read on. Needs no database: it is what a first run on a new machine asks.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SETTINGS, daemonHelp } from '../src/config.ts';

describe('daemon help', () => {
  it('lists every JOB_HOPPER_* setting the daemon reads, with its default and what it does', () => {
    const text = daemonHelp();
    for (const s of SETTINGS) {
      expect(text, s.name).toContain(s.name);
      expect(s.help.length, s.name).toBeGreaterThan(10);
    }
    expect(SETTINGS.find((s) => s.name === 'JOB_HOPPER_PORT')?.default).toBe('4790');
    expect(SETTINGS.find((s) => s.name === 'JOB_HOPPER_DATABASE_URL')?.default).toBe('required');
    expect(text).toMatch(/JOB_HOPPER_DATABASE_URL_FILE/);
    expect(text).toMatch(/\/docs\//);
    expect(text).toMatch(/README\.md/);
  });

  it.each([['--help'], ['-h']])('node src/main.ts %s prints it and exits 0 without a database', (flag) => {
    const r = spawnSync(process.execPath, ['src/main.ts', flag], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(daemonHelp());
  });
});
