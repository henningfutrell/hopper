// grokbot-routine: POSTs to a Grok Bot routine when a question reaches the human (design.md "Grok
// Bot routine webhook"). The routine's URL and bearer key are secrets from the runtime (design.md
// "Secrets"), named by the options: the variable, or the mounted file `<name>_FILE` names, read at
// each use — so a file written or changed later applies without a restart (issue #378). Detection
// looks at those only — never the Grok Bot app (an Electron GUI). Unset is needs-setup, and the
// notifier still runs: it sends nothing until both are given, then offers the open questions.
import type { PluginDefinition } from '../../sdk.ts';
import { createGrokBotNotifier, type Routine } from './notifier.ts';

export interface GrokBotRoutineOptions { urlEnv: string; keyEnv: string }

/**
 * The routine from the runtime's values now, or why there is none, naming the variables as the runtime
 * reads them (`secretName`: with the user's secret prefix). Never the key.
 */
export function routineFrom(rt: { env(name: string): string | undefined; secretName(name: string): string }, o: GrokBotRoutineOptions): Routine {
  const values: string[] = [];
  const missing: string[] = [];
  for (const name of [o.urlEnv, o.keyEnv]) {
    let v: string | undefined;
    try {
      v = rt.env(name)?.trim();
    } catch (e) {
      return { problem: e instanceof Error ? e.message : String(e) };
    }
    if (v) values.push(v); else missing.push(rt.secretName(name));
  }
  if (missing.length) return { problem: `no Grok Bot routine configured: ${missing.join(', ')} not set` };
  return { url: values[0]!, key: values[1]! };
}

/** The plugin. `baseMs` and `watchMs` (tests, `AppSeams.grokbot`) shorten the retry backoff and the configured check. */
export function grokbotRoutinePlugin(seam: { baseMs?: number; watchMs?: number } = {}): PluginDefinition<'notifier', GrokBotRoutineOptions> {
  return {
    id: 'grokbot-routine',
    role: 'notifier',
    describe: 'POSTs each question escalated to the human to a Grok Bot routine (URL and bearer key from the runtime: a variable or a mounted file)',
    options: (z) => z.strictObject({
      // Name where the bearer key comes from and the URL it is sent to: a UI session must not redirect them.
      urlEnv: z.string().min(1).default('GROKBOT_WEBHOOK_URL')
        .meta({ commandBearing: true, description: 'runtime secret holding the routine webhook URL: the variable, or the file <name>_FILE names' }),
      keyEnv: z.string().min(1).default('GROKBOT_WEBHOOK_KEY')
        .meta({ commandBearing: true, description: 'runtime secret holding the routine bearer key: the variable, or the file <name>_FILE names' }),
    }),
    async detect(sys, o) {
      const r = routineFrom(sys, o);
      const [url, key] = [sys.secretName(o.urlEnv), sys.secretName(o.keyEnv)];
      if ('problem' in r) {
        return { status: 'needs-setup', reason: r.problem, command: `give ${url} and ${key} in the runtime, or set ${url}_FILE and ${key}_FILE to files holding them, read at each use (both values from the routine's Webhook panel)` };
      }
      return { status: 'available', detail: `${url}, ${key}` };
    },
    create: (ctx, o) => createGrokBotNotifier({
      name: ctx.instanceName, logger: ctx.logger, clock: ctx.clock, routine: () => routineFrom(ctx, o),
      ...(seam.baseMs ? { baseMs: seam.baseMs } : {}),
      ...(seam.watchMs ? { watchMs: seam.watchMs } : {}),
    }),
  };
}

export default grokbotRoutinePlugin();
