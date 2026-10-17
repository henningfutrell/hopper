// File an issue's drafter (issue #471): the user's own `claude` CLI, signed in to their Claude account, running the
// file-issue run skill (`draftIssue`, src/run-skills/draft.ts, issue #472) in print mode, locked down as an escalation
// level's run is: no tools, no MCP, no settings, no session, the answer bound to the skill's JSON Schema, the prompt on
// stdin, in the user's work dir, with the user's CLI config dirs. The hopper holds no model credential for it. No
// `claude`, no login, a timeout: an error, never a throw.
import { ISSUE_DRAFT_PROVIDER, ISSUE_DRAFT_TIMEOUT_MS } from '../domain/issue-drafts.ts';
import { createDetectionKit } from '../plugins/detect.ts';
import { draftIssue } from '../run-skills/draft.ts';
import type { IssueDrafter } from './service.ts';

/** The model alias the drafting run asks for: whichever Sonnet the `claude` CLI resolves it to. */
export const ISSUE_DRAFT_MODEL = 'sonnet';

export function createClaudeDrafter(o: { cwd: string; userEnv?: Readonly<Record<string, string>>; bin?: string; timeoutMs?: number }): IssueDrafter {
  const bin = o.bin ?? 'claude';
  return {
    provider: ISSUE_DRAFT_PROVIDER,
    available: async () => ((await createDetectionKit().which(bin))
      ? { ok: true }
      : { ok: false, reason: `Claude is not installed on the hopper's machine (no ${bin} on its PATH): install the claude CLI and sign it in from Accounts` }),
    draft: async (skill, input, signal) => {
      const r = await draftIssue({
        bin, model: ISSUE_DRAFT_MODEL, cwd: o.cwd, timeoutMs: o.timeoutMs ?? ISSUE_DRAFT_TIMEOUT_MS, ...(o.userEnv ? { userEnv: o.userEnv } : {}),
      }, input, signal, skill);
      return 'error' in r ? r : { ...r.draft, ...(r.model ? { model: r.model } : {}) };
    },
  };
}
