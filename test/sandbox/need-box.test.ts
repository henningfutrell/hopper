// A need step's box (issue #1007, src/sandbox/need-box.ts): the box's environment from the minted credentials, and
// one need box run to its end at the container runtime double, whose one-shot container runs the step's real script
// under `sh` with a home of its own: the credentials into files and out of the environment, the inputs extracted, the
// command's output streamed, its exit code, the outputs back as a tar, and the box and its volume gone after it. The
// inputs and the saved plan file come by a copy into the box, or, from a runtime with no copy, in its environment.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerSpec } from '../../src/domain/ports.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { runNeedBox, shownSoFar, splitOutput, needEnv, needSecrets, NEED_LABEL, type NeedCredential, type NeedFiles } from '../../src/sandbox/need-box.ts';
import { coveringTemplate } from '../../src/sandbox/need-steps.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';

const AWS: NeedCredential = {
  profile: { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } },
  minted: { kind: 'aws', AccessKeyId: 'ASIASTEP', SecretAccessKey: 'step-secret-key', SessionToken: 'step-session-token', Expiration: '2030-01-01T00:15:00Z' },
  reach: { kind: 'aws', region: 'eu-west-1' },
};
const KUBE: NeedCredential = {
  profile: { operation: 'read', asset: { kind: 'namespace', name: 'lab/web' } },
  minted: { kind: 'kube', token: 'step-kube-token', expirationTimestamp: '2030-01-01T00:10:00Z' },
  reach: { kind: 'kube', server: 'https://lab.example:6443', certificateAuthorityData: 'Q0E=' },
};

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

/**
 * The runtime double, its one-shot containers run under `sh` with the box's environment and a home of their own; a copy
 * into the box's HOME goes into that home.
 */
function runtime(): FakeContainerRuntime {
  const r = createFakeContainerRuntime();
  const homes = new Map<string, string>();
  const homeOf = (name: string): string => { let h = homes.get(name); if (!h) { h = temp('step-box-'); homes.set(name, h); } return h; };
  r.copyIn = async (id, dir, tar) => {
    const c = [...r.boxes.values()].find((b) => b.id === id);
    if (!c || c.state !== 'running') throw new Error(`the box ${id} is not running`);
    r.copies.push({ box: c.spec.name, dir });
    execFileSync('tar', ['-xf', tar, '-C', dir.replace(HOME, homeOf(c.spec.name))]);
  };
  r.runScript = (spec: ContainerSpec) => new Promise((resolve) => {
    const home = homeOf(spec.name);
    execFile('sh', ['-c', spec.script ?? ''], { env: { ...spec.env, HOME: home, PATH: process.env.PATH }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ exit: err ? Number((err as { code?: number }).code ?? 1) : 0, output: stdout + stderr });
    });
  });
  return r;
}

const box = (env: Record<string, string>, files?: NeedFiles) => ({ name: 'hopper-need-asked-1-abcd', userId: 'u1', instanceId: 'i1', network: 'hopper_default', template: { image: 'ghcr.io/henningfutrell/hopper:box-claude' }, env, timeoutMs: 30_000, dir: temp('step-dir-'), ...(files ? { files } : {}) });

