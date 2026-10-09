// The vault server (issue #586, design.md "The vault in a container of its own"): the vault in a process — a container
// — of its own, run by `node src/vault/main.ts` from the hopper's image. It holds the vault's key (the token key, or the
// data key a KMS opens), reads and writes the vault's tables in each user's schema, and answers the hopper's edits and
// asks with the same vault service the hopper runs in-process: the write-only rule and every check of a delivery stay
// in it. The templates and their approvals stay in the hopper, with access (issue #584); a delivery reads a template's
// approved scope from the user's store. It answers only a request with the preshared key, and only on the compose
// network (no host port). The events it would append it answers instead: the hopper keeps the event log.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { DomainEvent, NewEvent } from '../domain/types.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { openInstanceStore, type InstanceStore } from '../store/index.ts';
import { vaultKeys } from './keys.ts';
import { kmsOf } from './kms.ts';
import { createVaultService, type VaultService } from './service.ts';
import { createCredentialMinter } from './minter.ts';
import type { MintTarget } from '../domain/minting.ts';
import { VAULT_KEY_VARIABLE, VAULT_OP_PATH, vaultOps, type VaultOp } from './wire.ts';

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Starts the vault server on `host`:`port` (0: any free one). Its database, keys and KMS come from `env`. */
export async function startVaultServer(o: { env: Record<string, string | undefined>; host: string; port: number; clock?: Clock }): Promise<{ url: string; stop(): Promise<void> }> {
  const secret = runtimeSecrets(o.env);
  const databaseUrl = secret('HOPPER_DATABASE_URL');
  if (!databaseUrl) throw new Error('HOPPER_DATABASE_URL is not set: the vault keeps its secrets in the hopper\'s database');
  if (!secret(VAULT_KEY_VARIABLE)) throw new Error(`${VAULT_KEY_VARIABLE} is not set: the vault answers only the hopper, which shows it`);
  const kms = kmsOf(o.env);
  const clock = o.clock ?? { now: () => new Date() };
  const logger = { warn: (line: string) => console.warn(line) };
  // The vault holds the minting credentials, so it mints (issue #580): STS and the Kubernetes API are asked from here.
  const minter = createCredentialMinter();
  // Opened at the first request, once the hopper has made and migrated the database.
  let instance: InstanceStore | undefined;
  const keys = new Map<string, SealerState>();
  const resealed = new Set<string>();

  /** The user's keys: kept once a sealer is made; a KMS that gave none is asked again at the next request. */
  async function keysOf(userId: string, store: UserStore): Promise<SealerState> {
    const kept = keys.get(userId);
    if (kept) return kept;
    const made = await vaultKeys({ secret, ...(kms ? { kms } : {}), store: store.vault });
    if (made.sealer) keys.set(userId, made);
    else logger.warn(`hopper vault: ${made.problem}`);
    return made;
  }

  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  // The container's health check: the server answers. Says nothing of the vault.
  app.get('/health', async () => ({ ok: true }));
  app.post<{ Params: { op: string } }>(`${VAULT_OP_PATH}:op`, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const expected = secret(VAULT_KEY_VARIABLE) ?? '';
    const shown = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!expected || !timingSafeEqual(digest(shown), digest(expected))) {
      logger.warn(`hopper vault: refused a request from ${req.socket.remoteAddress}: not the preshared key`);
      return reply.code(401).send({ error: 'not the preshared key' });
    }
    if (!Object.hasOwn(vaultOps, req.params.op)) return reply.code(404).send({ error: `no op ${req.params.op}` });
    const op = req.params.op as VaultOp;
    const parsed = vaultOps[op].safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const body = parsed.data;
    instance ??= openInstanceStore({ url: databaseUrl, clock });
    const user = instance.users.get(body.user);
    if (!user) return reply.code(404).send({ error: 'no such user' });
    const store = instance.userStore(user);
    try {
      const events: NewEvent[] = [];
      const deliver = op === 'deliver' ? vaultOps.deliver.parse(body) : undefined;
      const vault = createVaultService({
        store: { vault: store.vault, jobs: store.jobs, settings: store.settings, tx: store.tx, events: { append: (e: NewEvent) => { events.push(e); return e as DomainEvent; } } as never },
        keys: await keysOf(user.id, store), clock, idGen: randomUUID, logger, minter,
        targets: () => (deliver?.machine ? [deliver.machine] : []),
        holds: () => deliver?.holds === true,
      });
      if (!resealed.has(user.id) && keys.has(user.id)) {
        resealed.add(user.id);
        const n = vault.resealAll();
        if (n > 0) logger.warn(`hopper vault: ${n} vault secret(s) sealed again under the current key`);
      }
      return { result: (await run(vault, op, body)) ?? null, events };
    } finally {
      store.close();
    }
  });

  await app.listen({ host: o.host, port: o.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : o.port;
  return {
    url: `http://${o.host.includes(':') ? `[${o.host}]` : o.host}:${port}`,
    async stop() {
      await app.close();
      instance?.close();
    },
  };
}

/** One op on the vault service, its body already parsed. `status`: why no secret can be stored now, or nothing. */
function run(vault: VaultService, op: VaultOp, b: Record<string, unknown>): unknown {
  const body = b as never as {
    by: string; name: string; secret: { name: string; scope?: string; value: string }; ask: { name: string; token: string }; machine?: { key: string };
    credential: string; target: MintTarget; sessionName: string;
  };
  switch (op) {
    case 'status': return vault.view().problem;
    case 'set': return vault.set(body.secret, body.by);
    case 'remove': return vault.remove(body.name, body.by);
    case 'deliver': return vault.deliver(body.ask, body.machine?.key ?? '');
    case 'mint': return vault.mintFrom(body.credential, body.target, body.sessionName);
  }
}
