// A box step's vault secrets (issue #1875, src/sandbox/need-steps.ts, need-box.ts): a box step of a template that gives
// vault secrets gets them, read for the step through the vault's step delivery (its grant and checks), copied into its
// need box as files, never in its environment, and read there with "$HOPPER_SECRET" get NAME. The job never gets a
// value: the log is masked, and outputs that hold one are dropped. A runtime with no copy takes no secret. The need box
// runs the step's real script under `sh` at the container runtime double; the vault is a double at its seam.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { ContainerSpec } from '../../src/domain/ports.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { needEnv, NO_SECRET_COPY, runNeedBox, type NeedBox, type NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { createNeedSteps, OUTPUTS_HOLD_SECRET, type NeedStepsOptions } from '../../src/sandbox/need-steps.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { useTempStore } from '../store/helpers.ts';

const PASSWORD = 'kc-admin-pass-7f3a';
const USERS = '{"users":[{"name":"saml-user","password":"saml-pass-91c2"}]}';

const dirs: string[] = [];
const stores: InstanceStore[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of stores.splice(0)) s.close();
});
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

/** The runtime double: its one-shot containers run under `sh` with a home of their own; a copy into HOME goes there. */
function runtime(): FakeContainerRuntime {
  const r = createFakeContainerRuntime();
  const homes = new Map<string, string>();
  const homeOf = (name: string): string => { let h = homes.get(name); if (!h) { h = temp('secret-box-'); homes.set(name, h); } return h; };
  r.copyIn = async (id, dir, tar) => {
    const c = [...r.boxes.values()].find((b) => b.id === id);
    if (!c || c.state !== 'running') throw new Error(`the box ${id} is not running`);
    r.copies.push({ box: c.spec.name, dir });
    execFileSync('tar', ['-xf', tar, '-C', dir.replace(HOME, homeOf(c.spec.name))]);
  };
  r.runScript = (spec: ContainerSpec) => new Promise((resolve) => {
    execFile('sh', ['-c', spec.script ?? ''], { env: { ...spec.env, HOME: homeOf(spec.name), PATH: process.env.PATH }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ exit: err ? Number((err as { code?: number }).code ?? 1) : 0, output: stdout + stderr });
    });
  });
  return r;
}

const box = (command: string, secrets?: Record<string, string>) => ({
  name: 'hopper-need-asked-1-abcd', userId: 'u1', instanceId: 'i1', network: 'hopper_default', template: { image: 'ghcr.io/henningfutrell/hopper:box-test' },
  env: needEnv({ command, outputs: [], credentials: [] }), timeoutMs: 30_000, dir: temp('secret-dir-'), ...(secrets ? { files: { secrets } } : {}),
});
const io = (log: string[]) => ({ log: (c: string) => { log.push(c); }, signal: new AbortController().signal, pollMs: 10 });

describe('a need box with vault secrets (issue #1875)', () => {
  it('copies each secret in as a file of mode 600, read with "$HOPPER_SECRET" get NAME; none is in the box\'s environment', async () => {
    const r = runtime();
    const command = [
      'echo "pass=$("$HOPPER_SECRET" get keycloak-admin-password)"',
      '"$HOPPER_SECRET" get test-saml-idp-users; echo',
      'ls -l "$HOPPER_SECRETS_DIR" | grep -c "^-rw-------" || true',
      '"$HOPPER_SECRET" get nothing-here; echo "exit=$?"',
      'env | grep -c "kc-admin" || true',
    ].join('\n');
    const log: string[] = [];
    const result = await runNeedBox(r, box(command, { 'keycloak-admin-password': PASSWORD, 'test-saml-idp-users': USERS }), io(log));
    const text = log.join('');
    expect(result, text).toEqual({ exit: 0 });
    expect(text).toContain(`pass=${PASSWORD}`);
    expect(text).toContain(USERS);
    expect(text).toMatch(/^2$/m);
    expect(text).toContain('exit=2');
    expect(text).toContain('NAME one of: keycloak-admin-password test-saml-idp-users');
    expect(text).toMatch(/^0$/m);
    const [spec] = [...r.ran.values()];
    expect(spec!.env.HOPPER_STEP_FILES).toBe('copy');
    expect(JSON.stringify(spec!.env)).not.toContain(PASSWORD);
    expect(spec!.script).not.toContain(PASSWORD);
    expect(r.boxes.size).toBe(0);
  });

  it('a runtime with no copy (a machine\'s) takes no secret: the step does not run', async () => {
    const r = runtime();
    r.copyIn = undefined;
    const result = await runNeedBox(r, box('true', { 'keycloak-admin-password': PASSWORD }), io([]));
    expect(result).toEqual({ exit: 125, problem: NO_SECRET_COPY });
    expect(r.ran.size).toBe(0);
  });
});

