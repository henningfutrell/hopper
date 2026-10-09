// A HashiCorp Vault for the vault backend tests (issue #585): the one HOPPER_TEST_VAULT_ADDR and HOPPER_TEST_VAULT_TOKEN
// name, else a throwaway dev-mode server in a container (testcontainers), on loopback. Its KV v2 engine is at `secret`.
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export interface TestVault {
  addr: string;
  token: string;
  /** Writes `data` at `path` of the KV v2 engine `secret`, as a person would in Vault. */
  write(path: string, data: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
}

const ROOT = 'hopper-test-root';

export async function startTestVault(): Promise<TestVault> {
  let container: StartedTestContainer | undefined;
  let addr = process.env.HOPPER_TEST_VAULT_ADDR;
  let token = process.env.HOPPER_TEST_VAULT_TOKEN ?? ROOT;
  if (!addr) {
    container = await new GenericContainer(process.env.VAULT_IMAGE ?? 'hashicorp/vault:1.20')
      .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: ROOT, VAULT_DEV_LISTEN_ADDRESS: '0.0.0.0:8200' })
      .withAddedCapabilities('IPC_LOCK')
      .withExposedPorts(8200)
      .start();
    addr = `http://127.0.0.1:${container.getMappedPort(8200)}`;
    token = ROOT;
  }
  const base = addr;
  return {
    addr: base, token,
    async write(path, data) {
      const res = await fetch(`${base}/v1/secret/data/${path}`, { method: 'POST', headers: { 'x-vault-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
      if (!res.ok) throw new Error(`vault write ${path}: ${res.status} ${await res.text()}`);
    },
    stop: async () => { await container?.stop(); },
  };
}
