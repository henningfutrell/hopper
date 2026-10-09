// A box that asks the vault (issues #558, #585): a machine joined through the real join line — as a box of a template
// when given — with its client started, a job at work on it, its proxy token in a file, and the client's helper run as
// a job runs it. Shared by the vault delivery tests.
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { HELPER_FILE } from '../../src/client/vault.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import type { TestApp } from './app.ts';
import { testInstallDir } from './client.ts';
import { waitFor } from './wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

/** What the boxes a test made hold: their clients and their temp dirs, all ended by `end`. */
export function boxes() {
  const clients: Client[] = [];
  const dirs: string[] = [];
  const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  return {
    temp,
    async end(): Promise<void> {
      for (const c of clients.splice(0)) await c.stop();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
    /** A machine joined — as a box of `template`, when given — and its client started: its client dir. */
    async join(a: TestApp, session: string, name: string, template?: string): Promise<string> {
      const dir = temp('hopper-machine-');
      const code = (await a.ui<{ code: string }>('/ui/api/machines/join', template ? { template } : {}, { token: session })).body.code;
      await joinHopper({ line: `${a.url}#${code}`, name, dir });
      clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
      await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
      return dir;
    },
    /** The job's proxy token as the hopper derives it (issue #563), in a file of the job's. */
    tokenFileOf(a: TestApp, job: string, token?: string): string {
      const file = join(temp('job-credentials-'), 'token');
      writeFileSync(file, `${token ?? proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
      return file;
    },
  };
}

/** A job that runs a while, on the one machine there is. */
export async function runningJob(a: TestApp, machine: string): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  expect((await a.waitForStatus(job.id, 'running', 10000)).laneId).toBe(`${machine}/lane-1`);
  return job.id;
}

/** The helper, run as a job runs it: its token file, and nothing of the vault in its environment. */
export function helper(dir: string, args: string[], tokenFile: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(join(dir, HELPER_FILE), args, { env: { PATH: process.env.PATH, HOPPER_TOKEN_FILE: tokenFile }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}