describe('a need step\'s box (issue #1007)', () => {
  it('one AWS role is the AWS CLI\'s own variables and a profile; each cluster or namespace a kubeconfig context', () => {
    const env = needEnv({ command: 'aws sts get-caller-identity', outputs: ['out'], credentials: [AWS, KUBE] });
    expect(env).toMatchObject({
      HOPPER_STEP_COMMAND: 'aws sts get-caller-identity', HOPPER_STEP_OUTPUTS: 'out',
      AWS_ACCESS_KEY_ID: 'ASIASTEP', AWS_SECRET_ACCESS_KEY: 'step-secret-key', AWS_SESSION_TOKEN: 'step-session-token', AWS_REGION: 'eu-west-1', AWS_PROFILE: '123456789012-readonly',
    });
    expect(env.HOPPER_STEP_AWS_CREDENTIALS).toContain('[123456789012-readonly]\naws_access_key_id = ASIASTEP');
    expect(env.HOPPER_STEP_AWS_CONFIG).toContain('[profile 123456789012-readonly]\nregion = eu-west-1');
    expect(JSON.parse(env.HOPPER_STEP_KUBECONFIG!)).toMatchObject({
      'current-context': 'lab-web', users: [{ name: 'lab-web', user: { token: 'step-kube-token' } }],
      clusters: [{ name: 'lab-web', cluster: { server: 'https://lab.example:6443', 'certificate-authority-data': 'Q0E=' } }],
      contexts: [{ name: 'lab-web', context: { cluster: 'lab-web', user: 'lab-web', namespace: 'web' } }],
    });
    expect(needSecrets([AWS, KUBE])).toEqual(['step-secret-key', 'step-session-token', 'ASIASTEP', 'step-kube-token']);
    // Two AWS roles: profiles only, the first AWS_PROFILE; no AWS CLI variables that would pick one of them.
    const two = needEnv({ command: 'x', outputs: [], credentials: [AWS, { ...AWS, profile: { operation: 'read', asset: { kind: 'aws-role', name: '210987654321/readonly' } } }] });
    expect(two.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(two.AWS_PROFILE).toBe('123456789012-readonly');
    expect(two.HOPPER_STEP_AWS_CREDENTIALS).toContain('[210987654321-readonly]');
  });

  it('runs the command with the credentials in files, its inputs extracted, its output streamed; its outputs come back; the box goes', async () => {
    const r = runtime();
    const src = temp('step-inputs-');
    mkdirSync(join(src, 'in'));
    writeFileSync(join(src, 'in', 'query.txt'), 'pods\n');
    const inputs = join(src, 'inputs.tar');
    execFileSync('tar', ['-cf', inputs, '-C', src, 'in']);
    const command = [
      'echo "asked for $(cat in/query.txt)"',
      'env | grep -c HOPPER_STEP_ || true',
      'test -s "$AWS_SHARED_CREDENTIALS_FILE" && grep -q step-session-token "$AWS_SHARED_CREDENTIALS_FILE" && echo aws-file',
      'grep -q step-kube-token "$KUBECONFIG" && echo kube-file',
      'mkdir -p out && echo report > out/report.txt',
      'exit 3',
    ].join('\n');
    const log: string[] = [];
    const result = await runNeedBox(r, box(needEnv({ command, outputs: ['out', 'missing'], credentials: [AWS, KUBE] }), { inputs }), { log: (c) => log.push(c), signal: new AbortController().signal, pollMs: 10 });
    expect(result.exit).toBe(3);
    expect(result.problem).toBeUndefined();
    const text = log.join('');
    expect(text).toContain('asked for pods');
    expect(text).toMatch(/^0$/m);
    expect(text).toContain('aws-file');
    expect(text).toContain('kube-file');
    expect(text).not.toContain('HOPPER-STEP-OUTPUTS');
    expect(text).toContain('missing');
    const out = temp('step-outputs-');
    writeFileSync(join(out, 'o.tar'), result.outputs!);
    execFileSync('tar', ['-xf', join(out, 'o.tar'), '-C', out]);
    expect(readFileSync(join(out, 'out', 'report.txt'), 'utf8')).toBe('report\n');
    const [spec] = [...r.ran.values()];
    expect(spec!.labels[NEED_LABEL]).toBe('i1');
    expect(spec!.script).not.toContain('step-session-token');
    expect(r.boxes.size).toBe(0);
    expect(r.volumes.size).toBe(0);
  });

  it('inputs over 64 KiB and the saved plan file come by a copy into the box, never in its environment', async () => {
    const r = runtime();
    const src = temp('step-inputs-');
    mkdirSync(join(src, 'in'));
    const big = Buffer.alloc(300 * 1024, 'x');
    writeFileSync(join(src, 'in', 'big.bin'), big);
    const inputs = join(src, 'inputs.tar');
    execFileSync('tar', ['-cf', inputs, '-C', src, 'in']);
    const plan = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255]);
    const command = [
      'wc -c < in/big.bin',
      'echo "plan $HOPPER_PLAN"',
      'od -An -tx1 "$HOPPER_PLAN_FILE" | tr -d " \\n"; echo',
      'env | grep -c HOPPER_STEP_ || true',
    ].join('\n');
    const log: string[] = [];
    const result = await runNeedBox(r, box(needEnv({ command, outputs: [], plan: '3f2b8a7c-1d4e-4f6a-9b0c-2d3e4f5a6b7c', credentials: [AWS] }), { inputs, plan }), { log: (c) => log.push(c), signal: new AbortController().signal, pollMs: 10 });
    const text = log.join('');
    expect(result, text).toEqual({ exit: 0 });
    expect(text).toContain(`${big.length}`);
    expect(text).toContain('plan 3f2b8a7c-1d4e-4f6a-9b0c-2d3e4f5a6b7c');
    expect(text).toContain('504b0304000102ff');
    expect(text).toMatch(/^0$/m);
    const [spec] = [...r.ran.values()];
    expect(spec!.env.HOPPER_STEP_FILES).toBe('copy');
    expect(JSON.stringify(spec!.env).length).toBeLessThan(16 * 1024);
    // Into the box, as the box's user: the plan file, the inputs into the work directory, then the mark that all are there.
    expect(r.copies).toEqual([{ box: spec!.name, dir: HOME }, { box: spec!.name, dir: `${HOME}/work` }, { box: spec!.name, dir: HOME }]);
  });

  it('a runtime with no copy (a machine\'s): the files in the environment up to 64 KiB; more is a problem, and no box runs', async () => {
    const r = runtime();
    r.copyIn = undefined;
    const src = temp('step-inputs-');
    writeFileSync(join(src, 'small.txt'), 'small\n');
    const small = join(src, 'inputs.tar');
    execFileSync('tar', ['-cf', small, '-C', src, 'small.txt']);
    const log: string[] = [];
    const ok = await runNeedBox(r, box(needEnv({ command: 'cat small.txt', outputs: [], credentials: [] }), { inputs: small }), { log: (c) => log.push(c), signal: new AbortController().signal, pollMs: 10 });
    expect(ok, log.join('')).toEqual({ exit: 0 });
    expect(log.join('')).toContain('small');

    const big = await runNeedBox(r, box(needEnv({ command: 'true', outputs: [], credentials: [] }), { plan: Buffer.alloc(100 * 1024) }), { log: () => {}, signal: new AbortController().signal, pollMs: 10 });
    expect(big.exit).toBe(125);
    expect(big.problem).toMatch(/the inputs and the plan file hold 100 KiB: a need box on a machine of the user's takes at most 64 KiB/);
    expect(r.ran.size).toBe(1);
  });

  it('a step the job stops waiting for is stopped and removed', async () => {
    const r = runtime();
    const stop = new AbortController();
    const running = runNeedBox(r, box(needEnv({ command: 'sleep 2', outputs: [], credentials: [] })), { log: () => {}, signal: stop.signal, pollMs: 10 });
    setTimeout(() => stop.abort(), 100);
    expect(await running).toEqual({ exit: 125, problem: 'the job stopped waiting for it', stopped: 'cancelled' });
    expect(r.boxes.size).toBe(0);
  });

  it('a step that runs past its time limit is stopped and removed, as timed out (issue #1371)', async () => {
    const r = runtime();
    const running = runNeedBox(r, { ...box(needEnv({ command: 'sleep 2', outputs: [], credentials: [] })), timeoutMs: 100 }, { log: () => {}, signal: new AbortController().signal, pollMs: 10 });
    expect(await running).toEqual({ exit: 125, problem: 'the need box did not end in 0.1 s', stopped: 'timed-out' });
    expect(r.boxes.size).toBe(0);
    expect(r.volumes.size).toBe(0);
  });

  it('a home volume that is there already is not the step\'s: no box runs, and the volume stays (issue #1371)', async () => {
    const r = runtime();
    r.volumes.add('hopper-need-asked-1-abcd-home');
    expect(await runNeedBox(r, box(needEnv({ command: 'true', outputs: [], credentials: [] })), { log: () => {}, signal: new AbortController().signal })).toEqual({
      exit: 125, problem: 'the need box did not run: its home volume hopper-need-asked-1-abcd-home is there already: a sandbox starts only on a fresh home',
    });
    expect(r.ran.size).toBe(0);
    expect(r.volumes.has('hopper-need-asked-1-abcd-home')).toBe(true);
  });

  it('a later step of the same template sees nothing an earlier one wrote (issue #1371)', async () => {
    const r = runtime();
    const run = (name: string, command: string) => runNeedBox(r, { ...box(needEnv({ command, outputs: [], credentials: [] })), name }, { log: () => {}, signal: new AbortController().signal, pollMs: 10 });
    expect((await run('hopper-need-asked-1-aaaa', 'echo first > "$HOME/marker"')).exit).toBe(0);
    expect(r.boxes.size).toBe(0);
    expect(r.volumes.size).toBe(0);
    const later = await run('hopper-need-asked-1-bbbb', 'test ! -e "$HOME/marker"');
    expect(later.exit).toBe(0);
    expect(r.volumes.size).toBe(0);
  });

  it('a box that does not start is a problem, never a throw', async () => {
    const r = runtime();
    r.createFails = 'no such image';
    expect(await runNeedBox(r, box({}), { log: () => {}, signal: new AbortController().signal })).toEqual({ exit: 125, problem: 'the need box did not run: no such image' });
  });

  it('a tools image that does not build is said to be the hopper\'s image build, not the command (issue #1737)', async () => {
    const r = runtime();
    r.buildFails = 'podman could not build localhost/hopper-box-tools:0123456789abcdef: exit status 6';
    const ran = await runNeedBox(r, { ...box({}), template: { image: 'ghcr.io/henningfutrell/hopper:box-claude', tools: ['kubectl'] } }, { log: () => {}, signal: new AbortController().signal });
    expect(ran).toEqual({ exit: 125, problem: 'the need box did not run: the hopper could not build the box\'s tools image, so the command did not run (a failure of the hopper, not of the command; run the step again): podman could not build localhost/hopper-box-tools:0123456789abcdef: exit status 6' });
  });

  it('the step gives the time of each part: the image, the box start, and the run (issue #1737)', async () => {
    const r = runtime();
    const times: { image?: number; start?: number; run?: number }[] = [];
    const ran = await runNeedBox(r, { ...box({ HOPPER_STEP_COMMAND: 'true', HOPPER_STEP_OUTPUTS: '' }), template: { image: 'ghcr.io/henningfutrell/hopper:box-claude', tools: ['kubectl'] } }, { log: () => {}, signal: new AbortController().signal, phases: (p) => times.push(p) });
    expect(ran.exit).toBe(0);
    expect(times).toEqual([{ image: expect.any(Number), start: expect.any(Number), run: expect.any(Number) }]);
    // A build that fails ends the step after the image part.
    r.buildFails = 'exit status 6';
    r.images.clear();
    await runNeedBox(r, { ...box({}), template: { image: 'ghcr.io/henningfutrell/hopper:box-claude', tools: ['kubectl'] } }, { log: () => {}, signal: new AbortController().signal, phases: (p) => times.push(p) });
    expect(times[1]).toEqual({ image: expect.any(Number) });
  });

  it('the job never reads the outputs, nor a tail that may begin their mark', () => {
    expect(shownSoFar('line\nHOPPER-STEP-OUT')).toBe('line');
    expect(shownSoFar('line\nHOPPER-STEP-OUTPUTS\nAAAA')).toBe('line');
    expect(shownSoFar('all of it')).toBe('all of it');
    // A line's end may begin the mark: held back until the next output, or the end.
    expect(shownSoFar('all of it\n')).toBe('all of it');
    expect(shownSoFar('all of it\r\n\r')).toBe('all of it\r\n');
    const tar = Buffer.from('a tar').toString('base64');
    const sha = sha256(Buffer.from('a tar'));
    expect(splitOutput(`done\r\n\r\nHOPPER-STEP-OUTPUTS\r\n${tar}\r\nHOPPER-STEP-SHA256 ${sha}\r\nHOPPER-STEP-END\r\ntar: missing: No such file\r\n`)).toEqual({ log: 'done\r\ntar: missing: No such file\r\n', outputs: Buffer.from('a tar'), outputsSha256: sha });
    // A log cut short (issue #2406: journald drops a large output) says how much came, and the limit.
    expect(splitOutput('done\nHOPPER-STEP-OUTPUTS\nAAAA\nAAAA').problem).toBe('the outputs did not all come back: the box\'s log ends after 6 bytes of them (the limit is 16 MiB); its container runtime did not keep all of its log');
  });

  it('outputs that differ from their sha256 in the box are a problem, never given; so are outputs with no sha256 (issue #2288)', () => {
    const tar = Buffer.from('a tar of the outputs');
    const lines = tar.toString('base64').match(/.{1,4}/g)!;
    // One line lost on the way, as in the issue: the same tar less 3 bytes.
    const damaged = splitOutput(`done\nHOPPER-STEP-OUTPUTS\n${lines.filter((_, n) => n !== 2).join('\n')}\nHOPPER-STEP-SHA256 ${sha256(tar)}\nHOPPER-STEP-END\n`);
    expect(damaged.outputs).toBeUndefined();
    expect(damaged.problem).toMatch(new RegExp(`^the outputs came back damaged: their sha256 in the box is ${sha256(tar)}, here [0-9a-f]{64}$`));
    expect(damaged.log).toBe('done');
    const unsigned = splitOutput(`done\nHOPPER-STEP-OUTPUTS\n${tar.toString('base64')}\nHOPPER-STEP-SHA256 \nHOPPER-STEP-END\n`);
    expect(unsigned.outputs).toBeUndefined();
    expect(unsigned.problem).toBe('the box gave no sha256 of the outputs (its image has no sha256sum): they could not be checked');
  });

  it('a 1 MB output comes back byte for byte, with its sha256 (issue #2288)', async () => {
    const r = runtime();
    const src = temp('step-big-');
    const data = Buffer.concat(Array.from({ length: 16 }, () => Buffer.from(`${randomBytes(48 * 1024).toString('base64')}\n`)));
    writeFileSync(join(src, 'rendered.yaml'), data);
    execFileSync('tar', ['-cf', join(src, 'in.tar'), '-C', src, 'rendered.yaml']);
    const result = await runNeedBox(r, box(needEnv({ command: 'true', outputs: ['rendered.yaml'], credentials: [] }), { inputs: join(src, 'in.tar') }), { log: () => {}, signal: new AbortController().signal, pollMs: 10 });
    expect(result.problem).toBeUndefined();
    expect(data.length).toBeGreaterThan(1_000_000);
    expect(result.outputsSha256).toBe(sha256(result.outputs!));
    const out = temp('step-big-out-');
    writeFileSync(join(out, 'o.tar'), result.outputs!);
    execFileSync('tar', ['-xf', join(out, 'o.tar'), '-C', out]);
    expect(sha256(readFileSync(join(out, 'rendered.yaml')))).toBe(sha256(data));
  });

  it('outputs over the limit are not sent: the step says their size and the limit (issue #2406)', async () => {
    const r = runtime();
    const command = 'head -c 9437184 /dev/zero > a.bin && head -c 8388608 /dev/zero > b.bin && echo small > c.txt';
    const log: string[] = [];
    const result = await runNeedBox(r, box(needEnv({ command, outputs: ['a.bin', 'b.bin', 'c.txt'], credentials: [] })), { log: (c) => log.push(c), signal: new AbortController().signal, pollMs: 10 });
    expect(result.exit).toBe(0);
    expect(result.outputs).toBeUndefined();
    expect(result.problem).toMatch(/^the outputs total \d+ bytes, over the limit of 16 MiB \(16777216 bytes\): none were sent back; bring back less, or split it over more steps$/);
    expect(Number(/total (\d+)/.exec(result.problem!)![1])).toBeGreaterThan(9437184 + 8388608);
    expect(log.join('')).not.toContain('HOPPER-STEP');
  });

  it('a log that lost a line of the outputs is read again; lost again, the step fails with no outputs (issue #2288)', async () => {
    const dropLine = (text: string): string => {
      const at = text.indexOf('HOPPER-STEP-OUTPUTS\n') + 'HOPPER-STEP-OUTPUTS\n'.length;
      const lines = text.slice(at).split('\n');
      lines.splice(Math.floor(lines.length / 2), 1);
      return text.slice(0, at) + lines.join('\n');
    };
    const run = async (lossy: (read: number) => boolean) => {
      const r = runtime();
      const logs = r.logs.bind(r);
      let reads = 0;
      // Only the reads after the box ended: the hopper's polls before it read nothing of the outputs.
      r.logs = async (id) => { const text = await logs(id); if (!text.includes('HOPPER-STEP-END')) return text; reads++; return lossy(reads) ? dropLine(text) : text; };
      const command = 'awk \'BEGIN { for (i = 0; i < 20000; i++) printf "line %06d of the rendered chart\\n", i }\' > rendered.yaml';
      return runNeedBox(r, box(needEnv({ command, outputs: ['rendered.yaml'], credentials: [] })), { log: () => {}, signal: new AbortController().signal, pollMs: 10 });
    };
    const once = await run((n) => n === 1);
    expect(once.problem).toBeUndefined();
    expect(once.outputsSha256).toBe(sha256(once.outputs!));
    const always = await run(() => true);
    expect(always.exit).toBe(0);
    expect(always.outputs).toBeUndefined();
    expect(always.outputsSha256).toBeUndefined();
    expect(always.problem).toMatch(/^the outputs came back damaged: their sha256 in the box is [0-9a-f]{64}, here [0-9a-f]{64}$/);
  });
});

