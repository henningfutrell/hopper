// Issue #1371 (decision #1394): a sandbox's Kubernetes token is bound to a Secret of its own, and deleting that Secret
// ends the token at once. The minter against a Kubernetes API double on loopback: it makes the Secret, asks for the
// token bound to it, deletes it when the hopper unbinds, and refuses a token whose Secret is gone, as an API server does.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MINT_BINDING_LABEL, type KubeTokenCredential } from '../../src/domain/minting.ts';
import { createCredentialMinter } from '../../src/vault/minter.ts';

interface Api { credential: KubeTokenCredential; secrets: Map<string, { uid: string; labels: Record<string, string> }>; calls: string[]; tokenRequests: unknown[]; refuseTokens: boolean }

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });

const bodyOf = (req: IncomingMessage): Promise<unknown> => new Promise((resolve) => {
  let text = '';
  req.on('data', (c: Buffer) => { text += c.toString('utf8'); });
  req.on('end', () => resolve(text ? JSON.parse(text) : undefined));
});

/** A Kubernetes API double: Secrets in `lab`, TokenRequests for `hopper-read`, and who a token is while its Secret is there. */
async function kubeApi(): Promise<Api> {
  const tokens = new Map<string, string | undefined>();
  const api: Api = { credential: { type: 'token', server: '', token: 'minter' }, secrets: new Map(), calls: [], tokenRequests: [], refuseTokens: false };
  const server = createServer((req, res) => {
    void (async () => {
      const body = await bodyOf(req);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      api.calls.push(`${req.method} ${path}`);
      const send = (status: number, answer: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer)); };
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (req.method === 'POST' && path === '/apis/authentication.k8s.io/v1/selfsubjectreviews') {
        const bound = tokens.get(auth);
        const live = tokens.has(auth) && (bound === undefined || [...api.secrets.values()].some((s) => s.uid === bound));
        return live ? send(201, { status: { userInfo: { username: 'system:serviceaccount:lab:hopper-read', groups: [] } } }) : send(401, { message: 'Unauthorized' });
      }
      if (req.method === 'GET' && path === '/api/v1/namespaces') return tokens.has(auth) ? send(200, { items: [{ metadata: { name: 'lab' } }] }) : send(401, { message: 'Unauthorized' });
      if (auth !== 'minter') return send(401, { message: 'Unauthorized' });
      const secret = /^\/api\/v1\/namespaces\/lab\/secrets(?:\/([^/]+))?$/.exec(path);
      if (secret && req.method === 'POST') {
        const meta = (body as { metadata: { name: string; labels?: Record<string, string> } }).metadata;
        if (api.secrets.has(meta.name)) return send(409, { message: `secrets "${meta.name}" already exists` });
        const uid = randomUUID();
        api.secrets.set(meta.name, { uid, labels: meta.labels ?? {} });
        return send(201, { metadata: { name: meta.name, namespace: 'lab', uid } });
      }
      if (secret?.[1] && req.method === 'DELETE') {
        if (!api.secrets.delete(decodeURIComponent(secret[1]))) return send(404, { message: `secrets "${secret[1]}" not found` });
        return send(200, { kind: 'Status', status: 'Success' });
      }
      if (req.method === 'POST' && path === '/api/v1/namespaces/lab/serviceaccounts/hopper-read/token') {
        api.tokenRequests.push(body);
        if (api.refuseTokens) return send(403, { message: 'serviceaccounts "hopper-read" is forbidden' });
        const ref = (body as { spec: { boundObjectRef?: { kind: string; name: string; uid: string } } }).spec.boundObjectRef;
        if (ref && api.secrets.get(ref.name)?.uid !== ref.uid) return send(400, { message: 'the bound object is not there' });
        const token = `token-${randomUUID()}`;
        tokens.set(token, ref?.uid);
        return send(201, { status: { token, expirationTimestamp: '2030-01-01T00:10:00Z' } });
      }
      return send(404, { message: 'not found' });
    })();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  api.credential.server = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
}

const minter = createCredentialMinter();
const ASK = { namespace: 'lab', serviceAccount: 'hopper-read', expirationSeconds: 600 };

describe('a sandbox\'s Kubernetes token is bound to a Secret (issue #1371)', () => {
  it('makes a labelled Secret, then asks for the token bound to it', async () => {
    const api = await kubeApi();
    const minted = await minter.kubeToken(api.credential, { ...ASK, bindTo: 'hopper-mint-a' });
    expect(minted.kind).toBe('kube');
    const secret = api.secrets.get('hopper-mint-a');
    expect(secret?.labels).toEqual({ [MINT_BINDING_LABEL]: 'true' });
    expect(api.tokenRequests).toEqual([{ apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: 600, boundObjectRef: { apiVersion: 'v1', kind: 'Secret', name: 'hopper-mint-a', uid: secret?.uid } } }]);
  });

  it('the token works until its Secret is deleted, and is refused at once after', async () => {
    const api = await kubeApi();
    const reach = { kind: 'kube' as const, server: api.credential.server };
    const minted = await minter.kubeToken(api.credential, { ...ASK, bindTo: 'hopper-mint-b' });
    expect((await minter.kubeIdentity(reach, minted.token)).user.username).toBe('system:serviceaccount:lab:hopper-read');
    await minter.kubeUnbind(api.credential, { namespace: 'lab', secret: 'hopper-mint-b' });
    expect(api.secrets.has('hopper-mint-b')).toBe(false);
    await expect(minter.kubeIdentity(reach, minted.token)).rejects.toThrow(/401/);
  });

  it('a Secret already gone is no error', async () => {
    const api = await kubeApi();
    await expect(minter.kubeUnbind(api.credential, { namespace: 'lab', secret: 'hopper-mint-gone' })).resolves.toBeUndefined();
    expect(api.calls).toEqual(['DELETE /api/v1/namespaces/lab/secrets/hopper-mint-gone']);
  });

  it('a token the cluster refuses leaves no Secret behind', async () => {
    const api = await kubeApi();
    api.refuseTokens = true;
    await expect(minter.kubeToken(api.credential, { ...ASK, bindTo: 'hopper-mint-c' })).rejects.toThrow(/403/);
    expect(api.secrets.size).toBe(0);
  });

  it('with no bindTo, no Secret is made: the token is bound to nothing, as before', async () => {
    const api = await kubeApi();
    await minter.kubeToken(api.credential, ASK);
    expect(api.secrets.size).toBe(0);
    expect(api.tokenRequests).toEqual([{ apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: 600 } }]);
  });
});
