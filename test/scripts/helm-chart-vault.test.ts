// The Helm chart's optional services (issue #1281 part 1, docs/deploy.md "On Kubernetes, with Helm"), as compose.yaml's
// profiles `hopper-vault` and `kms` (issue #586): the hopper's vault in a pod of its own, reached with a preshared key,
// and a local KMS that wraps the vault's data key. Off by default: the vault then runs in the hopper, under the master
// key. Asserted on what `helm template` renders.
import { describe, expect, it } from 'vitest';
import { composeImage, type Container, container, env, find, helm, pod, render, type Resource, workloads } from '../support/helm-chart.ts';

const from = (rs: Resource[], name: string): string[] => (find(rs, 'NetworkPolicy', name).spec?.ingress ?? [])
  .flatMap((i) => i.from ?? []).map((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/component'] ?? '?').sort();

const KMS_VARIABLES = ['HOPPER_KMS_URL', 'HOPPER_KMS_REGION', 'HOPPER_KMS_KEY'];
const kmsOf = (c: Container): Record<string, string | undefined> =>
  Object.fromEntries(KMS_VARIABLES.flatMap((n) => (env(c, n) ? [[n, env(c, n)?.value]] : [])));

describe('the Helm chart\'s optional services, off', () => {
  const rs = render();
  const daemon = container(find(rs, 'Deployment', 'hopper'), 'hopper');

  it('runs no vault pod and no KMS: the vault runs in the hopper, under the master key', () => {
    expect(rs.filter((r) => ['hopper-vault', 'hopper-kms'].includes(r.metadata.name))).toEqual([]);
    expect(env(daemon, 'HOPPER_VAULT_URL')).toBeUndefined();
    expect(env(daemon, 'HOPPER_VAULT_KEY_FILE')).toBeUndefined();
    expect(kmsOf(daemon)).toEqual({});
  });

  it('makes the vault\'s preshared key at the first install all the same, so turning the vault pod on later keeps it', () => {
    expect(find(rs, 'Secret', 'hopper-runtime').stringData?.vault_key).toMatch(/^[A-Za-z0-9]{32,}$/);
  });
});

describe('the Helm chart\'s vault pod', () => {
  const rs = render('hopperVault.enabled=true');
  const hopper = find(rs, 'Deployment', 'hopper');
  const daemon = container(hopper, 'hopper');
  const vault = find(rs, 'Deployment', 'hopper-vault');
  const v = container(vault, 'hopper-vault');

  it('runs the vault of the hopper\'s own image, alone: one holder of its key', () => {
    expect(v.image).toBe(daemon.image);
    expect(v.args).toEqual(['node', 'src/vault/main.ts']);
    expect(vault.spec?.replicas).toBe(1);
    expect(vault.spec?.strategy?.type).toBe('Recreate');
    expect(find(rs, 'Service', 'hopper-vault').spec?.ports?.[0]?.port).toBe(4791);
  });

  it('gives the vault the database and the master key as it gives the hopper', () => {
    expect(env(v, 'HOPPER_DATABASE_URL_FILE')?.value).toBe('/run/hopper-secrets/database_url');
    expect(env(v, 'HOPPER_MASTER_KEY')).toBeUndefined();
    expect(env(v, 'HOPPER_MASTER_KEY_FILE')?.value).toBe('/run/hopper-master-key/master-key');
    const mount = container(vault, 'hopper-vault').volumeMounts?.find((m) => m.mountPath === '/run/hopper-master-key');
    expect(pod(vault).volumes?.find((x) => x.name === mount?.name)?.secret?.secretName).toBe('hopper-master-key');
  });

  it('reads the master key from its mounted Secret when the hopper does', () => {
    const files = render('hopperVault.enabled=true', 'masterKey.existingSecret=my-key');
    const fv = find(files, 'Deployment', 'hopper-vault');
    const c = container(fv, 'hopper-vault');
    expect(env(c, 'HOPPER_MASTER_KEY')).toBeUndefined();
    expect(env(c, 'HOPPER_MASTER_KEY_FILE')?.value).toBe('/run/hopper-master-key/master-key');
    const mount = c.volumeMounts?.find((m) => m.mountPath === '/run/hopper-master-key');
    expect(mount?.readOnly).toBe(true);
    expect(pod(fv).volumes?.find((x) => x.name === mount?.name)?.secret?.secretName).toBe('my-key');
  });

  it('lets the hopper reach the vault at its Service, with the preshared key both read from the runtime Secret', () => {
    expect(env(daemon, 'HOPPER_VAULT_URL')?.value).toBe('http://hopper-vault:4791');
    for (const [r, c] of [[hopper, daemon], [vault, v]] as const) {
      expect(env(c, 'HOPPER_VAULT_KEY_FILE')?.value, c.name).toBe('/run/hopper-secrets/vault_key');
      const secrets = pod(r).volumes?.find((x) => x.secret?.secretName === 'hopper-runtime')?.secret;
      expect(secrets?.items?.map((i) => i.key), c.name).toContain('vault_key');
    }
  });

  it('needs nothing of the node, and runs as a non-root user with no privilege', () => {
    const p = pod(vault);
    expect(p.securityContext?.runAsNonRoot).toBe(true);
    expect(p.automountServiceAccountToken).toBe(false);
    expect(p.enableServiceLinks).toBe(false);
    for (const x of p.volumes ?? []) expect(x.hostPath, x.name).toBeUndefined();
    for (const c of [...p.containers, ...(p.initContainers ?? [])]) {
      expect(c.securityContext?.allowPrivilegeEscalation, c.name).toBe(false);
      expect(c.securityContext?.capabilities?.drop, c.name).toContain('ALL');
    }
  });

  it('lets only the hopper reach the vault, and the vault reach Postgres', () => {
    expect(from(rs, 'hopper-vault')).toEqual(['hopper']);
    expect(from(rs, 'hopper-postgres')).toEqual(['hopper', 'openfga', 'openfga-migrate', 'vault']);
  });

  it('starts the vault once Postgres takes connections', () => {
    expect(pod(vault).initContainers?.find((c) => c.name === 'wait-for-postgres')?.command?.join(' ')).toContain('pg_isready -q -h hopper-postgres');
  });
});

describe('the Helm chart\'s local KMS', () => {
  it('runs a local KMS with a volume of its own, and the vault in the hopper uses it', () => {
    const rs = render('kms.local.enabled=true');
    const kms = find(rs, 'StatefulSet', 'hopper-kms');
    const c = container(kms, 'kms');
    expect(c.image).toBe(composeImage('kms'));
    expect(c.volumeMounts?.find((m) => m.mountPath === '/data')).toBeDefined();
    expect(kms.spec?.volumeClaimTemplates?.[0]?.spec.resources.requests.storage).toBe('1Gi');
    expect(pod(kms).securityContext?.runAsNonRoot).toBe(true);
    expect(find(rs, 'Service', 'hopper-kms').spec?.ports?.[0]?.port).toBe(8080);
    expect(kmsOf(container(find(rs, 'Deployment', 'hopper'), 'hopper'))).toEqual({ HOPPER_KMS_URL: 'http://hopper-kms:8080' });
    expect(from(rs, 'hopper-kms')).toEqual(['hopper']);
  });

  it('is asked by the vault pod alone when the vault runs in a pod of its own', () => {
    const rs = render('kms.local.enabled=true', 'hopperVault.enabled=true');
    expect(kmsOf(container(find(rs, 'Deployment', 'hopper'), 'hopper'))).toEqual({});
    expect(kmsOf(container(find(rs, 'Deployment', 'hopper-vault'), 'hopper-vault'))).toEqual({ HOPPER_KMS_URL: 'http://hopper-kms:8080' });
    expect(from(rs, 'hopper-kms')).toEqual(['vault']);
  });

  it('refuses a local KMS and AWS KMS at once: one KMS wraps the vault\'s data key', () => {
    const out = helm(['template', 'hopper', '/chart', '--set', 'kms.local.enabled=true', '--set', 'kms.aws.region=eu-west-1', '--set', 'kms.aws.key=alias/hopper-vault']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/kms\.local\.enabled.*kms\.aws\.region|kms\.aws\.region.*kms\.local\.enabled/);
  });
});

describe('AWS KMS with the vault pod', () => {
  const rs = render(
    'hopperVault.enabled=true', 'kms.aws.region=eu-west-1', 'kms.aws.key=alias/hopper-vault',
    'serviceAccount.create=true', 'serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=arn:aws:iam::123456789012:role/hopper-vault',
  );

  it('gives the KMS to the vault pod, as the service account\'s role, and not to the hopper', () => {
    const vault = find(rs, 'Deployment', 'hopper-vault');
    expect(kmsOf(container(vault, 'hopper-vault'))).toEqual({ HOPPER_KMS_REGION: 'eu-west-1', HOPPER_KMS_KEY: 'alias/hopper-vault' });
    expect(pod(vault).serviceAccountName).toBe('hopper');
    expect(kmsOf(container(find(rs, 'Deployment', 'hopper'), 'hopper'))).toEqual({});
  });

  it('runs no local KMS', () => {
    expect(workloads(rs).map((w) => w.metadata.name)).not.toContain('hopper-kms');
  });
});
