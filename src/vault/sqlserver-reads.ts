// A database read on SQL Server (issue #2231 part 2, design.md "Database reads"): the `DatabaseReader` seam with `mssql`
// (tedious). SQL Server has no role that logs in, so a database read role is a SQL login of the server and its user in the
// credential's database, both of one name. The minting login makes the login with its password as a hash (the clear
// password never reaches the server or its log), no password policy, the credential's database its default, and the user
// with SELECT on the named schemas and tables only. Then the hopper connects as the new login and checks it can change
// nothing — through `public` too: a write, an ALTER, a CREATE, an EXECUTE of a procedure, a permission on the server —, and
// drops it when it could. SQL Server has no read-only transaction: a read runs in a transaction that is rolled back, with
// that check behind it; the statement must answer one result set, and its rows are answered as CSV up to the caps. The
// drop disables the login, ends its sessions, and drops the user and the login. SQL Server has no `VALID UNTIL` either: the
// sweep drops each database read role whose login is older than the TTL, and each user whose login is gone.
import { createHash, randomBytes } from 'node:crypto';
import sql from 'mssql';
import {
  CONNECT_TIMEOUT_MS, csvLine, DATABASE_ROLE_PREFIX, DATABASE_ROLE_TTL_SECONDS, READ_MAX_BYTES, READ_MAX_ROWS, READ_STATEMENT_TIMEOUT_MS,
  tableParts, type DatabaseMintingCredential, type DatabaseReader,
} from '../domain/database-read.ts';

/**
 * A SQL Server password hash (the form of SQL Server 2012 and later: 0x0200, a 4-byte salt, SHA-512 of the UTF-16LE
 * password and the salt), as `CREATE LOGIN … WITH PASSWORD = 0x… HASHED` takes it: the server never sees the password itself.
 */
export function sqlServerPasswordHash(password: string, salt: Buffer = randomBytes(4)): string {
  const hash = createHash('sha512').update(Buffer.concat([Buffer.from(password, 'utf16le'), salt])).digest();
  return `0x${Buffer.concat([Buffer.from([2, 0]), salt, hash]).toString('hex').toUpperCase()}`;
}

/** An identifier quoted as QUOTENAME does. The names are plain identifiers already: this only keeps them so. */
const ident = (s: string): string => `[${s.replace(/]/g, ']]')}]`;
const lit = (s: string): string => `N'${s.replace(/'/g, "''")}'`;

/** The TLS the client asks for: none, TLS, or TLS with the certificate and the host's name checked. */
const tlsOf = (c: DatabaseMintingCredential): Pick<sql.config, 'options'> => ({
  options: {
    encrypt: c.sslmode !== 'disable', trustServerCertificate: c.sslmode !== 'verify-full', appName: 'hopper',
    ...(c.ca ? { cryptoCredentialsDetails: { ca: c.ca } } : {}),
  },
});

/** One connection to the credential's database as `user`, for `fn`; closed after it, whatever happens. */
async function connected<T>(c: DatabaseMintingCredential, login: { user: string; password: string }, fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = new sql.ConnectionPool({
    server: c.host, port: c.port, database: c.database, ...login, ...tlsOf(c),
    connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: READ_STATEMENT_TIMEOUT_MS, pool: { min: 0, max: 1 },
  });
  pool.on('error', () => {});
  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => {});
  }
}

