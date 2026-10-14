// A job's ask for a secret in the vault's system scope (issue #657): Access decides, every time, and a model edit that
// would allow it still gives nothing — no job, machine or template reads a system secret. The reason the job is told.
import type { VaultAccess } from '../domain/access.ts';

export async function systemReadRefusal(access: VaultAccess | undefined, userId: string, jobId: string, row: string): Promise<string> {
  const name = row.slice(row.indexOf('/') + 1);
  const d = await access?.decideSystemSecret({ requester: { kind: 'job', userId, jobId }, owner: userId, name, action: 'read' });
  return d && !d.allowed ? d.reason : `${row} is in the vault's system scope: the hopper keeps it for its own use and never gives it to a job`;
}
