// One user's need steps (issue #1007, design.md "Need steps"): a running job names what its step needs
// (`read/aws-role/<account>/<role>`), and the hopper runs that one command in a need box of a template that covers the
// needs, with credentials minted for that step only, then gives the job the output, the exit code and the outputs. The
// job stays on its own machine; no credential ever reaches it.
//
// The template: one the user has that is ready — approved, its image the approved one, every profile approved, its
// read-only check passed when it takes one — and declares every need, more needs too: the step is minted only what it
// asked for, so a wider template gives the step nothing more. The one with the fewest profiles wins. When none covers
// the needs, the job's route asks for the template as `sandbox-template` does (src/skills/template-request.ts), which
// makes it once and never twice, and the step waits until it is ready.
//
// A box step (issue #1349) is a need step too: a job whose sandbox request of a template was approved names that template
// (`sh "$HOPPER_STEP" box <template>`), and the step runs in a need box of it, minted each of the template's profiles the
// vault mints — its reads, and with an approved plan (`--plan-id`) its changes too. Each step gets a sandbox of its own,
// which is burned after it: no box waits between steps, and none joins as a machine.
//
// Recorded on the job's timeline as a Windows step is (`step.started`, `step.finished`, `step.refused`), the need box
// as its `box`; the result and the outputs are kept an hour for the job to fetch, then swept. The sandbox module keeps
// each need box in the sandbox runs ledger (issue #1349).
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationProfile } from '../domain/access.ts';
import { mintKindFor, type Minted, type MintReach } from '../domain/minting.ts';
import { checkWait } from '../domain/read-only-check.ts';
import type { Job, NewEvent } from '../domain/types.ts';
import type { TemplateView } from '../domain/vault.ts';
import { STEP_INPUTS_MAX_BYTES, stepRequestOf, type StepResult } from '../domain/windows-steps.ts';
import { maskSecrets, STEP_KEEP_MS, type StepStart } from '../windows-steps/service.ts';
import { needEnv, needSecrets, type NeedBox, type NeedBoxResult, type NeedCredential } from './need-box.ts';

/** The most of a step's command an event keeps. */
const COMMAND_IN_EVENT = 300;
const ID = /^[a-f0-9-]{36}$/;

const keyOf = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;

/** Whether a step may run in a box of the template now: approved, its image approved, every profile approved, its check passed. */
export const ready = (t: TemplateView): boolean => t.approval !== undefined && !t.pending.image && t.pending.profiles.length === 0 && checkWait(t) === undefined;

/** The ready template that declares every need, the one with the fewest profiles first; undefined: none. */
export function coveringTemplate(templates: readonly TemplateView[], needs: readonly OperationProfile[]): TemplateView | undefined {
  const wanted = needs.map(keyOf);
  return templates
    .filter((t) => ready(t) && wanted.every((k) => t.profiles.some((p) => keyOf(p) === k)))
    .sort((a, b) => a.profiles.length - b.profiles.length || a.name.localeCompare(b.name))[0];
}

export interface NeedStepsOptions {
  /** The user's templates now, as the vault shows them. */
  templates(): TemplateView[];
  /** The vault's mint for one need of the need box `step` (src/vault/need-mint.ts, given by the composition root); `plan`: the approved plan a change applies. */
  mint(ask: { template: string; step: string; job: string; profile: OperationProfile; plan?: string }): Promise<{ minted: Minted; reach: MintReach } | { refused: string }>;
  /** The saved plan file of an infra plan, as the hopper keeps it (src/infra-plans/service.ts); undefined: none. */
  planFile(id: string): Buffer | undefined;
  /** Runs the need box (the sandbox module's `needStep`), `run` naming its job and step for the ledger; absent: this hopper runs no need box. */
  run?: (box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: { log(chunk: string): void; signal: AbortSignal }, run: { jobId: string; step: string; template: string }) => Promise<NeedBoxResult>;
  /** Where each step's own directory goes on this machine: the hopper's work dir (scratch). */
  dir: string;
  record(event: NewEvent): void;
  log(line: string): void;
  newId?: () => string;
  keepMs?: number;
}

/** A Linux step's fields as the job sent them, its needs read already, and the template that covers them. */
export interface NeedStepFields { template: TemplateView; needs: OperationProfile[]; command?: string; timeout?: string; outputs: string[]; plan?: string }

