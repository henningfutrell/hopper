// The Solr a search test runs against (issue #945): HOPPER_TEST_SOLR_URL when it names a core, else a throwaway Solr
// container (testcontainers) with one core made from Solr's default config, as compose.yaml makes it, removed after the
// file's tests. Tests share the core and stay apart as two hoppers do: each document carries its hopper's instance id.
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

/**
 * A SolrCloud cluster with basic auth on (issue #2990), as a managed Solr is: the collection `hopper` that only the user
 * `hopper` may use, and a second collection, `other`, that it may not. HOPPER_TEST_SOLR_CLOUD_URL (the cluster's
 * `…/solr`) with HOPPER_TEST_SOLR_CLOUD_ADMIN (`user:password` of a user with the role `admin`) names one with auth on
 * already; else a throwaway Solr in cloud mode (its own ZooKeeper), the auth turned on here.
 */
export interface TestSolrCloud {
  /** The collection URL of `hopper`, and of `other`. */
  url: string; otherUrl: string;
  user: string; password: string;
  stop(): Promise<void>;
}

const SOLR_ADMIN = { user: 'solr', password: 'SolrRocks' };
/** Solr's own hash of SolrRocks with its salt: the example security.json of Solr's reference guide. */
const SOLR_ADMIN_HASH = 'IV0EHq1OnNrj6gvRCwvFwTrZ1+z1oBbnQdiVC3otuq0= Ndd7LKvVBAaZIF0QAVi1ekCfAJXr1GGfLtRUXhgrF8c=';

export async function startTestSolrCloud(): Promise<TestSolrCloud> {
  const given = process.env.HOPPER_TEST_SOLR_CLOUD_URL;
  let base: string, admin: { user: string; password: string }, stop = async (): Promise<void> => {};
  let started: StartedTestContainer | undefined;
  if (given) {
    base = given.replace(/\/+$/, '');
    const [user = '', ...rest] = (process.env.HOPPER_TEST_SOLR_CLOUD_ADMIN ?? '').split(':');
    admin = { user, password: rest.join(':') };
  } else {
    started = await new GenericContainer(SOLR_IMAGE)
      .withCommand(['solr-foreground', '-c'])
      .withExposedPorts(8983)
      .withLabels(containerLabels())
      .withWaitStrategy(Wait.forHttp('/solr/admin/info/system', 8983).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start();
    base = `http://127.0.0.1:${started.getMappedPort(8983)}/solr`;
    admin = SOLR_ADMIN;
    const c = started;
    stop = async () => { await c.stop(); };
  }
  let secured = !started;
  const auth = { authorization: `Basic ${Buffer.from(`${admin.user}:${admin.password}`).toString('base64')}` };
  const ask = async (path: string, body?: unknown): Promise<void> => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(60_000),
      headers: { ...(secured ? auth : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`test Solr: ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
  const suffix = Math.random().toString(36).slice(2, 8);
  const [hopper, other] = [`hopper_${suffix}`, `other_${suffix}`];
  for (const name of [hopper, other]) await ask(`/admin/collections?action=CREATE&name=${name}&numShards=1&replicationFactor=1&wt=json`);
  if (started) {
    const security = {
      authentication: { blockUnknown: true, class: 'solr.BasicAuthPlugin', credentials: { [SOLR_ADMIN.user]: SOLR_ADMIN_HASH }, forwardCredentials: false },
      authorization: { class: 'solr.RuleBasedAuthorizationPlugin', 'user-role': { [SOLR_ADMIN.user]: 'admin' }, permissions: [{ name: 'all', role: 'admin' }] },
    };
    await started.copyContentToContainer([{ content: JSON.stringify(security), target: '/tmp/security.json' }]);
    const r = await started.exec(['solr', 'zk', 'cp', 'file:/tmp/security.json', 'zk:/security.json', '-z', 'localhost:9983']);
    if (r.exitCode !== 0) throw new Error(`test Solr: security.json not put in: ${r.output.slice(-300)}`);
    secured = true;
    // Solr reads security.json from ZooKeeper when it changes: wait until a call with no credentials is refused.
    for (let i = 0; ; i++) {
      const res = await fetch(`${base}/admin/info/system`, { signal: AbortSignal.timeout(5_000) });
      if (res.status === 401) break;
      if (i > 100) throw new Error('test Solr: basic auth did not turn on');
      await new Promise((r2) => setTimeout(r2, 200));
    }
  }
  const user = `hopper_${suffix}`, password = `pw-${suffix}-${Math.random().toString(36).slice(2)}`;
  await ask('/admin/authentication', { 'set-user': { [user]: password } });
  // The user's own collection first: Solr uses the first permission that matches a request.
  await ask('/admin/authorization', { 'set-user-role': { [user]: [`app_${suffix}`] }, 'set-permission': { collection: hopper, path: '/*', role: `app_${suffix}`, before: 1 } });
  // Applied once ZooKeeper tells the node: wait until the user reads its collection.
  const own = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  for (let i = 0; ; i++) {
    const res = await fetch(`${base}/${hopper}/select?q=*:*&rows=0&wt=json`, { headers: { authorization: own }, signal: AbortSignal.timeout(5_000) });
    if (res.ok) break;
    if (i > 100) throw new Error(`test Solr: the user cannot read its collection (${res.status})`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
  return { url: `${base}/${hopper}`, otherUrl: `${base}/${other}`, user, password, stop };
}
