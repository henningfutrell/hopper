// Issue #870: a box of a template that is not read-only has the apply wrapper first on PATH. terraform
// applies only the saved plan file of a plan the hopper recorded: the wrapper fetches that file from the hopper, with the
// job's proxy token, and gives it to the real binary. A plan file the caller names must be the same file, by its SHA-256.
// Every other command that changes infrastructure or state is refused: it has no plan. Run by a real `sh` and `curl`,
// with a fake real binary that logs what it was given, and a fake hopper on loopback.
//
// Feature: the apply wrapper
//   Scenario: the commands that change nothing go to the real binary as they were given
//   Scenario: an apply with no plan named is refused, and the real binary is not run
//   Scenario: an apply runs the plan's saved file, fetched from the hopper with the job's token
//   Scenario: a plan file the caller names that is not the plan's saved file is refused
//   Scenario: in a need box, an apply runs the saved file the hopper put there, with no fetch (issue #1007)
//   Scenario: a plan the hopper does not give is refused, saying why
//   Scenario: an apply flag that would change what the saved plan does is refused
//   Scenario: every other command that writes infrastructure or state is refused
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APPLY_WRAPPER_REFUSAL, TERRAFORM_APPLY_WRAPPER } from '../../src/sandbox/terraform-wrapper.ts';

const PLAN = '3f2b8a7c-1d4e-4f6a-9b0c-2d3e4f5a6b7c';
const FILE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255]);
const TOKEN = 'job-proxy-token';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A fake hopper: the plan file of PLAN to its job's token, else the hopper's no. */
async function hopper(): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end('no: the token is not a job\'s of this hopper\n'); return; }
    if (req.url === `/job/infra-plans/${PLAN}?file=1`) { res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(FILE); return; }
    res.writeHead(404).end(`no: no plan ${req.url?.split('/')[3]?.split('?')[0]}\n`);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

interface Ran { code: number; stderr: string; real: string[]; applied: Buffer[] }

function setup(url = 'http://127.0.0.1:1'): { dir: string; run(args: string[], env?: Record<string, string>): Promise<Ran> } {
  const dir = mkdtempSync(join(tmpdir(), 'tf-apply-wrapper-'));
  dirs.push(dir);
  const log = join(dir, 'real.log');
  writeFileSync(log, '');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'applied'));
  mkdirSync(join(dir, 'tmp'));
  // The fake real binary logs its arguments; given a plan file to apply, it keeps a copy of what it read.
  writeFileSync(join(dir, 'bin', 'terraform'), `#!/bin/sh
printf '%s|' "$@" >> ${JSON.stringify(log)}
printf '%s\\n' "\${TF_CLI_ARGS-unset}" >> ${JSON.stringify(log)}
seen=; for a; do case $a in apply) seen=1 ;; -*) ;; *) [ -n "$seen" ] && cp "$a" ${JSON.stringify(join(dir, 'applied'))}/$(date +%s%N) ;; esac; done; true
`);
  chmodSync(join(dir, 'bin', 'terraform'), 0o755);
  writeFileSync(join(dir, 'terraform'), TERRAFORM_APPLY_WRAPPER);
  chmodSync(join(dir, 'terraform'), 0o755);
  writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
  return {
    dir,
    run: (args, env = {}) => new Promise((resolve) => {
      execFile(join(dir, 'terraform'), args, {
        cwd: dir, encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOPPER_TOOLS: join(dir, 'bin'), HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token'), TMPDIR: join(dir, 'tmp'), ...env },
      }, (err, _stdout, stderr) => {
        const applied = readdir(join(dir, 'applied')).map((f) => readFileSync(join(dir, 'applied', f)));
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stderr, real: readFileSync(log, 'utf8').split('\n').filter((x) => x !== ''), applied });
      });
    }),
  };
}

const readdir = (d: string): string[] => readdirSync(d).sort();

