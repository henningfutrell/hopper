// The secret canary check (issue #1957): distinct random values seeded as the secrets a hopper keeps or mints, and a
// scan of every place a test can read after a job ran — the whole database (every table of the instance's schema and
// of each user's), files under a directory, and texts the test captured (logs, the event log, SSE replays, webhook
// bodies, a fake's requests, a box's environment and argv). A canary is found in its plain form and in the forms a
// leak takes on the way out: base64, base64url, hex and URL-encoded; a gzip value (a checkpoint) is opened first, as
// bytes, as a bytea Postgres prints (`\x1f8b…`) or as base64 text (`H4sI…`, a checkpoint's row).
// Where a canary may stay — its sealed vault row — holds no form of it, so the check allows none anywhere.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openDb } from '../../src/store/db.ts';

/** A place the scan reads: its name, said in a finding, and its text. */
export interface Place { name: string; text: string }

/** A canary found: which one, where, and in which form. */
export interface Finding { canary: string; place: string; form: string }

/** A distinct random canary for `kind` (a master key is 32 bytes as hex, as the hopper is given one). */
export const canary = (kind: string): string => `canary-${kind}-${randomBytes(16).toString('hex')}`;

/** The forms of `value` a scan looks for. */
export function formsOf(value: string): Record<string, string> {
  const bytes = Buffer.from(value, 'utf8');
  return {
    plain: value,
    base64: bytes.toString('base64').replace(/=+$/, ''),
    base64url: bytes.toString('base64url'),
    hex: bytes.toString('hex'),
    'url-encoded': encodeURIComponent(value),
  };
}

const GZIP_HEX = /\\x(1f8b[0-9a-f]+)/g;
/** A gzip value as base64 text: its magic bytes and method (`1f 8b 08`) are `H4sI`. */
const GZIP_BASE64 = /H4sI[A-Za-z0-9+/]+={0,2}/g;

/** `bytes` opened when they are a whole gzip value, else ''. */
function opened(bytes: Buffer): string {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return '';
  try {
    return gunzipSync(bytes).toString('latin1');
  } catch {
    return '';
  }
}

/** `text`, and each gzip value in it (a bytea as Postgres prints it, `\x1f8b…`, or base64 text, `H4sI…`) opened. */
function withOpened(text: string): string {
  const all = [
    ...[...text.matchAll(GZIP_HEX)].map((m) => opened(Buffer.from(m[1]!, 'hex'))),
    ...[...text.matchAll(GZIP_BASE64)].map((m) => opened(Buffer.from(m[0], 'base64'))),
  ].filter((x) => x !== '');
  return all.length === 0 ? text : `${text}\n${all.join('\n')}`;
}

/** Every canary of `canaries` (kind → value) in `places`, each place and form named. */
export function scan(canaries: Record<string, string>, places: Place[]): Finding[] {
  const found: Finding[] = [];
  for (const p of places) {
    const text = withOpened(p.text);
    const lower = text.toLowerCase();
    for (const [kind, value] of Object.entries(canaries)) {
      for (const [form, f] of Object.entries(formsOf(value))) {
        if (form === 'hex' ? lower.includes(f) : text.includes(f)) found.push({ canary: kind, place: p.name, form });
      }
    }
  }
  return found;
}

/** Says every finding, one per line: what the check fails with. */
export const report = (found: Finding[]): string =>
  found.map((f) => `canary ${f.canary} found in ${f.place} (${f.form})`).join('\n');

/**
 * Every row of every table of the database of `url` (a test app's: its instance schema) and of each schema named after
 * it (each user's, `<schema>_u_<id>`), one place per table, each row as Postgres prints it (a bytea as hex).
 */
