// The TL;DR's model (issue #569): Claude Haiku through the `claude` CLI in print mode, locked down as an escalation
// level's run is (`src/plugins/claude-print.ts`): no tools, no MCP, no settings, no session, the answer bound to a
// JSON Schema, the prompt on stdin, in the user's work dir. Jev (issue #550) is not asked: it picks one of a decision's
// options and writes no text. No `claude`, no login, a timeout: an error, never a throw — the card shows the agent's
// own summary then.
import { z } from 'zod';
import type { TldrWriter } from '../domain/types.ts';
import { claudePrint } from '../plugins/claude-print.ts';
import { createTldrs, type Tldrs, type TldrsOptions } from './service.ts';

export type { Tldrs } from './service.ts';

/** The cheap tier's alias: whichever Haiku the `claude` CLI resolves it to. */
export const TLDR_MODEL = 'haiku';
export const TLDR_TIMEOUT_MS = 60_000;

const SCHEMA = { type: 'object', properties: { tldr: { type: 'string' } }, required: ['tldr'], additionalProperties: false };
const reply = z.object({ tldr: z.string() });

export function createHaikuWriter(o: { cwd: string; userEnv?: Readonly<Record<string, string>>; bin?: string; timeoutMs?: number }): TldrWriter {
  return async (prompt, signal) => {
    const r = await claudePrint({
      bin: o.bin ?? 'claude', model: TLDR_MODEL, cwd: o.cwd, timeoutMs: o.timeoutMs ?? TLDR_TIMEOUT_MS, jsonSchema: SCHEMA,
      ...(o.userEnv ? { userEnv: o.userEnv } : {}),
    }, reply, prompt, signal);
    return 'error' in r ? r : { text: r.tldr, ...(r.model ? { model: r.model } : {}) };
  };
}

/** The TL;DR sweep of one user (`createTldrs`), over their store, with Haiku unless a double is given (tests). */
export function openTldrs(o: Omit<TldrsOptions, 'writer' | 'timeoutMs'> & { cwd: string; userEnv?: Readonly<Record<string, string>>; writer?: TldrWriter }): Tldrs {
  const { cwd, userEnv, writer, ...rest } = o;
  return createTldrs({ ...rest, timeoutMs: TLDR_TIMEOUT_MS, writer: writer ?? createHaikuWriter({ cwd, ...(userEnv ? { userEnv } : {}) }) });
}
