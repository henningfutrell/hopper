// The database ask (issue #2231, design.md "Database reads"): `sh "$HOPPER_SKILL" database read --template NAME --database
// <cluster>/<namespace>/<database> --sql "SELECT …"`. The job names a template of the user's with read on the database;
// a person approves that read on Access requests (it is high radius: no policy approves it), and the job's sandbox runs
// of the template are asked for as a bastion's are. Then the vault reads the database for the job (src/vault/database-reads.ts)
// and the answer is the rows as CSV. `database` alone says how. A read that waits is asked again with no SQL: the job
// stream, which keeps each answer, never holds a row.
import { ASSET_NAME, type Asset } from '../domain/access.ts';
import type { SandboxRequestView } from '../domain/sandbox-approvals.ts';
import type { Job } from '../domain/types.ts';
import type { TemplateView } from '../domain/vault.ts';
import type { DatabaseReadAnswer, DatabaseReadAsk } from '../vault/database-reads.ts';
import { DATABASE_TEXT } from './catalog.ts';

export const DATABASE_SKILL = 'database';

/** What the ask needs of the user: their templates, the job's sandbox runs of one, and the vault's read (absent: none runs). */
export interface DatabaseUser {
  template(name: string): TemplateView | undefined;
  sandbox(template: string, job: Job, about?: { purpose: string; plan?: string }): SandboxRequestView;
  databases: { readDatabase(ask: DatabaseReadAsk): Promise<DatabaseReadAnswer> };
}

/** The fields of the ask: `asset` (read), `template`, `database`, `sql`, `why`. */
export interface DatabaseFields { asset?: string; template?: string; database?: string; sql?: string; why?: string }

/** How the broker answers: a no (recorded), a loaded skill or the rows (recorded), a wait, and its words for a request's wait or decline. */
export interface DatabaseSay<A> {
  no(status: number, reason: string): A;
  loaded(text: string): A;
  waiting(text: string): A;
  waitingText(template: string, r: SandboxRequestView): string;
  declinedText(template: string, r: SandboxRequestView): string;
}

const READ = 'sh "$HOPPER_SKILL" database read --template NAME --database <cluster>/<namespace>/<database> --sql "SELECT …" [--why "<why>"]';
const LATER = ' Add --wait to have the hopper tell you when the read can run.\n';

export async function databaseAsk<A>(u: DatabaseUser, job: Job, f: DatabaseFields, say: DatabaseSay<A>): Promise<A> {
  if (f.asset === undefined) return say.loaded(`${DATABASE_TEXT}\n`);
  if (f.asset !== 'read') return say.no(400, `database takes read, not ${f.asset}: ${READ}`);
  if (!f.template || !f.database) return say.no(400, `name the template and the database: ${READ}`);
  if (!ASSET_NAME.test(f.database)) return say.no(400, `${f.database.slice(0, 80)}: a database is named <cluster>/<namespace>/<database>, as its minting credential mints for it`);
  const asset: Asset = { kind: 'database', name: f.database };
  const need = `read/database/${asset.name}`;
  const t = u.template(f.template);
  if (!t) return say.no(404, `there is no template ${f.template}. Ask for one with read on the database: sh "$HOPPER_SKILL" sandbox-template --needs "${need}" --why "…"`);
  const named = (p: { operation: string; asset: Asset }): boolean => p.operation === 'read' && p.asset.kind === 'database' && p.asset.name === asset.name;
  if (!t.profiles.some(named)) return say.no(400, `template ${t.name} has no read on database ${asset.name}. Ask for one: sh "$HOPPER_SKILL" sandbox-template --needs "${need}" --why "…"`);
  if (t.pending.profiles.some(named)) return say.waiting(`waiting: template ${t.name} waits for a person to approve read on database ${asset.name} on Access requests.${LATER}`);
  const r = u.sandbox(t.name, job, f.why ? { purpose: f.why, plan: `database reads of ${asset.name}` } : undefined);
  if (r.state === 'waiting') return say.waiting(`${say.waitingText(t.name, r)}${LATER}`);
  if (r.state === 'declined') return say.no(403, say.declinedText(t.name, r));
  // A wait asked again carries no SQL (waits.ts): its answer says the read may run, and never holds rows the job stream would keep.
  if (!f.sql) return say.loaded(`ready: template ${t.name} may read database ${asset.name} now. Run the read: ${READ}\n`);
  const a = await u.databases.readDatabase({ job: job.id, template: t.name, asset, sql: f.sql });
  return 'no' in a ? say.no(a.status, a.no) : say.loaded(a.csv);
}
