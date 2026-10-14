// The Windows link report from the command line (issue #712, design.md "Machine resources over time" → "The Windows
// link"): the keep-alive loop on Windows runs `hopper windows-link report` in the hopper's container with what Windows
// found when it opened the hopper's address check at localhost, else at 127.0.0.1 (`--link`, the URL that answered, else
// the localhost one: `--url` names the daemon, as for every
// operator action). One POST /ui/api/windows-link, an admin's. The loop keeps no credential:
// the CLI uses the container's.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';
import { WINDOWS_LINK_URL } from './domain/machine-history.ts';
import { MAX_WINDOWS_LINK_ERROR, NETWORKING_MODE } from './http/ui/windows-link.ts';

export const WINDOWS_LINK_USAGE = `  hopper windows-link report --link <url> (--status <n> | --error <text>) [--mode <mode>]
                                                     what Windows found when it opened the hopper at localhost, else 127.0.0.1: the HTTP status, or why it got no answer; the keep-alive loop on Windows reports it`;

const USAGE = 'windows-link report --link <url> (--status <n> | --error <text>) [--mode <mode>]';

export function windowsLinkCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { link: { type: 'string' }, status: { type: 'string' }, error: { type: 'string' }, mode: { type: 'string' } } });
  } catch (e) {
    throw new OperatorRefusal(`${(e as Error).message}; usage: hopper ${USAGE}`);
  }
  const { values: v, positionals } = parsed;
  if (positionals.length !== 1 || positionals[0] !== 'report' || !v.link || (v.status === undefined) === (v.error === undefined)) throw usage(USAGE);
  if (!WINDOWS_LINK_URL.test(v.link)) throw new OperatorRefusal(`--link ${v.link}: the address check at localhost or 127.0.0.1, http://localhost:<port>/job/address`);
  const mode = v.mode?.trim().toLowerCase();
  if (mode !== undefined && mode !== '' && !NETWORKING_MODE.test(mode)) throw new OperatorRefusal(`--mode ${v.mode}: a networking mode, as wslinfo says it (nat, mirrored)`);
  const status = v.status === undefined ? undefined : Number(v.status);
  if (status !== undefined && !(Number.isInteger(status) && status >= 100 && status <= 599)) throw new OperatorRefusal(`--status ${v.status}: an HTTP status, 100 to 599`);
  const error = v.error?.replace(/\s+/g, ' ').trim().slice(0, MAX_WINDOWS_LINK_ERROR) || 'no reason given';
  return {
    role: 'admin', path: '/ui/api/windows-link',
    body: async () => ({ url: v.link, ...(mode ? { mode } : {}), ...(status !== undefined ? { status } : { error }) }),
  };
}
