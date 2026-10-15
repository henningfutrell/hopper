// The Kubernetes API adapter (issue #1283): pods in one namespace and nothing else, with the service account's token,
// against a fake API server on loopback.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKubernetesPods, inClusterOptions } from '../../src/kubernetes/api.ts';

interface Seen { method: string; path: string; auth: string; body: unknown }
let server: Server | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake API server: `answer` gives each request's status and body; every request is kept. */
async function api(answer: (s: Seen) => [number, unknown]): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const s = { method: req.method ?? '', path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: text ? JSON.parse(text) : undefined };
      seen.push(s);
      const [status, body] = answer(s);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen };
}

describe('the Kubernetes API, as job pods use it', () => {
  it('creates, reads, lists and deletes pods only in its namespace, with the token read at each call', async () => {
    let token = 't1';
    const { url, seen } = await api((s) => {
      if (s.method === 'GET' && s.path.endsWith('/pods/p1')) return [200, { status: { phase: 'Failed', reason: 'Evicted', message: 'low on memory' } }];
      if (s.method === 'GET' && s.path.includes('labelSelector')) return [200, { items: [{ metadata: { name: 'p1' } }, { metadata: { name: 'p2' } }] }];
      if (s.method === 'DELETE') return [404, { message: 'pods "p1" not found' }];
      return [201, {}];
    });
    const pods = createKubernetesPods({ server: url, token: () => token, namespace: 'hopper' });
    await pods.create({ metadata: { name: 'p1' } });
    token = 't2';
    expect(await pods.state('p1')).toEqual({ phase: 'Failed', reason: 'Evicted: low on memory' });
    expect(await pods.list({ 'io.hopper/instance': 'i1' })).toEqual(['p1', 'p2']);
    await pods.remove('p1'); // a pod that is gone is no error
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /api/v1/namespaces/hopper/pods',
      'GET /api/v1/namespaces/hopper/pods/p1',
      `GET /api/v1/namespaces/hopper/pods?labelSelector=${encodeURIComponent('io.hopper/instance=i1')}`,
      'DELETE /api/v1/namespaces/hopper/pods/p1',
    ]);
    expect(seen.map((s) => s.auth)).toEqual(['Bearer t1', 'Bearer t2', 'Bearer t2', 'Bearer t2']);
    expect(seen.every((s) => s.path.startsWith('/api/v1/namespaces/hopper/pods'))).toBe(true);
  });

  it('says why it cannot be used: the role refuses the namespace, or nothing answers', async () => {
    const { url } = await api(() => [403, { message: 'pods is forbidden: User "system:serviceaccount:hopper:hopper" cannot list resource "pods"' }]);
    expect(await createKubernetesPods({ server: url, token: () => 't', namespace: 'other' }).problem()).toMatch(/refused a pod list in namespace other: 403 pods is forbidden/);
    expect(await createKubernetesPods({ server: 'http://127.0.0.1:1', token: () => 't', namespace: 'hopper' }).problem()).toMatch(/is not reached/);
  });

  it('refuses a create the API refused, and a pod or namespace name that is not a DNS label', async () => {
    const { url } = await api(() => [422, { message: 'Pod "x" is invalid' }]);
    const pods = createKubernetesPods({ server: url, token: () => 't', namespace: 'hopper' });
    await expect(pods.create({})).rejects.toThrow(/did not create the pod: 422 Pod "x" is invalid/);
    await expect(pods.state('../secrets')).rejects.toThrow(/bad pod name/);
    expect(() => createKubernetesPods({ server: url, token: () => 't', namespace: 'kube-system/x' })).toThrow(/bad namespace/);
  });

  it('in a pod: the API server from the environment, the token, CA and namespace from the service account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopper-sa-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'token'), 'tok\n');
    writeFileSync(join(dir, 'ca.crt'), 'CA\n');
    writeFileSync(join(dir, 'namespace'), 'hopper\n');
    const env = (n: string) => ({ KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '443' } as Record<string, string>)[n];
    const o = inClusterOptions(env, dir);
    expect(o).toMatchObject({ server: 'https://10.0.0.1:443', ca: 'CA', namespace: 'hopper' });
    expect(o.token()).toBe('tok');
    expect(inClusterOptions(env, dir, 'jobs').namespace).toBe('jobs');
    expect(() => inClusterOptions(() => undefined, dir)).toThrow(/not in a Kubernetes pod/);
  });
});
