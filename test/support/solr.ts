// The Solr a search test runs against (issue #945): HOPPER_TEST_SOLR_URL when it names a core, else a throwaway Solr
// container (testcontainers) with one core made from Solr's default config, as compose.yaml makes it, removed after the
// file's tests. Tests share the core and stay apart as two hoppers do: each document carries its hopper's instance id.
import { createHash, randomBytes } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { containerLabels } from './sweep.ts';

export const SOLR_IMAGE = 'docker.io/library/solr:9.11.0-slim';

export interface TestSolr { url: string; stop(): Promise<void> }

export async function startTestSolr(): Promise<TestSolr> {
  const given = process.env.HOPPER_TEST_SOLR_URL;
  if (given) return { url: given, stop: async () => {} };
  const c: StartedTestContainer = await new GenericContainer(SOLR_IMAGE)
    .withCommand(['solr-precreate', 'hopper'])
    .withExposedPorts(8983)
    .withLabels(containerLabels())
    .withWaitStrategy(Wait.forHttp('/solr/hopper/admin/ping', 8983).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  return { url: `http://127.0.0.1:${c.getMappedPort(8983)}/solr/hopper`, stop: async () => { await c.stop(); } };
}

/** A SolrCloud cluster's collection a search test runs against (issue #2990), with basic auth on. */
export interface TestSolrCloud { url: string; username: string; password: string; stop(): Promise<void> }

/** Solr's stored form of a basic-auth password: base64(sha256(sha256(salt ‖ password))), then base64(salt). */
export function solrPasswordHash(password: string, salt: Buffer): string {
  const once = createHash('sha256').update(salt).update(password, 'utf8').digest();
  return `${createHash('sha256').update(once).digest('base64')} ${salt.toString('base64')}`;
}

/**
 * A throwaway SolrCloud node (embedded ZooKeeper) with two collections, `hopper` and `other`, and basic auth on, as a
 * managed Solr service gives it: one user, `app`, may use only the collection `hopper`; the admin may do all.
 */
export async function startTestSolrCloud(): Promise<TestSolrCloud> {
  const admin = { username: 'admin', password: randomBytes(12).toString('hex') };
  const app = { username: 'app', password: randomBytes(12).toString('hex') };
  const security = {
    authentication: {
      class: 'solr.BasicAuthPlugin', blockUnknown: true, forwardCredentials: false,
      credentials: { [admin.username]: solrPasswordHash(admin.password, randomBytes(16)), [app.username]: solrPasswordHash(app.password, randomBytes(16)) },
    },
    authorization: {
      class: 'solr.RuleBasedAuthorizationPlugin',
      'user-role': { [admin.username]: ['admin'], [app.username]: ['app'] },
      permissions: [
        { name: 'hopper-collection', collection: 'hopper', path: '/*', role: ['app', 'admin'] },
        { name: 'all', role: 'admin' },
      ],
    },
  };
  const c: StartedTestContainer = await new GenericContainer(SOLR_IMAGE)
    .withCommand(['solr-foreground', '-c'])
    .withExposedPorts(8983)
    .withLabels(containerLabels())
    .withCopyContentToContainer([{ content: JSON.stringify(security), target: '/tmp/security.json', mode: 0o644 }])
    .withWaitStrategy(Wait.forHttp('/solr/admin/info/system', 8983).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  try {
    const zk = await c.exec(['solr', 'zk', 'cp', 'file:/tmp/security.json', 'zk:/security.json', '-z', 'localhost:9983']);
    if (zk.exitCode !== 0) throw new Error(`security.json not put in ZooKeeper: ${zk.output}`);
    const base = `http://127.0.0.1:${c.getMappedPort(8983)}/solr`;
    const auth = `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString('base64')}`;
    // The node reads security.json from ZooKeeper when it changes: wait until it asks for credentials.
    const deadline = Date.now() + 30_000;
    while ((await fetch(`${base}/admin/info/system`)).status !== 401) {
      if (Date.now() > deadline) throw new Error('SolrCloud did not turn basic auth on');
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const name of ['hopper', 'other']) {
      const p = new URLSearchParams({ action: 'CREATE', name, numShards: '1', replicationFactor: '1', 'collection.configName': '_default', wt: 'json' });
      const res = await fetch(`${base}/admin/collections?${p}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`collection ${name} not made: ${res.status} ${await res.text()}`);
    }
    return { url: `${base}/hopper`, username: app.username, password: app.password, stop: async () => { await c.stop(); } };
  } catch (e) {
    await c.stop();
    throw e;
  }
}
