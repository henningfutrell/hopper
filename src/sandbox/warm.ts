// The tools image built ahead of the first step (issue #1737; design.md "Tools assembled per run"). The first need step
// of a template paid the build of its tools image, 10 to 60 s, and a download that failed in that build failed the step.
// The warm pass gets the image of each approved template with tools ready where its steps run (the check's place), so a
// step finds it there. A template a read-only check is due for is left to the check, which builds the same image. Each
// image is looked at again after WARM_EVERY_MS, so one the leftover-builds pass removed is built again; a build that
// fails is logged and tried again after WARM_RETRY_MS.
import { imageApproved, type Template } from '../domain/vault.ts';
import { boxImage } from './box-image.ts';
import { dueForCheck, type CheckPlace } from './check.ts';
import { LOCAL } from './runtime.ts';

/** How often a warmed tools image is looked at again. */
export const WARM_EVERY_MS = 60 * 60_000;
/** How soon a tools image that did not build is tried again. */
export const WARM_RETRY_MS = 5 * 60_000;

export interface WarmContext {
  /** Where the user's steps run now (the check's place); undefined: nowhere, and nothing is warmed. */
  place(userId: string): Promise<CheckPlace | undefined>;
  templates(): { userId: string; template: Template }[];
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}

/** The warm pass: each template that wants it, one after the other. */
export function createWarmPass(c: WarmContext): () => Promise<void> {
  /** When each image was last looked at, and whether it is ready; by user, machine and what the image is. */
  const seen = new Map<string, { at: number; ok: boolean }>();
  return async () => {
    const now = c.clock.now();
    for (const { userId, template: t } of c.templates()) {
      if (!t.tools?.length || !imageApproved(t) || dueForCheck(t, now)) continue;
      const at = await c.place(userId);
      if (!at) continue;
      const key = JSON.stringify([userId, at.machine, t.image, [...t.tools].sort(), t.readOnly === true]);
      const last = seen.get(key);
      if (last && now.getTime() - last.at < (last.ok ? WARM_EVERY_MS : WARM_RETRY_MS)) continue;
      const ok = await boxImage(at.runtime, t.image, t.tools, t.readOnly).then(() => true, (e: unknown) => {
        c.logger.warn(`hopper: the tools image of template ${t.name} is not ready${at.machine === LOCAL ? '' : ` on ${at.machine}`}; it is tried again in ${WARM_RETRY_MS / 60_000} min: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      });
      seen.set(key, { at: now.getTime(), ok });
    }
  };
}
