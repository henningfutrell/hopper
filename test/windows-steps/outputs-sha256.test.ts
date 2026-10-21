// The job checks a step's outputs on arrival too (issue #2288): the real hopper-step script (sh and curl) runs against a
// stand-in hopper on loopback. Outputs whose sha256 is not the one the hopper gave are never unpacked, and the step
// fails; outputs that match are unpacked, and their sha256 is said.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STEP_HEADER, STEP_NOT_RUN, STEP_PATH, STEP_SCRIPT } from '../../src/windows-steps/index.ts';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'step-sha-')); dirs.push(d); return d; };

/** A stand-in hopper: one step, ended at once, its outputs `tar` with the sha256 header `sha`. */
async function hopper(tar: Buffer, sha: string): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'POST' && path === STEP_PATH) { res.writeHead(202, { [STEP_HEADER.id]: 's1' }); res.end('started: step s1\n'); return; }
      if (path === `${STEP_PATH}/s1/log`) { res.writeHead(200, { [STEP_HEADER.logNext]: '0', [STEP_HEADER.state]: 'ended' }); res.end(''); return; }
      if (path === `${STEP_PATH}/s1`) { res.writeHead(200, { [STEP_HEADER.exit]: '0', [STEP_HEADER.sha256]: sha, 'content-length': String(tar.length) }); res.end(tar); return; }
      res.writeHead(404); res.end('no');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function step(url: string): Promise<{ code: number; stderr: string; dir: string }> {
  const dir = temp();
  writeFileSync(join(dir, 'token'), 'job-token\n', { mode: 0o600 });
  writeFileSync(join(dir, 'step'), STEP_SCRIPT, { mode: 0o700 });
  return new Promise((resolve) => {
    execFile('sh', [join(dir, 'step'), 'box', 'cluster-read', '--command', 'helm template .', '--output', 'rendered.yaml', '--into', 'out'], {
      cwd: dir, env: { PATH: process.env.PATH, HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token'), TMPDIR: dir } as NodeJS.ProcessEnv, encoding: 'utf8',
    }, (err, _out, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stderr, dir }));
  });
}

const outputs = (): Buffer => {
  const src = temp();
  mkdirSync(join(src, 'o'));
  writeFileSync(join(src, 'o', 'rendered.yaml'), 'kind: ConfigMap\n'.repeat(1000));
  execFileSync('tar', ['-cf', join(src, 'o.tar'), '-C', join(src, 'o'), 'rendered.yaml']);
  return readFileSync(join(src, 'o.tar'));
};
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('hopper-step checks the outputs\' sha256 on arrival (issue #2288)', () => {
  it('unpacks outputs whose sha256 matches, and says it', async () => {
    const tar = outputs();
    const r = await step(await hopper(tar, sha256(tar)));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`hopper-step: outputs sha256 ${sha256(tar)}`);
    expect(readFileSync(join(r.dir, 'out', 'rendered.yaml'), 'utf8')).toBe('kind: ConfigMap\n'.repeat(1000));
  });

  it('never unpacks outputs damaged on the way: the step fails', async () => {
    const tar = outputs();
    // The same length, 57 bytes lost mid-file and NUL padding at the end: the damage the issue saw.
    const damaged = Buffer.concat([tar.subarray(0, 4000), tar.subarray(4057), Buffer.alloc(57)]);
    const r = await step(await hopper(damaged, sha256(tar)));
    expect(r.code).toBe(STEP_NOT_RUN);
    expect(r.stderr).toContain(`hopper-step: the outputs came back damaged: their sha256 is ${sha256(tar)}, here ${sha256(damaged)}`);
    expect(existsSync(join(r.dir, 'out', 'rendered.yaml'))).toBe(false);
  });
});
