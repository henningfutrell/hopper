// A hopper with a job at work on a joined machine, and the real `hopper-artifact` run as that job runs it (issue #624):
// what the artifact integration tests share. One harness per test file; `stop()` in its afterEach.
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_SCRIPT } from '../../src/artifacts/index.ts';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { ArtifactsView, DomainEvent, Job } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { createFakeAuthorizationServer } from './fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from './app.ts';
import { testInstallDir } from './client.ts';
import { waitFor } from './wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

export interface Run { code: number; stdout: string; stderr: string }

export const ISSUE = { url: 'https://github.com/octo-org/hello/issues/7', repo: 'octo-org/hello', number: 7 };

export function artifactHarness() {
  let t: TestApp | undefined;
  const clients: Client[] = [];
  const cleanups: (() => void)[] = [];
  const saved = { ...process.env };

  const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  return {
    temp,
    async stop(): Promise<void> {
      for (const c of clients.splice(0)) await c.stop();
      await t?.stop();
      t = undefined;
      for (const c of cleanups.splice(0)) c();
      process.env = { ...saved };
    },

    /** A hopper with one joined machine and a job of `source` (default: issue #7) running on it. */
    async boot(o: { env?: Record<string, string>; secrets?: Record<string, string>; source?: Partial<Job['source']>; seams?: Parameters<typeof startTestApp>[0]['seams'] } = {}): Promise<{ a: TestApp; session: string; job: string }> {
      const db = tempDbPath();
      cleanups.push(db.cleanup);
      process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
      process.env.FAKE_HERDR_RUNNING = '1';
      t = await startTestApp({
        dbPath: db.dbPath,
        plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
        seams: { authorizationServer: createFakeAuthorizationServer(), ...o.seams },
        ...(o.env ? { env: o.env } : {}),
        ...(o.secrets ? { secrets: o.secrets } : {}),
      });
      const session = await t.login();
      const dir = temp('hopper-machine-');
      const code = (await t.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
      await joinHopper({ line: `${t.url}#${code}`, name: 'desk', dir });
      clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
      const a = t;
      await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === 'desk' && m.online), { timeoutMs: 10000, what: 'desk online' });
      const pulled = await a.pull({ op: 'sleep', ms: 60000 }, { ...ISSUE, ...o.source } as never);
      await a.waitForStatus(pulled.id, 'running', 10000);
      return { a, session, job: pulled.id };
    },

    /** `hopper-artifact`, run as the job runs it: the script and its proxy token in the job's credentials dir, in `cwd`. */
    artifact(a: TestApp, job: string, args: string[], o: { token?: string; cwd?: string } = {}): Promise<Run> {
      const dir = temp('job-credentials-');
      writeFileSync(join(dir, 'token'), `${o.token ?? proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
      writeFileSync(join(dir, 'artifact'), ARTIFACT_SCRIPT, { mode: 0o700 });
      return new Promise((resolve) => {
        execFile('sh', [join(dir, 'artifact'), ...args], {
          cwd: o.cwd, env: { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(dir, 'token') } as NodeJS.ProcessEnv, encoding: 'utf8',
        }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
      });
    },

    /** A file in a scratch dir of the job's. */
    file(name: string, body: string | Buffer): { dir: string; path: string } {
      const dir = temp('job-work-');
      writeFileSync(join(dir, name), body);
      return { dir, path: join(dir, name) };
    },
  };
}

export const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user().store.events.recent(1000).filter((e) => e.type === type);
export const readArtifacts = async (a: TestApp, session: string): Promise<ArtifactsView> =>
  (await a.api<ArtifactsView>('GET', '/api/artifacts', undefined, { 'x-hopper-session': session })).body;