describe('the template a Linux step runs in (issue #1007)', () => {
  const view = (name: string, profiles: string[], o: Partial<TemplateView> = {}): TemplateView => ({
    name, image: 'img', secrets: [], savedBy: 'x', savedAt: '2026-10-13T00:00:00Z',
    profiles: profiles.map((p) => { const [operation, kind, ...rest] = p.split('/'); return { operation, asset: { kind, name: rest.join('/') } }; }) as TemplateView['profiles'],
    pending: { secrets: [], image: false, egress: [], profiles: [] }, gives: [], radius: { level: 'low', reasons: [] } as unknown as TemplateView['radius'],
    approval: { image: 'img', secrets: [], by: 'a person', at: '2026-10-13T00:00:00Z' }, ...o,
  });
  const need = [{ operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } }] as const;

  it('takes a ready template that declares every need, more too; the one with the fewest profiles first', () => {
    const wide = view('wide', ['read/aws-role/123456789012/readonly', 'read/cluster/lab', 'read/cluster/prod']);
    const narrow = view('narrow', ['read/aws-role/123456789012/readonly', 'read/cluster/lab']);
    expect(coveringTemplate([wide, narrow], need, 'job-1')?.name).toBe('narrow');
    expect(coveringTemplate([wide], need, 'job-1')?.name).toBe('wide');
    expect(coveringTemplate([view('other', ['read/cluster/lab'])], need, 'job-1')).toBeUndefined();
  });

  it('never one that waits: not approved, its image changed, a profile not approved, or its read-only check not passed', () => {
    const p = ['read/aws-role/123456789012/readonly'];
    const { approval: _a, ...never } = view('never', p);
    expect(coveringTemplate([never as TemplateView], need, 'job-1')).toBeUndefined();
    expect(coveringTemplate([view('image', p, { pending: { secrets: [], image: true, egress: [], profiles: [] } })], need, 'job-1')).toBeUndefined();
    expect(coveringTemplate([view('profile', p, { pending: { secrets: [], image: false, egress: [], profiles: [need[0]] } })], need, 'job-1')).toBeUndefined();
    expect(coveringTemplate([view('check', p, { readOnly: true })], need, 'job-1')).toBeUndefined();
    expect(coveringTemplate([view('checked', p, { readOnly: true, check: { version: '2026-10-13T00:00:00Z', state: 'passed', at: '2026-10-13T00:00:00Z', probes: [] } })], need, 'job-1')?.name).toBe('checked');
  });
});
