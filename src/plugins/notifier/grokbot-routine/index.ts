// grokbot-routine: POSTs to a Grok Bot routine when a question reaches the human (design.md "Grok
// Bot routine webhook"). The routine's URL and bearer key are secrets in the daemon's environment
// (design.md "Secrets"), named by the options. Detection looks at those variables only — never the
// Grok Bot app (an Electron GUI). Unset is needs-setup, and the notifier still runs: it reads them at
// each event and sends nothing while either is unset.
import type { PluginDefinition } from '../../sdk.ts';
import { createGrokBotNotifier } from './notifier.ts';

export interface GrokBotRoutineOptions { urlEnv: string; keyEnv: string }

/** The plugin. `baseMs` (tests, `AppSeams.grokbotBaseMs`) shortens the retry backoff. */
export function grokbotRoutinePlugin(seam: { baseMs?: number } = {}): PluginDefinition<'notifier', GrokBotRoutineOptions> {
  return {
    id: 'grokbot-routine',
    role: 'notifier',
    describe: 'POSTs each question escalated to the human to a Grok Bot routine (URL and bearer key from the environment)',
    options: (z) => z.strictObject({
      // Name where the bearer key comes from and the URL it is sent to: a UI session must not redirect them.
      urlEnv: z.string().min(1).default('GROKBOT_WEBHOOK_URL')
        .meta({ commandBearing: true, description: 'environment variable holding the routine webhook URL' }),
      keyEnv: z.string().min(1).default('GROKBOT_WEBHOOK_KEY')
        .meta({ commandBearing: true, description: 'environment variable holding the routine bearer key' }),
    }),
    async detect(sys, o) {
      const missing = [o.urlEnv, o.keyEnv].filter((n) => !sys.env(n)?.trim());
      if (missing.length) {
        return { status: 'needs-setup', reason: `no Grok Bot routine configured: ${missing.join(', ')} not set`, command: `set ${missing.join(' and ')} in the daemon's environment (both from the routine's Webhook panel)` };
      }
      return { status: 'available', detail: `${o.urlEnv}, ${o.keyEnv}` };
    },
    create: (ctx, o) => createGrokBotNotifier({
      name: ctx.instanceName, logger: ctx.logger, routine: () => ({ url: ctx.env(o.urlEnv)?.trim(), key: ctx.env(o.keyEnv)?.trim() }),
      ...(seam.baseMs ? { baseMs: seam.baseMs } : {}),
    }),
  };
}

export default grokbotRoutinePlugin();
