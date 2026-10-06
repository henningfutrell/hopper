// Issue #189: the root herdr's saved machines follow the plan — one per listed machine, the rest
// removed — in the herdr terminal's own herdr state (XDG_STATE_HOME), never the user's own saved
// machines, with the ssh wrapper first on PATH. The real sync over a stand-in herdr binary.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syncHerdrMachines } from '../../src/herdr-terminal/machines.ts';

const FAKE = fileURLToPath(new URL('./fake-herdr-machines.mjs', import.meta.url));

function setup(catalog: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-terminal-machines-'));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog));
  const env = { PATH: `/w/herdr-terminal/bin:${process.env.PATH ?? ''}`, XDG_STATE_HOME: '/w/herdr-terminal/state', FAKE_HERDR_DIR: dir };
  const calls = () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; state: string; path0: string; herdrEnv: string[] });
  const saved = () => JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')) as { id: string; label: string; target: string; session: string }[];
  return { env, calls, saved };
}

const laptop = { machine: 'laptop', label: 'Laptop (laptop)', target: 'ssh://me@192.0.2.10:22', session: 'hopper', hostKey: 'k' };
const desk = { machine: 'desk', label: 'desk', target: 'ssh://me@192.0.2.11:2222', session: 'hopper', hostKey: 'k' };

describe('the root herdr\'s saved machines', () => {
  it('adds each listed machine under its label on its herdr session, in the terminal\'s own herdr state', async () => {
    const s = setup();
    const r = await syncHerdrMachines({ herdr: FAKE, env: s.env, profiles: [laptop, desk] });
    expect(r).toEqual([{ machine: 'laptop', state: 'saved' }, { machine: 'desk', state: 'saved' }]);
    expect(s.saved().map((m) => [m.label, m.target, m.session])).toEqual([['Laptop (laptop)', 'ssh://me@192.0.2.10:22', 'hopper'], ['desk', 'ssh://me@192.0.2.11:2222', 'hopper']]);
    const adds = s.calls().filter((c) => c.argv[1] === 'add');
    expect(adds[0]!.argv).toEqual(['machine', 'add', 'ssh://me@192.0.2.10:22', '--label', 'Laptop (laptop)', '--remote-session', 'hopper']);
    for (const c of s.calls()) expect([c.state, c.path0, c.herdrEnv]).toEqual(['/w/herdr-terminal/state', '/w/herdr-terminal/bin', []]);
  });

  it('keeps a saved machine that matches, replaces one that changed, removes one no longer listed', async () => {
    const s = setup([
      { id: 'a', label: 'Laptop (laptop)', target: 'ssh://me@192.0.2.10:22', session: 'hopper' },
      { id: 'b', label: 'desk', target: 'ssh://me@192.0.2.11:22', session: 'hopper' },
      { id: 'c', label: 'gone', target: 'ssh://me@192.0.2.12:22', session: 'hopper' },
    ]);
    const r = await syncHerdrMachines({ herdr: FAKE, env: s.env, profiles: [laptop, desk] });
    expect(r).toEqual([{ machine: 'laptop', state: 'saved' }, { machine: 'desk', state: 'saved' }]);
    expect(s.calls().filter((c) => c.argv[1] === 'remove').map((c) => c.argv[2]).sort()).toEqual(['b', 'c']);
    expect(s.saved().map((m) => m.target)).toEqual(['ssh://me@192.0.2.10:22', 'ssh://me@192.0.2.11:2222']);
    expect(s.saved()[0]!.id).toBe('a');
  });

  it('reports a machine herdr could not save, with herdr\'s error, and saves the others', async () => {
    const s = setup();
    const r = await syncHerdrMachines({ herdr: FAKE, env: s.env, profiles: [{ ...desk, machine: 'far', target: 'ssh://me@192.0.2.99:22' }, laptop] });
    expect(r[0]).toEqual({ machine: 'far', state: 'failed', error: 'remote platform detection failed: ssh: connect to host 192.0.2.99 port 22: Connection timed out; machine was not saved' });
    expect(r[1]).toEqual({ machine: 'laptop', state: 'saved' });
  });
});
