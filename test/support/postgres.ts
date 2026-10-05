// vitest globalSetup: the Postgres every test runs against (design.md "Database"). A throwaway
// container (testcontainers), removed after the run, unless HOPPER_TEST_POSTGRES_URL already
// names a database to use. Workers inherit the URL; each test gets its own schema in it
// (support/database.ts). Needs docker (or podman's docker socket).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.HOPPER_TEST_POSTGRES_URL) return undefined;
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(process.env.POSTGRES_IMAGE ?? 'postgres:17-alpine')
    .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
    .start();
  process.env.HOPPER_TEST_POSTGRES_URL = container.getConnectionUri();
  return async () => { await container.stop(); };
}
