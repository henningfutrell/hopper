// vitest globalSetup: the Postgres every test runs against (design.md "Database"). A throwaway
// container (testcontainers), removed after the run, unless HOPPER_TEST_POSTGRES_URL already
// names a database to use. Workers inherit the URL; each test gets its own schema in it
// (support/database.ts). Needs docker (or podman's docker socket). Labelled with this process's pid, so
// a crashed run's container is swept by the next run (support/sweep.ts). Its shared memory is 1 GiB, not the
// runtime's 64 MiB default: with every worker connected, Postgres ran out of it and restarted mid-run (57P03, issue #1038).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PID_LABEL } from './sweep.ts';

/** The test Postgres's shared memory, in bytes. */
const SHARED_MEMORY = 1024 ** 3;

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.HOPPER_TEST_POSTGRES_URL) return undefined;
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(process.env.POSTGRES_IMAGE ?? 'postgres:17-alpine')
    .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
    .withSharedMemorySize(SHARED_MEMORY)
    .withLabels({ [PID_LABEL]: String(process.pid) })
    .start();
  process.env.HOPPER_TEST_POSTGRES_URL = container.getConnectionUri();
  return async () => { await container.stop(); };
}