/** A box step's fields as the job sent them (issue #1349): the template it names, and the templates of its approved sandbox requests. */
export interface BoxStepFields { box: string; approved: readonly string[]; command?: string; timeout?: string; outputs: string[]; plan?: string; secrets: readonly string[] }

/**
 * What a box step of the template is minted (issue #1349): each profile the vault mints for a step — an aws-role, a
 * cluster or a namespace —, its reads only, and every one with an approved plan to apply.
 */
export const boxNeeds = (t: TemplateView, plan: string | undefined): OperationProfile[] =>
  t.profiles.filter((p) => mintKindFor(p.asset.kind) !== undefined && (plan !== undefined || p.operation === 'read'));

export interface NeedSteps {
  /** The ready template that covers the needs; undefined: none yet. */
  covering(needs: readonly OperationProfile[]): TemplateView | undefined;
  /** Check `fields` for `job` and mint its credentials: a step to run, or a no with its HTTP status. A no is a `step.refused` event. */
  start(job: Job, fields: NeedStepFields): Promise<StepStart | { status: number; no: string }>;
  /** A box step (issue #1349): a need step in a sandbox of a template the job's sandbox request was approved for. */
  box(job: Job, fields: BoxStepFields): Promise<StepStart | { status: number; no: string }>;
  /** A step's result, with its outputs tar when it has one; undefined: no step of this job's by that id, or swept. */
  result(job: Job, id: string): { result: StepResult; outputs?: string } | undefined;
  /** Remove results older than the keep. */
  sweep(): void;
}

