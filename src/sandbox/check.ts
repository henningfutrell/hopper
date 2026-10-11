// The read-only check's runs (issue #716, item 4; design.md "The read-only check"). A template that needs a check (a job
// asked for it with read needs only), approved, with no check of its current version, gets one: the hopper runs the
// probes for its needs in a check box — the template's image with its tools, under the sandbox flags, its probe script
// in place of the entrypoint — and keeps the result on the template. One check at a time. A check box carries its own
// label, not the box label: the reconcile pass leaves it, and this pass removes one no run holds (a hopper stopped
// mid-check). It gets no vault secret and no minted credential: see design.md for what that leaves to issue #715.
import type { ProbeCatalog, ReadOnlyCheck } from '../domain/read-only-check.ts';
import { currentCheck } from '../domain/read-only-check.ts';
import type { ContainerRuntime, ResourceLimits } from '../domain/sandboxes.ts';
import { imageApproved, type Template } from '../domain/vault.ts';
import { checkScript, readResults } from './check-script.ts';
import { boxImage, USER_LABEL } from './launch.ts';
import { DEFAULT_LIMITS } from './params.ts';

/** The label on every check box: its value is the hopper's instance id. */
export const CHECK_LABEL = 'io.hopper.check';
/** How long a whole check may run. */
export const CHECK_MS = 30 * 60_000;
const LIMITS: ResourceLimits = { cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default };

/** The templates the check pass reads, of every user, and where it keeps a check. */
export interface CheckTemplates {
  templates(): { userId: string; template: Template }[];
  /** Keeps the check on the user's template, when the template is still at the check's version. */
  record(userId: string, name: string, check: ReadOnlyCheck): Promise<void>;
}

export interface CheckContext {
  runtime: ContainerRuntime;
  instanceId: string;
  network: string;
  probes: ProbeCatalog;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}

/**
 * Whether the template gets a check now: it needs one, its image is approved, and its version has none — or one still
 * `running`, which a pass finds only when a hopper stopped mid-check: passes run one after the other.
 */
export function dueForCheck(t: Template): boolean {
  const state = currentCheck(t)?.state;
  return t.readOnly === true && imageApproved(t) && state !== 'passed' && state !== 'failed';
}

/** One check of the template's current version, in a check box; the box and its volume are removed after it. */
export async function runCheck(c: CheckContext, userId: string, t: Template, name: string): Promise<ReadOnlyCheck> {
  const runs = c.probes.runsFor((t.profiles ?? []).filter((p) => p.operation === 'read'));
  const ended = (state: 'passed' | 'failed', probes: ReadOnlyCheck['probes'], problem?: string): ReadOnlyCheck =>
    ({ version: t.savedAt, state, at: c.clock.now().toISOString(), probes, ...(problem ? { problem } : {}) });
  if (runs.length === 0) return ended('failed', [], 'no probe checks its needs: it cannot pass');
  const labels = { [CHECK_LABEL]: c.instanceId, [USER_LABEL]: userId };
  const volume = `${name}-home`;
  let id = '';
  try {
    const { image, user } = await boxImage(c.runtime, t.image, t.tools);
    await c.runtime.createVolume(volume, labels);
    id = await c.runtime.create({ name, image, network: c.network, volume, labels, user, env: {}, limits: LIMITS, script: checkScript(runs) });
    await c.runtime.start(id);
    const exit = await c.runtime.wait(id, CHECK_MS);
    const probes = readResults(runs, await c.runtime.logs(id));
    // Every probe passed and the script ended well, or it failed: a script cut short is no pass.
    const passed = exit === 0 && probes.every((p) => p.passed);
    return ended(passed ? 'passed' : 'failed', probes, exit !== 0 ? `the check box ended with ${exit}` : undefined);
  } catch (e) {
    return ended('failed', [], `the check box did not run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (id) await c.runtime.remove(id).catch(() => {});
    await c.runtime.removeVolume(volume).catch(() => {});
  }
}

/** The check pass: removes check boxes no run holds, then checks each template that is due, one after the other. */
export function createCheckPass(c: CheckContext, templates: CheckTemplates): () => Promise<void> {
  const holds = new Set<string>();
  let n = 0;
  return async () => {
    for (const box of await c.runtime.list({ [CHECK_LABEL]: c.instanceId })) {
      if (holds.has(box.name)) continue;
      await c.runtime.remove(box.id).catch(() => {});
      await c.runtime.removeVolume(`${box.name}-home`).catch(() => {});
    }
    for (const { userId, template: t } of templates.templates()) {
      if (!dueForCheck(t)) continue;
      const name = `hopper-check-${t.name}-${Date.now().toString(36)}${(n++).toString(36)}`;
      holds.add(name);
      try {
        await templates.record(userId, t.name, { version: t.savedAt, state: 'running', at: c.clock.now().toISOString(), probes: [] });
        const check = await runCheck(c, userId, t, name);
        await templates.record(userId, t.name, check);
        c.logger.info(`hopper: the read-only check of template ${t.name} ${check.state}`);
      } finally {
        holds.delete(name);
      }
    }
  };
}

/** The check pass's templates over the users' runtimes: each one's own templates, read and kept in their own vault. */
export const usersTemplates = (all: () => readonly { user: { id: string }; store: { vault: { templates(): Template[] } }; vault: { recordCheck(name: string, check: ReadOnlyCheck): boolean } }[]): CheckTemplates => ({
  templates: () => all().flatMap((rt) => rt.store.vault.templates().map((template) => ({ userId: rt.user.id, template }))),
  record: async (userId, name, check) => { all().find((rt) => rt.user.id === userId)?.vault.recordCheck(name, check); },
});
