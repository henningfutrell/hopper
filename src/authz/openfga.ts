// OpenFGA at the AuthorizationServer seam (issue #559), through its SDK (@openfga/sdk). The server is
// HOPPER_OPENFGA_URL; its preshared key, when it has one, comes from the runtime (HOPPER_OPENFGA_KEY or the file
// HOPPER_OPENFGA_KEY_FILE names), read at each call so a rotated key counts: one client per key. No retries: a check
// that cannot be answered at once (the SDK's 10 s connection timeout) is a deny (fail closed), not a wait.
import { CredentialsMethod, FgaApiNotFoundError, FgaApiValidationError, OpenFgaClient, type UserClientConfigurationParams } from '@openfga/sdk';
import { authorizationServerRefusal, type AuthorizationServer, type RelationshipTuple } from '../domain/ports.ts';

/** OpenFGA's most tuples in one write (its MaxTuplesPerWrite default), writes and deletes together. */
const PER_WRITE = 100;
const PAGE = 100;

type Key = { user: string; relation: string; object: string };
const toKey = (t: RelationshipTuple): Key => ({ user: t.subject, relation: t.relation, object: t.object });

/** OpenFGA answering no (a 400 or a 404) is a refusal; anything else is OpenFGA not reached, in its own words. */
function rethrow(e: unknown): never {
  if (e instanceof FgaApiValidationError || e instanceof FgaApiNotFoundError) throw authorizationServerRefusal(e.apiErrorMessage ?? e.message);
  throw new Error((e as Error).message.replace(/^FGA Error: /, ''), { cause: e });
}

export function createOpenFgaServer(o: { url: string; key: () => string | undefined }): AuthorizationServer {
  let cached: { key: string | undefined; client: OpenFgaClient } | undefined;
  const fga = (): OpenFgaClient => {
    const key = o.key();
    if (!cached || cached.key !== key) {
      const config: UserClientConfigurationParams = {
        apiUrl: o.url, retryParams: { maxRetry: 0 },
        ...(key ? { credentials: { method: CredentialsMethod.ApiToken, config: { token: key } } } : {}),
      };
      cached = { key, client: new OpenFgaClient(config) };
    }
    return cached.client;
  };
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { return rethrow(e); }
  };
  return {
    async store(id, name) {
      if (id !== undefined) {
        try {
          await fga().getStore({ storeId: id });
          return id;
        } catch (e) {
          if (!(e instanceof FgaApiNotFoundError) && !(e instanceof FgaApiValidationError)) rethrow(e);
        }
      }
      return call(async () => (await fga().createStore({ name })).id);
    },
    writeModel: (storeId, model) => call(async () =>
      (await fga().writeAuthorizationModel(model as Parameters<OpenFgaClient['writeAuthorizationModel']>[0], { storeId })).authorization_model_id),
    tuples: (storeId) => call(async () => {
      const out: RelationshipTuple[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await fga().read({}, { storeId, pageSize: PAGE, ...(continuationToken ? { continuationToken } : {}) });
        for (const t of page.tuples) out.push({ subject: t.key.user, relation: t.key.relation, object: t.key.object });
        continuationToken = page.continuation_token || undefined;
      } while (continuationToken);
      return out;
    }),
    write: (storeId, modelId, { writes, deletes }) => call(async () => {
      const all = [...deletes.map((t) => ({ t, del: true })), ...writes.map((t) => ({ t, del: false }))];
      for (let i = 0; i < all.length; i += PER_WRITE) {
        const chunk = all.slice(i, i + PER_WRITE);
        const writes = chunk.filter((x) => !x.del).map((x) => toKey(x.t));
        const deletes = chunk.filter((x) => x.del).map((x) => toKey(x.t));
        await fga().write({ ...(writes.length ? { writes } : {}), ...(deletes.length ? { deletes } : {}) }, { storeId, authorizationModelId: modelId });
      }
    }),
    check: (storeId, modelId, tuple, contextual) => call(async () =>
      (await fga().check({ ...toKey(tuple), contextualTuples: contextual.map(toKey) }, { storeId, authorizationModelId: modelId })).allowed === true),
  };
}