export function databasePlaces(url: string): Place[] {
  const schema = new URL(url).searchParams.get('schema');
  if (!schema) throw new Error('the database URL names no schema');
  const db = openDb(url);
  try {
    const tables = db.all(
      "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE (table_schema = ? OR starts_with(table_schema, ?)) AND table_type = 'BASE TABLE' ORDER BY 1, 2",
      schema, `${schema}_`,
    );
    return tables.map((r) => {
      const name = `"${String(r.s)}"."${String(r.t)}"`;
      const rows = db.all(`SELECT x::text AS row FROM ${name} x`);
      return { name: `database ${String(r.s)}.${String(r.t)}`, text: rows.map((x) => String(x.row)).join('\n') };
    });
  } finally {
    db.close();
  }
}

/** Every file under `dir`, one place each (`label` and the path under it); a socket, a fifo and a link are skipped. */
export function filePlaces(label: string, dir: string): Place[] {
  const out: Place[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let s;
      try {
        s = statSync(p, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (!s) continue;
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) {
        try {
          const bytes = readFileSync(p);
          out.push({ name: `${label} ${relative(dir, p)}`, text: `${bytes.toString('latin1')}\n${opened(bytes)}` });
        } catch {
          // gone, or not readable by the test
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** The WAL read in one call: a part of a segment, so no answer is too large for the store's worker. */
const WAL_CHUNK = 4 * 1024 * 1024;

const lsnOf = (lsn: string): bigint => {
  const [hi, lo] = lsn.split('/');
  return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
};
const hex8 = (n: bigint): string => n.toString(16).toUpperCase().padStart(8, '0');

/**
 * Where the WAL of the database of `url` is now: the point `walPlaces` reads from. Undefined when the test's role
 * cannot read the WAL's files (a database a test was given, with no superuser and no `pg_read_server_files`).
 */
export function walMark(url: string): string | undefined {
  const db = openDb(url);
  try {
    const r = db.get("SELECT pg_current_wal_lsn()::text AS lsn, pg_walfile_name(pg_current_wal_lsn()) AS f");
    db.get('SELECT length(pg_read_binary_file(?, 0, 1)) AS n', `pg_wal/${String(r!.f)}`);
    return String(r!.lsn);
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * The WAL the Postgres of `url` wrote since `from` (a `walMark`), one place per segment: what a row held before it was
 * changed or removed, which no table shows any more. The WAL is the whole server's, so other tests' writes are in it
 * too; their canaries are their own. A value Postgres compressed (TOAST, over 2 kB) or one split by a WAL page's header
 * is not found.
 */
export function walPlaces(url: string, from: string): Place[] {
  const db = openDb(url);
  try {
    const to = lsnOf(String(db.get('SELECT pg_current_wal_lsn()::text AS lsn')!.lsn));
    const size = BigInt(String(db.get("SELECT setting FROM pg_settings WHERE name = 'wal_segment_size'")!.setting));
    const timeline = BigInt(String(db.get('SELECT timeline_id AS t FROM pg_control_checkpoint()')!.t));
    const perId = 0x100000000n / size;
    const out: Place[] = [];
    for (let segment = lsnOf(from) / size; segment * size < to; segment++) {
      // A segment's file is named for its timeline and number (pg_walfile_name names the one before at its boundary).
      const file = `${hex8(timeline)}${hex8(segment / perId)}${hex8(segment % perId)}`;
      const first = lsnOf(from) > segment * size ? lsnOf(from) - segment * size : 0n;
      const last = to < (segment + 1n) * size ? to - segment * size : size;
      const chunks: string[] = [];
      for (let o = first; o < last; o += BigInt(WAL_CHUNK)) {
        const n = last - o < BigInt(WAL_CHUNK) ? last - o : BigInt(WAL_CHUNK);
        const got = db.get("SELECT encode(pg_read_binary_file(?, ?, ?, true), 'base64') AS b", `pg_wal/${file}`, Number(o), Number(n));
        chunks.push(Buffer.from(String(got?.b ?? ''), 'base64').toString('latin1'));
      }
      out.push({ name: `WAL ${file}`, text: chunks.join('') });
    }
    return out;
  } finally {
    db.close();
  }
}
