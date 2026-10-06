// The root herdr's saved machines (issue #189): herdr's own CLI (`herdr machine list --json`, `add`,
// `remove`) run in the herdr terminal's environment, so the catalog it changes is the terminal's own
// (XDG_STATE_HOME), never a user's own saved machines. A saved machine matching a profile (label,
// target, session) is kept; one that differs or is no longer listed is removed; a missing one is added.
// `machine add` checks the remote herdr session runs and never installs anything (non-interactive).
import { execFile } from 'node:child_process';
import type { HerdrMachineProfile, SyncHerdrMachines } from '../domain/ports.ts';

interface Saved { id: string; label: string; target: string; session?: string }

const ADD_TIMEOUT_MS = 60000;

function run(herdr: string, args: string[], env: Record<string, string>, timeout = 15000): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    execFile(herdr, args, { env, timeout, encoding: 'utf8' }, (e, stdout, stderr) => {
      const said = stderr.trim().split('\n').filter(Boolean).at(-1)?.replace(/^error:\s*/, '');
      resolve({ ok: !e, stdout, error: said ?? e?.message ?? '' });
    });
  });
}

export const syncHerdrMachines: SyncHerdrMachines = async ({ herdr, env, profiles }) => {
  const list = await run(herdr, ['machine', 'list', '--json'], env);
  if (!list.ok) return profiles.map((p) => ({ machine: p.machine, state: 'failed', error: `herdr machine list: ${list.error}` }));
  const saved = JSON.parse(list.stdout) as Saved[];
  const same = (s: Saved, p: HerdrMachineProfile) => p.label === s.label && p.target === s.target && p.session === s.session;
  const matches = (s: Saved) => profiles.some((p) => same(s, p));
  for (const s of saved.filter((x) => !matches(x))) {
    const r = await run(herdr, ['machine', 'remove', s.id], env);
    if (!r.ok) console.warn(`hopper: herdr terminal: could not remove saved herdr machine ${s.label}: ${r.error}`);
  }
  const results = [];
  for (const p of profiles) {
    if (saved.some((s) => same(s, p))) { results.push({ machine: p.machine, state: 'saved' as const }); continue; }
    const r = await run(herdr, ['machine', 'add', p.target, '--label', p.label, '--remote-session', p.session], env, ADD_TIMEOUT_MS);
    results.push(r.ok ? { machine: p.machine, state: 'saved' as const } : { machine: p.machine, state: 'failed' as const, error: r.error });
  }
  return results;
};
