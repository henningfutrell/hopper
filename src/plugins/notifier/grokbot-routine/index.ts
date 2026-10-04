// grokbot-routine: POSTs to a Grok Bot routine when a question reaches the human (design.md "Grok
// Bot routine webhook"). Detection looks at the env file only — never the Grok Bot app (an Electron
// GUI). A missing or unreadable file is needs-setup, and the notifier still runs: it reads the file
// at each event, so one written later applies without a restart.
import { expandHome } from '../../expand-home.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { createGrokBotNotifier } from './notifier.ts';

export interface GrokBotRoutineOptions { envFile: string }

const DEFAULT_ENV_FILE = '~/.config/job-hopper/grokbot-webhook.env';

const setupCommand = (file: string) =>
  `(umask 077; printf 'GROKBOT_WEBHOOK_URL=<routine webhook url>\\nGROKBOT_WEBHOOK_KEY=<routine key>\\n' > ${file}) and fill in both values`;

/** The plugin. `baseMs` (tests, `AppSeams.grokbotBaseMs`) shortens the retry backoff. */
export function grokbotRoutinePlugin(seam: { baseMs?: number } = {}): PluginDefinition<'notifier', GrokBotRoutineOptions> {
  return {
    id: 'grokbot-routine',
    role: 'notifier',
    describe: 'POSTs each question escalated to the human to a Grok Bot routine (URL and bearer key from an env file)',
    options: (z) => z.strictObject({
      // Holds the bearer key and the URL it is sent to: a UI session must not redirect it.
      envFile: z.string().min(1).default(DEFAULT_ENV_FILE)
        .meta({ commandBearing: true, description: 'env file with GROKBOT_WEBHOOK_URL= and GROKBOT_WEBHOOK_KEY=' }),
    }),
    async detect(sys, o) {
      const file = expandHome(o.envFile);
      if (!(await sys.exists(file))) return { status: 'needs-setup', reason: `no Grok Bot routine configured: ${file} not found`, command: setupCommand(file) };
      if (!(await sys.readable(file))) return { status: 'needs-setup', reason: `${file} is not readable`, command: `chmod 600 ${file}` };
      return { status: 'available', detail: file };
    },
    create: (ctx, o) => createGrokBotNotifier({
      name: ctx.instanceName, path: expandHome(o.envFile), logger: ctx.logger, ...(seam.baseMs ? { baseMs: seam.baseMs } : {}),
    }),
  };
}

export default grokbotRoutinePlugin();
