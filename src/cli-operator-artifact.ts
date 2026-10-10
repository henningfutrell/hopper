// `hopper artifact …` (issue #673, design.md "Artifacts"): the user's artifacts from the operator CLI — list, get, share
// with another user or as a public link, revoke a share, remove, list the revisions and restore one (issue #675) — each
// the UI's own read or `POST /ui/api/artifacts/…`.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const ARTIFACT_USAGE = `  hopper artifact list                               the user's artifacts, newest first, each with its shares and link
  hopper artifact get <id>                           one artifact: its details, shares and link
  hopper artifact share <id> --with <name> | --public [--hours <n>]
                                                     share it with another user, or make a public link (said once)
  hopper artifact revoke <id> <share>                end a share: the user no longer sees it, or the link stops at once
  hopper artifact revisions <id>                     its revisions, newest first: number, time, who made it, note
  hopper artifact restore <id> <n>                   revision n is the latest again, as a new revision
  hopper artifact rm <id>                            remove it, every revision and every share of it`;

const ARTIFACT_SHARE = 'artifact share <id> --with <name> | --public [--hours <n>]';
const ARTIFACT_RESTORE = 'artifact restore <id> <n>';

export function artifactCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { with: { type: 'string' }, public: { type: 'boolean' }, hours: { type: 'string' } } });
  const [verb, id, ...rest] = positionals;
  const flags = values.with !== undefined || values.public !== undefined || values.hours !== undefined;
  if (verb === 'list' && !id && !flags) return { role: 'viewer', path: '/api/artifacts', pick: (v) => ({ artifacts: (v as { artifacts: unknown[] }).artifacts }) };
  if (!id) throw usage(verb === 'restore' ? ARTIFACT_RESTORE : 'artifact list | get <id> | revisions <id> | restore <id> <n> | share <id> … | revoke <id> <share> | rm <id>');
  const at = `/ui/api/artifacts/${encodeURIComponent(id)}`;
  if (verb === 'get' && rest.length === 0 && !flags) return { role: 'viewer', path: `/api/artifacts/${encodeURIComponent(id)}` };
  if (verb === 'revisions' && rest.length === 0 && !flags) return { role: 'viewer', path: `/api/artifacts/${encodeURIComponent(id)}/revisions` };
  if (verb === 'restore') {
    const n = rest.length === 1 && !flags ? Number(rest[0]) : Number.NaN;
    if (Number.isNaN(n)) throw usage(ARTIFACT_RESTORE);
    if (!Number.isInteger(n) || n < 1) throw new OperatorRefusal(`a revision is a whole number of at least 1, not ${rest[0]}`);
    return { role: 'operator', path: `${at}/restore`, body: async () => ({ revision: n }) };
  }
  if (verb === 'rm' && rest.length === 0 && !flags) return { role: 'operator', path: `${at}/remove`, body: async () => ({}) };
  if (verb === 'revoke' && rest.length === 1 && !flags) return { role: 'operator', path: `${at}/shares/${encodeURIComponent(rest[0]!)}/revoke`, body: async () => ({}) };
  if (verb === 'share' && rest.length === 0) {
    // `--with`, not `--user`: `--user` names the user the CLI acts as.
    if (values.with !== undefined && !values.public && values.hours === undefined) return { role: 'operator', path: `${at}/share`, body: async () => ({ user: values.with }) };
    if (values.public && values.with === undefined) {
      const hours = values.hours === undefined ? undefined : Number(values.hours);
      if (hours !== undefined && (!Number.isInteger(hours) || hours < 1)) throw new OperatorRefusal(`--hours must be a whole number of at least 1, not ${values.hours}`);
      return { role: 'operator', path: `${at}/share`, body: async () => ({ link: true, ...(hours === undefined ? {} : { hours }) }) };
    }
    throw usage(ARTIFACT_SHARE);
  }
  throw usage('artifact list | get <id> | revisions <id> | restore <id> <n> | share <id> … | revoke <id> <share> | rm <id>');
}

