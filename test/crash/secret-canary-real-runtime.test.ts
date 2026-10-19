// The secret canary check (issue #1957), part 8: its e2e mode. Part 7's box step with a vault secret, the hopper killed
// mid-step, on a real rootless Podman in place of the libpod double: the hosts are the hopper's real composition root in
// processes of their own (the crash harness), and the need box is a real container of a real image, with a real home
// volume. After a second hopper ended the step's saga, the scan reads what part 7's reads — the database, the WAL, both
// hosts' work dirs and output, the fake GitHub's requests, what the job reads of its step — and also the runtime itself:
// each container's inspect output, layers and home, each volume's inspect output, each image's inspect output and the
// layers of each image made meanwhile, and the runtime's storage on disk (test/support/runtime-places.ts). No canary is
// anywhere. The control: while the need box runs, the scan of the runtime finds the vault secret in the box's home.
//
// It runs only where HOPPER_TEST_PODMAN_SOCKET names a rootless Podman's API socket this test may fill and empty (a
// runtime of its own: the scan reads all of its storage), so `npm test` and the pull request check skip it. The image of
// the template is built on that runtime from HOPPER_TEST_BOX_BASE (default: alpine), which it pulls once.
//
// Feature: a box step's vault secret is in no container layer, image or volume of a real runtime after a kill mid-step
//   Scenario Outline: a box step of a template with a vault secret on a real Podman, the hopper killed <when>
//     Examples: before the step runs | after it ran | while its need box runs
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sagaKillPoint } from '../../src/sagas/kill-points.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { NEED_STEP_SAGA } from '../../src/sandbox/need-step-saga.ts';
import { createPodmanRuntime } from '../../src/sandbox/podman.ts';
import { SKILL_PATH } from '../../src/skills/script.ts';
import { STEP_HEADER, STEP_PATH } from '../../src/windows-steps/script.ts';
import { rawRequest } from '../support/http.ts';
import { imagesMark, noneLeft, runtimePlaces } from '../support/runtime-places.ts';
import { canary, databasePlaces, filePlaces, report, scan, walMark, walPlaces, type Place } from '../support/secret-canary.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, MASTER_KEY, stopHosts, type CrashHost } from './harness.ts';
import { asJob, DIG_IMAGE, keptStep, KUBE_MINTING_TOKEN, MINTING_SECRET, needSagas, needWorld, SCENARIO_MS, setUp, TEMPLATE, type NeedWorld } from './need-world.ts';

const SOCKET = process.env.HOPPER_TEST_PODMAN_SOCKET?.replace(/^unix:\/\//, '');
/** The base of the template's image: a small image with a shell, run as a user that is not root. */
const BASE_IMAGE = process.env.HOPPER_TEST_BOX_BASE ?? 'docker.io/library/alpine:3.20';

const worlds: NeedWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

const NAME = 'DEPLOY_TOKEN';
const KEY = 'canary-real-runtime-0001';

const captured = (name: string, value: unknown): Place => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });

async function sandboxAsked(h: CrashHost, proxyToken: string): Promise<void> {
  const body = new URLSearchParams({ name: 'sandbox', template: TEMPLATE, why: 'Read the lab' }).toString();
  const r = await rawRequest(h.url, { method: 'POST', path: SKILL_PATH, body, headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/x-www-form-urlencoded' } });
  expect(r.status, r.text).toBe(200);
}

const ask = (h: CrashHost, proxyToken: string, command: string) =>
  asJob(h, proxyToken, 'POST', `${STEP_PATH}?${new URLSearchParams({ box: TEMPLATE, key: KEY, command, timeout: '600' }).toString()}`);

/** The step's command: it reads the vault secret as a box step does, and says only that it did. */
const READ = `"$HOPPER_SECRET" get ${NAME} > "$HOME/work/read" && echo read`;

const point = (at: 'before-do' | 'after-do') => sagaKillPoint(NEED_STEP_SAGA, 'run', at);
const SCENARIOS: { when: string; point?: string }[] = [
  { when: 'before the step runs', point: point('before-do') },
  { when: 'after the step ran', point: point('after-do') },
  { when: 'while its need box runs' },
];

/** Whether a need box runs now at the runtime on `socket`. */
const boxRunning = async (socket: string): Promise<boolean> =>
  (await createPodmanRuntime(socket).list()).some((c) => c.labels[NEED_LABEL] !== undefined && c.state === 'running');

describe.skipIf(!SOCKET)('the secret canary check on a real container runtime, a box step\'s vault secret after a kill mid-step (issue #1957)', () => {
  beforeAll(async () => {
    const runtime = createPodmanRuntime(SOCKET!);
    expect(await runtime.problem()).toBeUndefined();
    await runtime.build!(DIG_IMAGE, `FROM ${BASE_IMAGE}\nRUN adduser -D -u 1000 agent\nUSER agent\n`);
  }, 600_000);

  it('a canary planted in the layer of an image made since the mark is found by the scan of the runtime (the control)', async () => {
    const runtime = createPodmanRuntime(SOCKET!);
    const planted = canary('planted');
    const tag = `localhost/canary-plant:${planted.slice(-8)}`;
    const before = await imagesMark(SOCKET!);
    await runtime.build!(tag, `FROM ${DIG_IMAGE}\nRUN echo ${planted} > /tmp/planted\n`);
    try {
      const found = scan({ planted }, await runtimePlaces(SOCKET!, { before, home: HOME }));
      expect(found.map((f) => f.place)).toContain(`image ${tag} layers`);
    } finally {
      const id = (await runtime.pull(tag)).id ?? tag;
      await runtime.removeImage!(id);
    }
  }, 300_000);

  for (const s of SCENARIOS) {
    it(`a box step of a template with a vault secret on a real Podman, the hopper killed ${s.when}: no canary is in any place the scan reads`, async () => {
      const socket = SOCKET!;
      const w = await needWorld({ podman: socket });
      worlds.push(w);
      const secret = canary('vault-secret');
      const canaries: Record<string, string> = { 'master key': MASTER_KEY, 'vault secret': secret, 'minting secret': MINTING_SECRET, 'kube minting token': KUBE_MINTING_TOKEN };
      const wal = walMark(w.url);
      const before = await imagesMark(socket);

      const a = await w.host({ job: true, ...(s.point ? { killPoint: s.point } : {}) });
      const job = a.job!;
      canaries['proxy token'] = job.proxyToken;
      expect((await a.ui('/ui/api/vault', { action: 'set', name: NAME, value: secret })).status).toBe(200);
      await setUp(w, a, [NAME]);
      expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true })).status).toBe(200);
      expect((await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {})).status).toBe(200);
      await sandboxAsked(a, job.proxyToken);
      const asked = await ask(a, job.proxyToken, s.point ? READ : `${READ} && sleep 600`);
      if (s.point) await killedAt(a, s.point);
      else {
        expect(asked.status, asked.text).toBe(202);
        // The control: the scan of the runtime reads the box's home, where the secret is while the box runs.
        const inBox = await waitFor(async () => {
          if (!(await boxRunning(socket))) return undefined;
          const places = await runtimePlaces(socket, { before, home: HOME });
          // The mark of the files is copied last, after the hopper removed its home tar from the work dir.
          if (!places.some((p) => p.name.endsWith(' home') && p.text.includes('.hopper-need/.ready'))) return undefined;
          const found = scan({ 'vault secret': secret }, places);
          return found.some((f) => f.place.endsWith(' home')) ? found : undefined;
        }, { timeoutMs: 120_000, intervalMs: 1000, what: 'the vault secret in the running need box\'s home' });
        expect(inBox.every((f) => f.place.startsWith('container '))).toBe(true);
        await a.kill();
      }
      endLeases(w.url);
      const b = await w.host();
      await waitFor(() => {
        const sagas = needSagas(w.url);
        return sagas.length === 1 && sagas[0]!.state === 'done' ? true : undefined;
      }, { timeoutMs: 120_000, what: 'the second hopper to end the step\'s saga' });
      await waitFor(async () => ((await noneLeft(socket, NEED_LABEL)) ? true : undefined), { timeoutMs: 60_000, intervalMs: 500, what: 'no need box or home left at the runtime' });

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
        captured('step result', { headers: result.headers, text: result.text }),
        captured('step log', log.text),
        ...await runtimePlaces(socket, { before, home: HOME }),
      ];
      expect(report(scan(canaries, places))).toBe('');
      expect(result.headers[STEP_HEADER.exit]).toBeDefined();
      if (s.point === point('after-do')) expect(log.text).toContain('read');
    }, SCENARIO_MS * 2);
  }
});