const asMinter = <T>(c: DatabaseMintingCredential, fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> => connected(c, { user: c.user, password: c.password }, fn);

/** A permission that changes something, as `fn_my_permissions` names it. */
const CHANGING = ['ALTER%', 'CREATE%', 'CONTROL%', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE%', 'TAKE OWNERSHIP', 'IMPERSONATE%', 'BACKUP%', 'CHECKPOINT', 'KILL%', 'SHUTDOWN', 'ADMINISTER%', 'UNSAFE%', 'EXTERNAL ACCESS%', 'AUTHENTICATE%']
  .map((p) => `permission_name LIKE '${p}'`).join(' OR ');
/** An object as HAS_PERMS_BY_NAME names it. */
const OBJECT = "QUOTENAME(s.name) + '.' + QUOTENAME(o.name)";
/**
 * What the login could change, run as the login itself: its permissions on the server and the database, each table or
 * view it could write or alter, each procedure it could run (a procedure may write for it), each schema it could alter. At most 5.
 */
const CHANGES = `
  SELECT TOP 5 what FROM (
    SELECT CAST('server ' + permission_name AS nvarchar(400)) COLLATE DATABASE_DEFAULT AS what FROM fn_my_permissions(NULL, 'SERVER') WHERE ${CHANGING}
    UNION ALL SELECT CAST('database ' + permission_name AS nvarchar(400)) COLLATE DATABASE_DEFAULT FROM fn_my_permissions(NULL, 'DATABASE') WHERE ${CHANGING}
    UNION ALL SELECT CAST(${OBJECT} AS nvarchar(400)) COLLATE DATABASE_DEFAULT FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE (o.type IN ('U', 'V') AND (HAS_PERMS_BY_NAME(${OBJECT}, 'OBJECT', 'INSERT') = 1 OR HAS_PERMS_BY_NAME(${OBJECT}, 'OBJECT', 'UPDATE') = 1
       OR HAS_PERMS_BY_NAME(${OBJECT}, 'OBJECT', 'DELETE') = 1 OR HAS_PERMS_BY_NAME(${OBJECT}, 'OBJECT', 'ALTER') = 1))
       OR (o.type IN ('P', 'PC', 'X', 'RF') AND HAS_PERMS_BY_NAME(${OBJECT}, 'OBJECT', 'EXECUTE') = 1)
    UNION ALL SELECT CAST('schema ' + QUOTENAME(name) AS nvarchar(400)) COLLATE DATABASE_DEFAULT FROM sys.schemas WHERE HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'ALTER') = 1
  ) changes`;

/** The end of a database read role: its login disabled, its sessions ended, then its user and its login. */
async function dropRole(pool: sql.ConnectionPool, role: string): Promise<void> {
  const login = (await pool.request().input('r', sql.NVarChar, role).query<{ n: number }>("SELECT COUNT(*) AS n FROM sys.server_principals WHERE name = @r AND type = 'S'")).recordset[0]!.n > 0;
  if (login) {
    await pool.request().batch(`ALTER LOGIN ${ident(role)} DISABLE`);
    // Only a minting login with VIEW SERVER STATE sees another login's sessions; without it a session left open ends by
    // itself, the login cannot be dropped meanwhile, and the sweep drops it later.
    const sessions = await pool.request().input('r', sql.NVarChar, role).query<{ id: number }>('SELECT session_id AS id FROM sys.dm_exec_sessions WHERE login_name = @r AND session_id <> @@SPID');
    for (const { id } of sessions.recordset) await pool.request().batch(`KILL ${Number(id)}`).catch(() => {});
  }
  await pool.request().batch(`IF DATABASE_PRINCIPAL_ID(${lit(role)}) IS NOT NULL DROP USER ${ident(role)}`);
  if (login) await pool.request().batch(`DROP LOGIN ${ident(role)}`);
}

/** Each value as text: a date as ISO 8601 (UTC), binary as 0x and hex, a bit as 1 or 0, NULL as NULL. */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex').toUpperCase()}`;
  if (typeof v === 'boolean') return v ? '1' : '0';
  return typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | bigint);
}

/** Why a read stops: its answer passed a cap. */
const passed = (what: string): Error => new Error(`the answer passed ${what}: narrow the query, or page it (WHERE on a key, ORDER BY and OFFSET … FETCH)`);

