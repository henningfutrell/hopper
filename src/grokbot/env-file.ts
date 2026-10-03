// Reads the Grok Bot routine webhook env file. Read at every matching event, so a file
// created or edited after daemon start takes effect without a restart.
import { readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';

export type GrokBotEnv =
  | { kind: 'absent' }
  | { kind: 'ready'; url: string; key: string; /** Mode readable by group or other. */ looseMode: boolean }
  | { kind: 'invalid'; reason: string };

export function readGrokBotEnv(path: string): GrokBotEnv {
  let text: string;
  let mode: number;
  try {
    text = readFileSync(path, 'utf8');
    mode = statSync(path).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', reason: `unreadable: ${(e as NodeJS.ErrnoException).code ?? 'error'}` };
  }
  const env = parseEnv(text);
  const url = env.GROKBOT_WEBHOOK_URL?.trim();
  const key = env.GROKBOT_WEBHOOK_KEY?.trim();
  const missing = [url ? '' : 'GROKBOT_WEBHOOK_URL', key ? '' : 'GROKBOT_WEBHOOK_KEY'].filter(Boolean);
  if (!url || !key) return { kind: 'invalid', reason: `missing ${missing.join(', ')}` };
  return { kind: 'ready', url, key, looseMode: (mode & 0o077) !== 0 };
}
