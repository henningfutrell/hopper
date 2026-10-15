// The last accounts (issue #1269, design.md "Last account"): who each machine's agent tool was last signed in as, so a login of
// that tool on that machine says who to sign in as. Read from the usage sources' accounts (`claude auth status`), only while
// the tool reads signed in: a signed-out read keeps the one before. The logins' sweep records them at each tick, so a sign-in
// that completed, which its source reads again at once, is kept a tick later. Only the label — identity, organization, when — is kept, in the database; never a token.
import { LAST_ACCOUNT_TOOLS, type LastAccount, type LastAccountRepository, type Login, type UsageSourceReport } from '../domain/types.ts';

export interface LastAccounts {
  /** Keep each machine's account the usage sources read signed in now; one the same as kept, read no later, is not written again. */
  record(): void;
  /**
   * What a login shows: the last account of its tool on its machine, `null` when none was ever read there, `undefined` for a login with no machine or of a tool whose account is not read.
   */
  of(login: Pick<Login, 'machineId' | 'tool'>): LastAccount | null | undefined;
}

/** The service a login's tool names: its command, without a path or arguments (`claude auth login` → `claude`). */
export const serviceOfTool = (tool: string): string => (tool.trim().split(/\s+/)[0] ?? '').split('/').at(-1)!.toLowerCase();

export function createLastAccounts(o: { repo: LastAccountRepository; sources: () => UsageSourceReport[] }): LastAccounts {
  const record = (): void => {
    for (const s of o.sources()) {
      const a = s.account;
      const machineId = typeof a?.detail.machine === 'string' ? a.detail.machine : undefined;
      if (!a?.identity || a.signedOut || !machineId || !s.accountReadAt) continue;
      const organization = typeof a.detail.organization === 'string' ? a.detail.organization : undefined;
      const had = o.repo.get(machineId, a.service);
      if (had && had.identity === a.identity && had.organization === organization && had.capturedAt >= s.accountReadAt) continue;
      o.repo.put({ machineId, service: a.service, identity: a.identity, ...(organization ? { organization } : {}), capturedAt: s.accountReadAt });
    }
  };
  return {
    record,
    of(login) {
      const service = serviceOfTool(login.tool);
      if (!login.machineId || !(LAST_ACCOUNT_TOOLS as readonly string[]).includes(service)) return undefined;
      return o.repo.get(login.machineId, service) ?? null;
    },
  };
}
