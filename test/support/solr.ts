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