export function createNeedSteps(o: NeedStepsOptions): NeedSteps {
  const newId = o.newId ?? (() => randomUUID());
  const keepMs = o.keepMs ?? STEP_KEEP_MS;
  const results = new Map<string, { jobId: string; result: StepResult; at: number }>();
  const dirOf = (id: string) => join(o.dir, id);

  const refuse = (job: Job, status: number, no: string, box?: string) => {
    o.record({ type: 'step.refused', jobId: job.id, data: { reason: no, ...(box ? { box } : {}) } });
    return { status, no };
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, r] of results) if (now - r.at > keepMs) { results.delete(id); rmSync(dirOf(id), { recursive: true, force: true }); }
    let names: string[];
    try { names = readdirSync(o.dir); } catch { return; }
    for (const name of names) {
      if (results.has(name)) continue;
      try { if (now - statSync(dirOf(name)).mtimeMs > keepMs) rmSync(dirOf(name), { recursive: true, force: true }); } catch { /* gone */ }
    }
  };

  const start: NeedSteps['start'] = async (job, fields) => {
    sweep();
    const { template: t, needs } = fields;
    if (!fields.command || fields.command.trim() === '') return refuse(job, 400, 'give the command to run (sh): --command TEXT or --script FILE');
    const request = stepRequestOf({ host: t.name, command: fields.command, ...(fields.timeout !== undefined ? { timeout: fields.timeout } : {}), outputs: fields.outputs });
    if ('problem' in request) return refuse(job, 400, request.problem);
    if (!o.run) return refuse(job, 503, 'this hopper runs no sandbox step: it is given no container runtime (docs/deploy.md "Sandboxes the hopper starts")');
    const id = newId();
    const box = `hopper-need-${t.name}-${id.slice(0, 8)}`;
    // Minted now, before the inputs come: a no costs the job no upload. Held in memory for this step only.
    const credentials: NeedCredential[] = [];
    for (const profile of needs) {
      const r = await o.mint({ template: t.name, step: box, job: job.id, profile, ...(fields.plan ? { plan: fields.plan } : {}) });
      if ('refused' in r) return refuse(job, 403, `${keyOf(profile)}: ${r.refused}`, box);
      credentials.push({ profile, minted: r.minted, reach: r.reach });
    }
    const dir = dirOf(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The apply wrapper in the need box applies only this file: the box holds no proxy token to fetch it (issue #1007).
    const planFile = fields.plan ? o.planFile(fields.plan) : undefined;
    const run = o.run;
    return {
      id, request, inputsFile: join(dir, 'inputs.tar'),
      drop(reason) {
        credentials.length = 0;
        rmSync(dir, { recursive: true, force: true });
        refuse(job, 400, reason, box);
      },
      async run({ inputsBytes, log: toJob, signal }) {
        const masked = maskSecrets(needSecrets(credentials), toJob);
        const started = Date.now();
        o.record({ type: 'step.started', jobId: job.id, data: {
          step: id, box, template: t.name, needs: needs.map(keyOf), command: request.command.slice(0, COMMAND_IN_EVENT), timeoutSeconds: request.timeoutSeconds,
          inputsBytes, outputs: request.outputs,
        } });
        let result: StepResult;
        try {
          const env = needEnv({ command: request.command, outputs: request.outputs, ...(fields.plan ? { plan: fields.plan } : {}), credentials });
          const files = { ...(inputsBytes > 0 ? { inputs: join(dir, 'inputs.tar') } : {}), ...(planFile ? { plan: planFile } : {}) };
          const r = await run({
            name: box, template: { image: t.image, ...(t.tools ? { tools: t.tools } : {}), ...(t.readOnly ? { readOnly: true } : {}), ...(t.limits ? { limits: t.limits } : {}) }, env, timeoutMs: request.timeoutSeconds * 1000,
            dir, ...(Object.keys(files).length > 0 ? { files } : {}),
          }, { log: masked.write, signal }, { jobId: job.id, step: id, template: t.name });
          if (r.outputs) writeFileSync(join(dir, 'outputs.tar'), r.outputs, { mode: 0o600 });
          result = { exit: r.exit, ...(r.outputs ? { outputsBytes: r.outputs.length } : {}), ...(r.problem ? { problem: r.problem } : {}) };
        } catch (e) {
          o.log(`hopper: sandbox step ${id} in ${box}: ${(e as Error).message}`);
          result = { exit: 125, problem: (e as Error).message };
        } finally {
          masked.end();
          credentials.length = 0;
          rmSync(join(dir, 'inputs.tar'), { force: true });
        }
        if (/timed out|did not end/.test(result.problem ?? '')) result = { ...result, problem: `timed out after ${request.timeoutSeconds} s` };
        o.record({ type: 'step.finished', jobId: job.id, data: {
          step: id, box, exit: result.exit, seconds: Math.round((Date.now() - started) / 1000),
          ...(result.outputsBytes !== undefined ? { outputsBytes: result.outputsBytes } : {}), ...(result.problem ? { problem: result.problem } : {}),
        } });
        results.set(id, { jobId: job.id, result, at: Date.now() });
        return result;
      },
    };
  };

  return {
    covering: (needs) => coveringTemplate(o.templates(), needs),
    sweep,
    start,

    async box(job, fields) {
      const { box } = fields;
      if (!fields.approved.includes(box)) {
        const named = fields.approved.length ? `Its approved sandboxes: ${fields.approved.join(', ')}.` : 'It has none: ask the hopper for one with sh "$HOPPER_SKILL" sandbox.';
        return refuse(job, 404, `this job has no approved sandbox of template ${box}. ${named}`, box);
      }
      if (fields.secrets.length > 0) return refuse(job, 400, 'a box step takes no --secret: its sandbox is minted what its template gives', box);
      const t = o.templates().find((x) => x.name === box);
      if (!t || !ready(t)) return refuse(job, 409, `template ${box} is not ready now: ${t ? 'something of it waits for a person or for its read-only check' : 'it is not there any more'}`, box);
      return start(job, {
        template: t, needs: boxNeeds(t, fields.plan), outputs: fields.outputs,
        ...(fields.command !== undefined ? { command: fields.command } : {}), ...(fields.timeout !== undefined ? { timeout: fields.timeout } : {}), ...(fields.plan !== undefined ? { plan: fields.plan } : {}),
      });
    },

    result(job, id) {
      if (!ID.test(id)) return undefined;
      const r = results.get(id);
      if (!r || r.jobId !== job.id) return undefined;
      return { result: r.result, ...(r.result.outputsBytes !== undefined ? { outputs: join(dirOf(id), 'outputs.tar') } : {}) };
    },
  };
}

/** The most a Linux step's inputs may hold: as a Windows step's, copied into the need box (a machine's runtime takes 64 KiB). */
export const NEED_STEP_INPUTS_MAX_BYTES = STEP_INPUTS_MAX_BYTES;