export function createSqlServerReader(o: { maxRows?: number; maxBytes?: number; ttlSeconds?: number } = {}): DatabaseReader {
  const maxRows = o.maxRows ?? READ_MAX_ROWS, maxBytes = o.maxBytes ?? READ_MAX_BYTES, ttl = o.ttlSeconds ?? DATABASE_ROLE_TTL_SECONDS;
  return {
    async mint(c, { role, password }) {
      await asMinter(c, async (pool) => {
        const r = ident(role);
        await pool.request().batch(`CREATE LOGIN ${r} WITH PASSWORD = ${sqlServerPasswordHash(password)} HASHED, DEFAULT_DATABASE = ${ident(c.database)}, CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF`);
        try {
          await pool.request().batch(`CREATE USER ${r} FOR LOGIN ${r}`);
          for (const s of c.schemas) await pool.request().batch(`GRANT SELECT ON SCHEMA::${ident(s)} TO ${r}`);
          for (const t of c.tables) await pool.request().batch(`GRANT SELECT ON OBJECT::${tableParts(t).map(ident).join('.')} TO ${r}`);
          const changes = await connected(c, { user: role, password }, async (own) => (await own.request().query<{ what: string }>(CHANGES)).recordset.map((x) => x.what));
          if (changes.length) throw new Error(`the database read role could change ${changes.join(', ')}: take that permission from public, or name other schemas or tables`);
        } catch (e) {
          await dropRole(pool, role).catch(() => {});
          throw e;
        }
      });
    },

    async read(c, { role, password, sql: statement }) {
      return connected(c, { user: role, password }, async (pool) => {
        const tx = new sql.Transaction(pool);
        await tx.begin();
        try {
          return await new Promise<{ csv: string; rows: number; bytes: number }>((resolve, reject) => {
            const req = new sql.Request(tx);
            req.stream = true;
            req.arrayRowMode = true;
            let csv = '', rows = 0, bytes = 0, sets = 0, stop: Error | undefined;
            const end = (e: Error): void => { if (!stop) { stop = e; req.cancel(); } };
            req.on('recordset', (columns: { name: string }[]) => {
              if (++sets > 1) return end(new Error('the statement answered more than one result set: a database read runs one SELECT'));
              const line = csvLine(columns.map((col) => col.name));
              csv += line; bytes += Buffer.byteLength(line);
            });
            req.on('row', (row: unknown[]) => {
              if (stop) return;
              if (++rows > maxRows) return end(passed(`${maxRows} rows`));
              const line = csvLine(row.map(text));
              bytes += Buffer.byteLength(line);
              if (bytes > maxBytes) return end(passed(`${maxBytes} bytes`));
              csv += line;
            });
            req.on('error', (e: Error) => { if (!stop) stop = e; });
            req.on('done', () => {
              if (stop) reject(stop);
              else if (sets === 0) reject(new Error('the statement answered no result set: a database read runs one SELECT'));
              else resolve({ csv, rows, bytes });
            });
            void req.query(statement).catch(() => {});
          });
        } finally {
          await tx.rollback().catch(() => {});
        }
      });
    },

    async drop(c, role) {
      await asMinter(c, (pool) => dropRole(pool, role));
    },

    async sweep(c) {
      return asMinter(c, async (pool) => {
        const prefix = `${DATABASE_ROLE_PREFIX.replace(/_/g, '[_]')}%`;
        const due = await pool.request().input('p', sql.NVarChar, prefix).input('ttl', sql.Int, ttl).query<{ name: string }>(`
          SELECT name FROM sys.server_principals WHERE type = 'S' AND name LIKE @p AND create_date < DATEADD(second, -@ttl, GETDATE())
          UNION SELECT dp.name FROM sys.database_principals dp LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid
           WHERE dp.type = 'S' AND dp.name LIKE @p AND (sp.sid IS NULL OR dp.create_date < DATEADD(second, -@ttl, GETDATE()))
          ORDER BY name`);
        const dropped: string[] = [];
        for (const { name } of due.recordset) {
          try { await dropRole(pool, name); dropped.push(name); } catch { /* the next sweep tries again */ }
        }
        return dropped;
      });
    },
  };
}
