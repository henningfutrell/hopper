// The secret canary check (issue #1957), part 6: a kill mid-step of a step that carries a vault secret. Through the
// crash harness (issue #1954), a job asks for a Windows step with a vault secret its host gives and a person granted the
// job; the hopper is killed with SIGKILL before the step runs, after it ran, or while it runs on the host, and a second
// hopper on the same database ends the step's saga. The step prints its secret, as a careless step would. Then the
// whole database, the WAL, both hosts' work dirs and output, the Windows host's files, the fake GitHub's requests and
// what the job reads of the step are scanned: no canary is anywhere. The controls: the Windows host got the secret (by
// its SHA-256), and the log the job reads holds the mask where the step printed it.
//
// Feature: a step's vault secret goes to the step only, also when the hopper is killed mid-step
//   Scenario Outline: a Windows step with a vault secret, the hopper killed <when>, ended by a second hopper
//     Examples: before the step runs | after it ran | while it runs on the host
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sagaKillPoint } from '../../src/sagas/kill-points.ts';
import { MASK, STEP_HEADER, STEP_PATH, WINDOWS_STEP_SAGA } from '../../src/windows-steps/index.ts';
import { canary, databasePlaces, filePlaces, report, scan, walMark, walPlaces, type Place } from '../support/secret-canary.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, MASTER_KEY, stopHosts, type CrashHost } from './harness.ts';
import { deliveredOn, runsOn } from './windows-host.ts';
import { addHost, asJob, HOST, SCENARIO_MS, stepSagas, windowsWorld, type WindowsWorld } from './windows-world.ts';

const worlds: WindowsWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

const NAME = 'NUGET_TOKEN';
const KEY = 'canary-step-0001';

/** A place of captured text. */
const captured = (name: string, value: unknown): Place => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });

const ask = (h: CrashHost, proxyToken: string, command: string) =>
  asJob(h, proxyToken, 'POST', `${STEP_PATH}?${new URLSearchParams({ host: HOST.name, key: KEY, command, secret: NAME }).toString()}`);

const SCENARIOS: { when: string; point?: string }[] = [
  { when: 'before the step runs', point: sagaKillPoint(WINDOWS_STEP_SAGA, 'run', 'before-do') },
  { when: 'after the step ran', point: sagaKillPoint(WINDOWS_STEP_SAGA, 'run', 'after-do') },
  { when: 'while the step runs on the host' },
];

describe('the secret canary check, a step\'s vault secret after a kill mid-step (issue #1957)', () => {
  for (const s of SCENARIOS) {
    it(`a Windows step with a vault secret, the hopper killed ${s.when}: no canary is in any place the scan reads`, async () => {
      const w = await windowsWorld();
      worlds.push(w);
      const secret = canary('vault-secret');
      const canaries: Record<string, string> = { 'master key': MASTER_KEY, 'vault secret': secret };
      const wal = walMark(w.url);

      const a = await w.host({ job: true, ...(s.point ? { killPoint: s.point } : {}) });
      const job = a.job!;
      canaries['proxy token'] = job.proxyToken;
      expect((await a.ui('/ui/api/vault', { action: 'set', name: NAME, value: secret })).status).toBe(200);
      await addHost(a, [NAME]);
      expect((await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {})).status).toBe(200);
      const asked = await ask(a, job.proxyToken, s.point ? 'nuget push' : 'nuget push hang');
      if (s.point) await killedAt(a, s.point);
      else {
        expect(asked.status, asked.text).toBe(202);
        const id = String(asked.headers[STEP_HEADER.id]);
        await waitFor(() => (runsOn(w.dir).includes(id) ? true : undefined), { timeoutMs: 30_000, what: 'the step to run on the host' });
        await a.kill();
      }
      endLeases(w.url);
      const b = await w.host();
      await waitFor(() => {
        const sagas = stepSagas(w.url);
        return sagas.length === 1 && sagas[0]!.state === 'done' ? true : undefined;
      }, { timeoutMs: 60_000, what: 'the second hopper to end the step\'s saga' });

      // What the job reads of its step, from the second hopper: its result and its log.
      const id = String((await ask(b, job.proxyToken, 'nuget push')).headers[STEP_HEADER.id]);
      const result = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${id}`);
      const log = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${id}/log?from=0`);
      expect(log.status, log.text).toBe(200);

      const places = [
        ...databasePlaces(w.url),
        ...(wal ? walPlaces(w.url, wal) : []),
        ...Object.entries({ 'killed host': a, 'second host': b }).flatMap(([name, h]) => [...filePlaces(`${name} work dir`, h.workDir), captured(`${name} output`, h.output())]),
        ...filePlaces('Windows host', w.dir),
        captured('GitHub requests', w.github.requests.map(({ auth: _connection, ...r }) => r)),
        captured('step result', { headers: result.headers, text: result.text }),
        captured('step log', log.text),
      ];
      expect(report(scan(canaries, places))).toBe('');
      // The controls: the step ran on the host once, with the secret; the log the job reads masks what it printed.
      expect(runsOn(w.dir)).toEqual([id]);
      expect(deliveredOn(w.dir)).toEqual([{ step: id, name: NAME, sha256: createHash('sha256').update(secret).digest('hex') }]);
      expect(log.text).toContain(`token ${MASK} used`);
      if (wal) expect(places.some((p) => p.name.startsWith('WAL ') && p.text.includes(id))).toBe(true);
    }, SCENARIO_MS);
  }
});
