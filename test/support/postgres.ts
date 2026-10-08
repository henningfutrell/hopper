// vitest globalSetup: the Postgres every test runs against (design.md "Database"). A throwaway
// container (testcontainers), removed after the run, unless HOPPER_TEST_POSTGRES_URL already
// names a database to use. Workers inherit the URL; each test gets its own schema in it
// (support/database.ts). Needs docker (or podman's docker socket). Labelled with this process's pid, so
// a crashed run's container is swept by the next run (support/sweep.ts).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PID_LABEL } from './sweep.ts';

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.HOPPER_TEST_POSTGRES_URL) return undefined;
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(process.env.POSTGRES_IMAGE ?? 'postgres:17-alpine')
    .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
    .withLabels({ [PID_LABEL]: String(process.pid) })
    .start();
  process.env.HOPPER_TEST_POSTGRES_URL = container.getConnectionUri();
  return async () => { await container.stop(); };
}
