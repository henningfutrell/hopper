// A database read on the vault's side (issue #2231, design.md "Database reads"). A job at work names a template, a
// database and one SELECT. As for a need step's mint, Access decides it for the template (`decideCheckMint`, the read
// as the check), so only a template a person approved for read on that database reads it; a deny mints nothing. The
// vault then mints a database read role from the database's minting credential, the hopper runs the SELECT with it, and drops it
// at the read's end, whatever happened; its `VALID UNTIL` and the sweep are the backstop. The role's password is made
// here and never leaves the hopper. `database.role_minted`, `database.role_dropped` and `database.read` record each step,
// with the job, the read, the database, the role, Access's decision and the expiry; the read carries its SQL. No
// password, no connection string and no row of the answer is recorded.
import { randomBytes } from 'node:crypto';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Asset, VaultAccess } from '../domain/access.ts';
import { databaseCredentialOf, DATABASE_ROLE_TTL_SECONDS, databaseRoleName, sqlProblem, type DatabaseMintingCredential, type DatabaseReader, type DatabaseReadResult } from '../domain/database-read.ts';
import { mintingCredentialFor } from '../domain/minting.ts';
import type { VaultSecret } from '../domain/vault.ts';
import { AT_WORK } from './box.ts';

/** A job's read: the template Access decides it for, the database, and its one SELECT. */
export interface DatabaseReadAsk { job: string; template: string; asset: Asset; sql: string }
/** The rows, or why there are none and the HTTP status that says so. */
export type DatabaseReadAnswer = DatabaseReadResult | { status: number; no: string };

export interface DatabaseReads {
  /** One read (issue #2231): Access, a database read role minted, the SELECT, the role dropped. Never rejects. */
  readDatabase(ask: DatabaseReadAsk): Promise<DatabaseReadAnswer>;
  /** Drops each database read role whose `VALID UNTIL` passed, in each database a minting credential mints for: at start and every few minutes. */
  sweepDatabaseRoles(): Promise<void>;
}

export function databaseReads(store: Pick<UserStore, 'vault' | 'events' | 'jobs' | 'tx'>, o: {
  access?: VaultAccess | undefined; reader: DatabaseReader; valueOf(secret: VaultSecret): Promise<{ value: string } | { refused: string }>; clock: Clock; logger: { warn(line: string): void };
}): DatabaseReads {
  const { vault, events } = store;
  const atWork = (job: string): boolean => AT_WORK.includes(store.jobs.get(job)?.status ?? '');

  /** The database's minting credential and its value read, or why there is none. */
  async function credentialOf(asset: Asset): Promise<{ secret: VaultSecret; credential: DatabaseMintingCredential } | { status: number; no: string }> {
    const secret = mintingCredentialFor(vault.list(), asset);
    if (typeof secret === 'string') return { status: 409, no: secret };
    const read = await o.valueOf(secret);
    if ('refused' in read) return { status: 503, no: `the minting credential ${secret.name}: ${read.refused}` };
    const credential = databaseCredentialOf(read.value);
    if (typeof credential === 'string') return { status: 409, no: `the minting credential ${secret.name}: ${credential}` };
    return { secret, credential };
  }

  return {
    async readDatabase({ job, template, asset, sql }) {
      const refuse = (status: number, reason: string, decision?: string): DatabaseReadAnswer => {
        events.append({ type: 'database.read_refused', jobId: job, data: { job, template, asset, reason, ...(decision ? { decision } : {}) } });
        return { status, no: reason };
      };
      if (!atWork(job)) return { status: 409, no: 'the job is not at work: the vault reads a database only while its job runs' };
      const bad = sqlProblem(sql);
      if (bad) return { status: 400, no: bad };
      if (asset.kind !== 'database') return { status: 400, no: `a database read names a database (database/<cluster>/<namespace>/<database>), not ${asset.kind} ${asset.name}` };
      if (!o.access) return refuse(503, 'access is not part of this hopper: the vault mints nothing without it');
      const id = randomBytes(8).toString('hex'), role = databaseRoleName(id);
      const decision = await o.access.decideCheckMint({ template, check: `database-read-${id}`, operation: 'read', asset });
      if (!decision.allowed) return refuse(403, `Access denied it: ${decision.reason}. A person approves read on database ${asset.name} for template ${template} on Access requests`, decision.id);
      const found = await credentialOf(asset);
      if ('no' in found) return refuse(found.status, found.no, decision.id);
      const { secret, credential: c } = found;
      // The database read role's login: made here, used here, never kept or said. Hidden from any message the database answers too.
      const password = randomBytes(24).toString('base64url');
      const hide = (m: string): string => m.split(password).join('***').split(c.password).join('***');
      const validUntil = new Date(o.clock.now().getTime() + DATABASE_ROLE_TTL_SECONDS * 1000);
      try {
        await o.reader.mint(c, { role, password, validUntil });
      } catch (e) {
        return refuse(502, `minting a database read role in database ${asset.name} failed: ${hide((e as Error).message)}`, decision.id);
      }
      const at = { job, read: id };
      events.append({ type: 'database.role_minted', jobId: job, data: { ...at, template, asset, credential: secret.name, role, decision: decision.id, expiresAt: validUntil.toISOString() } });
      const started = o.clock.now().getTime();
      let result: DatabaseReadResult | undefined, problem: string | undefined;
      try {
        // The minting login's own service took a while: the job must still be at work.
        if (!atWork(job)) problem = 'the job is not at work: the vault reads a database only while its job runs';
        else result = await o.reader.read(c, { role, password, sql });
      } catch (e) {
        problem = hide((e as Error).message);
      }
      try {
        await o.reader.drop(c, role);
        events.append({ type: 'database.role_dropped', jobId: job, data: { ...at, asset, credential: secret.name, role, reason: 'read-ended' } });
      } catch (e) {
        o.logger.warn(`hopper: database read ${id}: dropping ${role} in ${asset.name} failed, its VALID UNTIL and the sweep end it: ${hide((e as Error).message)}`);
      }
      const ms = o.clock.now().getTime() - started;
      events.append({ type: 'database.read', jobId: job, data: { ...at, template, asset, role, decision: decision.id, sql, ...(result ? { rows: result.rows, bytes: result.bytes } : { problem: problem ?? 'no answer' }), ms } });
      return result ?? { status: 502, no: `the read of database ${asset.name} failed: ${problem ?? 'no answer'}` };
    },

    async sweepDatabaseRoles() {
      for (const secret of vault.list().filter((s) => s.mints?.kind === 'database')) {
        const asset = secret.mints!;
        const found = await credentialOf(asset);
        if ('no' in found) continue;
        try {
          for (const role of await o.reader.sweep(found.credential)) {
            events.append({ type: 'database.role_dropped', data: { asset, credential: secret.name, role, reason: 'expired' } });
          }
        } catch (e) {
          o.logger.warn(`hopper: the sweep of database read roles in database ${asset.name} failed: ${(e as Error).message.split(found.credential.password).join('***')}`);
        }
      }
    },
  };
}