describe('the apply wrapper (issue #870)', () => {
  it('the commands that change nothing go to the real binary as they were given', async () => {
    const w = setup();
    const runs = [['version'], ['init', '-input=false'], ['plan', '-out=tf.plan'], ['plan', '-destroy', '-out', 'tf.plan'], ['show', '-json', 'tf.plan'], ['validate'], ['output'], ['state', 'list'], ['state', 'pull'], ['workspace', 'select', 'utility'], ['-chdir=stack', 'plan']];
    for (const args of runs) expect((await w.run(args)).code, args.join(' ')).toBe(0);
    // TF_CLI_ARGS cannot slip a flag past it.
    expect((await w.run(['plan'], { TF_CLI_ARGS: '-target=x' })).real.at(-1)).toBe('plan|unset');
    expect((await w.run(['version'])).real.slice(0, runs.length)).toEqual(runs.map((a) => `${a.join('|')}|unset`));
  });

  it('an apply with no plan named is refused, and the real binary is not run', async () => {
    const h = await hopper();
    const w = setup(h.url);
    for (const args of [['apply'], ['apply', '-auto-approve'], ['apply', 'tf.plan'], ['-chdir=stack', 'apply', '-auto-approve']]) {
      const r = await w.run(args);
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(r.stderr).toContain(`terraform apply: ${APPLY_WRAPPER_REFUSAL}`);
      expect(r.stderr).toMatch(/no apply without a plan/);
      expect(r.stderr).toContain('HOPPER_PLAN');
    }
    expect((await w.run(['apply'], { HOPPER_PLAN: 'not a plan id' })).stderr).toMatch(/HOPPER_PLAN must be a plan's id/);
    expect((await w.run(['version'])).real).toEqual(['version|unset']);
    expect(h.asked).toEqual([]);
  });

  it('an apply runs the plan\'s saved file, fetched from the hopper with the job\'s token', async () => {
    const h = await hopper();
    const w = setup(h.url);
    const r = await w.run(['apply', '-auto-approve', '-input=false'], { HOPPER_PLAN: PLAN });
    expect(r.code, r.stderr).toBe(0);
    expect(h.asked).toEqual([`GET /job/infra-plans/${PLAN}?file=1 Bearer ${TOKEN}`]);
    expect(r.real).toHaveLength(1);
    expect(r.real[0]).toMatch(/^apply\|-auto-approve\|-input=false\|\/.+\|unset$/);
    expect(r.applied).toEqual([FILE]);
    // The fetched file is removed after the apply.
    expect(readdir(join(w.dir, 'tmp'))).toEqual([]);

    // The caller's own copy of the plan file: the same bytes, so the plan's file is applied in its place; with -chdir too.
    mkdirSync(join(w.dir, 'stack'));
    writeFileSync(join(w.dir, 'stack', 'tf.plan'), FILE);
    const named = await w.run(['-chdir=stack', 'apply', '-auto-approve', 'tf.plan'], { HOPPER_PLAN: PLAN });
    expect(named.code, named.stderr).toBe(0);
    expect(named.real.at(-1)).toMatch(/^-chdir=stack\|apply\|-auto-approve\|\/.+\|unset$/);
    expect(named.real.at(-1)).not.toContain('tf.plan');
    expect(named.applied).toEqual([FILE, FILE]);
  });

  it('a plan file the caller names that is not the plan\'s saved file is refused', async () => {
    const h = await hopper();
    const w = setup(h.url);
    writeFileSync(join(w.dir, 'other.plan'), Buffer.from('another plan'));
    const r = await w.run(['apply', 'other.plan'], { HOPPER_PLAN: PLAN });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`terraform apply: ${APPLY_WRAPPER_REFUSAL}`);
    expect(r.stderr).toMatch(/other\.plan is not the saved plan file of plan 3f2b8a7c/);
    expect((await w.run(['apply', 'missing.plan'], { HOPPER_PLAN: PLAN })).stderr).toMatch(/missing\.plan cannot be read/);
    expect((await w.run(['apply', 'a.plan', 'b.plan'], { HOPPER_PLAN: PLAN })).stderr).toMatch(/one plan file/);
    expect((await w.run(['version'])).real).toEqual(['version|unset']);
  });

  it('in a need box, an apply runs the saved file the hopper put there, with no fetch (issue #1007)', async () => {
    // A need box holds no proxy token: the hopper puts the approved plan's saved file in the box, HOPPER_PLAN_FILE.
    const h = await hopper();
    const w = setup(h.url);
    writeFileSync(join(w.dir, 'saved.plan'), FILE);
    const box = { HOPPER_PLAN: PLAN, HOPPER_PLAN_FILE: join(w.dir, 'saved.plan'), HOPPER_URL: '', HOPPER_TOKEN_FILE: '' };
    const r = await w.run(['apply', '-auto-approve'], box);
    expect(r.code, r.stderr).toBe(0);
    expect(r.real).toEqual([`apply|-auto-approve|${join(w.dir, 'saved.plan')}|unset`]);
    expect(r.applied).toEqual([FILE]);
    expect(h.asked).toEqual([]);
    // The file the hopper put there is kept for the next apply of the step.
    expect(readFileSync(join(w.dir, 'saved.plan'))).toEqual(FILE);

    // A plan file the caller names must be that file.
    writeFileSync(join(w.dir, 'tf.plan'), FILE);
    expect((await w.run(['apply', 'tf.plan'], box)).code).toBe(0);
    writeFileSync(join(w.dir, 'other.plan'), Buffer.from('another plan'));
    expect((await w.run(['apply', 'other.plan'], box)).stderr).toMatch(/other\.plan is not the saved plan file of plan 3f2b8a7c/);
    // A file that is not there is a refusal, never a fetch.
    const gone = await w.run(['apply'], { ...box, HOPPER_PLAN_FILE: join(w.dir, 'gone.plan') });
    expect(gone.code).not.toBe(0);
    expect(gone.stderr).toMatch(/the saved file of plan 3f2b8a7c.* cannot be read/);
    expect(h.asked).toEqual([]);
  });

  it('a plan the hopper does not give is refused, saying why', async () => {
    const h = await hopper();
    const w = setup(h.url);
    const unknown = await w.run(['apply'], { HOPPER_PLAN: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain(`terraform apply: ${APPLY_WRAPPER_REFUSAL}`);
    expect(unknown.stderr).toMatch(/the hopper gives no saved plan file for plan 00000000-0000-4000-8000-000000000000 \(404\): no: no plan/);
    writeFileSync(join(w.dir, 'token'), 'another-token\n');
    expect((await w.run(['apply'], { HOPPER_PLAN: PLAN })).stderr).toMatch(/\(401\)/);
    expect((await w.run(['apply'], { HOPPER_PLAN: PLAN, HOPPER_URL: '' })).stderr).toMatch(/no way to the hopper/);
    // The hopper is not there.
    expect((await setup().run(['apply'], { HOPPER_PLAN: PLAN })).stderr).toMatch(/the hopper cannot be reached/);
    expect((await w.run(['version'])).real).toEqual(['version|unset']);
  });

  it('an apply flag that would change what the saved plan does is refused', async () => {
    const h = await hopper();
    const w = setup(h.url);
    for (const flag of ['-destroy', '-refresh-only', '-replace=aws_instance.a', '-target=aws_instance.a', '-var=a=b', '-var-file=x.tfvars', '-state=other', '-backup=x']) {
      const r = await w.run(['apply', flag], { HOPPER_PLAN: PLAN });
      expect(r.code, flag).not.toBe(0);
      expect(r.stderr, flag).toContain(`terraform apply ${flag}: ${APPLY_WRAPPER_REFUSAL}`);
    }
    expect((await w.run(['version'])).real).toEqual(['version|unset']);
    expect(h.asked).toEqual([]);
  });

  it('every other command that writes infrastructure or state is refused', async () => {
    const w = setup();
    const writes = [
      ['destroy', '-auto-approve'], ['import', 'aws_ssm_parameter.x', 'x'], ['refresh'], ['taint', 'x'], ['untaint', 'x'], ['force-unlock', '-force', 'id'],
      ['state', 'rm', 'x'], ['state', 'mv', 'a', 'b'], ['state', 'push', 'f'], ['state', 'replace-provider', 'a', 'b'], ['state', 'import', 'x'],
      ['workspace', 'delete', 'w'], ['-chdir=stack', 'destroy'],
    ];
    for (const args of writes) {
      const r = await w.run(args, { HOPPER_PLAN: PLAN });
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(r.stderr, args.join(' ')).toContain(APPLY_WRAPPER_REFUSAL);
    }
    expect((await w.run(['destroy'])).stderr).toMatch(/terraform destroy: refused by the apply wrapper\. .*plan -destroy/);
    expect((await w.run(['version'])).real).toEqual(['version|unset']);
  });
});
