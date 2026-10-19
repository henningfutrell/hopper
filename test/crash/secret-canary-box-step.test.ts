// The secret canary check (issue #1957), part 7: a kill mid-step of a box step whose template gives a vault secret.
// Through the crash harness on a need step (issue #1954), a job's sandbox request of the template `dig` is approved (sandbox
// YOLO), a person granted the job the vault, and the job runs a box step: the hopper copies the vault secret into the
// step's need box (issue #1875). The hopper is killed with SIGKILL before the step runs, after it ran, or while the need
// box runs, and a second hopper on the same database ends the step's saga. Then the whole database, the WAL, both hosts'
// work dirs and output, the fake GitHub's requests, every request to the container runtime but the copies into the box
// (its create bodies: the box's environment and labels, what an inspect shows) and what the job reads of the step are
// scanned: no canary is anywhere. The control: the copies into the box hold the secret, once for each box that ran.
//
// Feature: a box step's vault secret goes into its need box only, also when the hopper is killed mid-step
//   Scenario Outline: a box step of a template with a vault secret, the hopper killed <when>, ended by a second hopper
//     Examples: before the step runs | after it ran | while its need box runs
import { afterEach, describe, expect, it } from 'vitest';
import { sagaKillPoint } from '../../src/sagas/kill-points.ts';
import { NEED_STEP_SAGA } from '../../src/sandbox/need-step-saga.ts';
import { SKILL_PATH } from '../../src/skills/script.ts';
import { STEP_HEADER, STEP_PATH } from '../../src/windows-steps/script.ts';
import { rawRequest } from '../support/http.ts';
import { canary, databasePlaces, filePlaces, report, scan, walMark, walPlaces, type Place } from '../support/secret-canary.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, MASTER_KEY, stopHosts, type CrashHost } from './harness.ts';
import { asJob, keptStep, KUBE_MINTING_TOKEN, MINTING_SECRET, needSagas, needWorld, running, SCENARIO_MS, setUp, TEMPLATE, type NeedWorld } from './need-world.ts';

const worlds: NeedWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

const NAME = 'DEPLOY_TOKEN';
const KEY = 'canary-box-step-0001';

/** A place of captured text. */
const captured = (name: string, value: unknown): Place => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });

/** The job's sandbox request of the template, as `sh "$HOPPER_SKILL" sandbox --template dig` sends it. */
async function sandboxAsked(h: CrashHost, proxyToken: string): Promise<void> {
  const body = new URLSearchParams({ name: 'sandbox', template: TEMPLATE, why: 'Read the lab' }).toString();
  const r = await rawRequest(h.url, { method: 'POST', path: SKILL_PATH, body, headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/x-www-form-urlencoded' } });
  expect(r.status, r.text).toBe(200);
}

const ask = (h: CrashHost, proxyToken: string, command: string) =>
  asJob(h, proxyToken, 'POST', `${STEP_PATH}?${new URLSearchParams({ box: TEMPLATE, key: KEY, command, timeout: '600' }).toString()}`);

const point = (at: 'before-do' | 'after-do') => sagaKillPoint(NEED_STEP_SAGA, 'run', at);
const SCENARIOS: { when: string; point?: string }[] = [
  { when: 'before the step runs', point: point('before-do') },
  { when: 'after the step ran', point: point('after-do') },
  { when: 'while its need box runs' },
];

describe('the secret canary check, a box step\'s vault secret after a kill mid-step (issue #1957)', () => {
  for (const s of SCENARIOS) {
    it(`a box step of a template with a vault secret, the hopper killed ${s.when}: no canary is in any place the scan reads`, async () => {
      const w = await needWorld();
      worlds.push(w);
      const secret = canary('vault-secret');
      const canaries: Record<string, string> = { 'master key': MASTER_KEY, 'vault secret': secret, 'minting secret': MINTING_SECRET, 'kube minting token': KUBE_MINTING_TOKEN };
      const wal = walMark(w.url);

      const a = await w.host({ job: true, ...(s.point ? { killPoint: s.point } : {}) });
      const job = a.job!;
      canaries['proxy token'] = job.proxyToken;
      expect((await a.ui('/ui/api/vault', { action: 'set', name: NAME, value: secret })).status).toBe(200);
      await setUp(w, a, [NAME]);
      expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true })).status).toBe(200);
      expect((await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {})).status).toBe(200);
      await sandboxAsked(a, job.proxyToken);
      const asked = await ask(a, job.proxyToken, s.point ? 'deploy --dry-run' : 'deploy --dry-run # hang');
      if (s.point) await killedAt(a, s.point);
      else {
        expect(asked.status, asked.text).toBe(202);
        await waitFor(() => (running(w) && w.libpod.copies.length > 0 ? true : undefined), { timeoutMs: 30_000, what: 'the need box to run with its files' });
        await a.kill();
      }
      endLeases(w.url);
      const b = await w.host();
      await waitFor(() => {
        const sagas = needSagas(w.url);
        return sagas.length === 1 && sagas[0]!.state === 'done' ? true : undefined;
      }, { timeoutMs: 60_000, what: 'the second hopper to end the step\'s saga' });
      await waitFor(() => (w.libpod.containers.size === 0 && w.libpod.volumes.size === 0 ? true : undefined), { timeoutMs: 30_000, what: 'no need box or home left at the runtime' });

      // What the job reads of its step, from the second hopper: its result and its log.
      const id = keptStep(w.url);
      const result = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${id}`);
      expect(result.status, result.text).toBe(200);
      const log = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${id}/log?from=0`);
      expect(log.status, log.text).toBe(200);

      const places = [
        ...databasePlaces(w.url),
        ...(wal ? walPlaces(w.url, wal) : []),
        ...Object.entries({ 'killed host': a, 'second host': b }).flatMap(([name, h]) => [...filePlaces(`${name} work dir`, h.workDir), captured(`${name} output`, h.output())]),
        captured('GitHub requests', w.github.requests.map(({ auth: _connection, ...r }) => r)),
        // Every request to the container runtime but a copy into the box: where the secret is allowed to go.
        captured('container runtime requests', w.runtime.seen.filter((r) => !(r.method === 'PUT' && r.path.endsWith('/archive')))),
        captured('step result', { headers: result.headers, text: result.text }),
        captured('step log', log.text),
      ];
      expect(report(scan(canaries, places))).toBe('');
      // The control: the secret went into the need box, by a copy, and the job reads the step's end.
      expect(w.libpod.copies.filter((c) => c.tar.includes(secret)).length).toBeGreaterThan(0);
      expect(result.headers[STEP_HEADER.exit]).toBeDefined();
      if (wal) expect(places.some((p) => p.name.startsWith('WAL ') && p.text.includes(id))).toBe(true);
    }, SCENARIO_MS);
  }
});