describe('a box step of a template that gives vault secrets (issue #1875)', () => {
  const store = useTempStore();
  const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
  const READY = {
    name: 'asked-e2e', image: 'ghcr.io/henningfutrell/hopper:box-test', profiles: [], egress: ['auth.dev.example:443'], agentCredential: 'claude-token',
    secrets: ['keycloak-admin-password', 'test-saml-idp-users', 'shared/team-key', 'claude-token'],
    gives: ['keycloak-admin-password', 'test-saml-idp-users', 'shared/team-key', 'claude-token'],
    approval: { by: 'a person' }, pending: { secrets: [], image: false, egress: [], profiles: [] },
  } as unknown as TemplateView;
  const VALUES: Record<string, string> = { 'keycloak-admin-password': PASSWORD, 'test-saml-idp-users': USERS };

  function boxSteps(o: { templates?: () => TemplateView[]; secret?: NeedStepsOptions['secret']; run?: (box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: { log(chunk: string): void }) => Promise<NeedBoxResult> } = {}) {
    const instance = openInstanceStore({ url: store.url(), clock: { now: () => new Date() } });
    stores.push(instance);
    const events: NewEvent[] = [];
    const asked: unknown[] = [];
    const boxes: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>[] = [];
    const released: string[] = [];
    const given: (Record<string, string> | undefined)[] = [];
    const s = createNeedSteps({
      userId: 'admin', dir: temp('box-step-'), record: (e) => { events.push(e); }, log: () => {}, planFile: () => undefined,
      templates: o.templates ?? (() => [READY]), mint: async () => ({ refused: 'no mint here' }), release: async (b) => { released.push(b); },
      steps: instance.needSteps, ran: () => false, atWork: () => true, sagas: { begin: (step) => `saga-${step}`, abort: () => true },
      secret: o.secret ?? (async (a) => { asked.push(a); return { value: VALUES[a.name]! }; }),
      run: async (b, i) => {
        // What the box was given, as it was then: the step wipes its secrets once the box ends.
        boxes.push(structuredClone(b));
        given.push(b.files?.secrets);
        return o.run ? o.run(b, i) : { exit: 0 };
      },
    });
    const go = async (command: string, outputs: string[] = []) => {
      const started = s.box(JOB, { box: 'asked-e2e', approved: ['asked-e2e'], command, outputs, secrets: [] }, { key: `k-${Math.random()}`, inputs: Buffer.alloc(0) });
      if ('no' in started) throw new Error(started.no);
      await s.run(started.id, new AbortController().signal);
      const state = s.state(JOB, started.id);
      if (!state || 'running' in state) throw new Error('the step did not end');
      return { ...state, id: started.id, log: s.log(JOB, started.id, 0)!.text };
    };
    return { s, events, asked, boxes, released, given, go };
  }

  it('reads each secret the template gives for the step, in its need box, and gives them to the box only', async () => {
    const { asked, boxes, events, given, go } = boxSteps();
    const r = await go('python3 org_sso_e2e.py --env dev');
    expect(r.result).toEqual({ exit: 0 });
    // A shared secret and the agent credential are not a step's: only the template's own secrets are read.
    expect(asked).toEqual([
      { name: 'keycloak-admin-password', job: JOB.id, host: boxes[0]!.name, template: 'asked-e2e' },
      { name: 'test-saml-idp-users', job: JOB.id, host: boxes[0]!.name, template: 'asked-e2e' },
    ]);
    expect(boxes[0]!.files).toEqual({ secrets: VALUES });
    expect(given[0]).toEqual({});
    expect(JSON.stringify(boxes[0]!.env)).not.toContain(PASSWORD);
    expect(boxes[0]!.template.egress).toEqual(['auth.dev.example:443']);
    const started = events.find((e) => e.type === 'step.started')!;
    expect(started.data).toMatchObject({ secrets: ['keycloak-admin-password', 'test-saml-idp-users'] });
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
  });

  it('masks each secret\'s value in the log the job reads', async () => {
    const { go } = boxSteps({ run: async (_b, i) => { i.log(`logged in with ${PASSWORD}\n`); return { exit: 0 }; } });
    const r = await go('true');
    expect(r.log).toBe('logged in with ***\n');
  });

  it('drops outputs that hold a secret\'s value, and says so; outputs without one come back', async () => {
    const leak = boxSteps({ run: async () => ({ exit: 0, outputs: Buffer.from(`report.txt\0${PASSWORD}`) }) });
    const r = await leak.go('true', ['report.txt']);
    expect(r.result).toEqual({ exit: 0, problem: OUTPUTS_HOLD_SECRET });
    expect('outputs' in r).toBe(false);
    const clean = boxSteps({ run: async () => ({ exit: 0, outputs: Buffer.from('report.txt\0passed') }) });
    expect((await clean.go('true', ['report.txt'])).result).toEqual({ exit: 0, outputsBytes: 17 });
  });

  it('a secret the vault refuses (no vault grant) ends the step refused, saying why; no box runs', async () => {
    const { boxes, events, released, go } = boxSteps({ secret: async () => ({ refused: 'job job-1 has no vault grant: a person grants it the vault' }) });
    const r = await go('true');
    expect(r.result).toEqual({ exit: 125, problem: 'keycloak-admin-password: job job-1 has no vault grant: a person grants it the vault' });
    expect(boxes).toEqual([]);
    expect(released).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.refused')).toHaveLength(1);
  });

  it('a secret the template no longer gives when the step runs is refused, and the vault is not asked', async () => {
    let templates = [READY];
    const { asked, boxes, s } = boxSteps({ templates: () => templates });
    const started = s.box(JOB, { box: 'asked-e2e', approved: ['asked-e2e'], command: 'true', outputs: [], secrets: [] }, { key: 'k-gone', inputs: Buffer.alloc(0) });
    if ('no' in started) throw new Error(started.no);
    templates = [{ ...READY, gives: ['test-saml-idp-users'] } as TemplateView];
    await s.run(started.id, new AbortController().signal);
    expect(s.state(JOB, started.id)).toEqual({ result: { exit: 125, problem: 'keycloak-admin-password: template asked-e2e does not give keycloak-admin-password now' } });
    expect(asked).toEqual([]);
    expect(boxes).toEqual([]);
  });
});
