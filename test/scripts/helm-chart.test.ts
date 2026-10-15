// The Helm chart (issue #1281 part 1, docs/deploy.md "On Kubernetes, with Helm"): `helm install` alone brings up the hopper
// in a cluster — its Postgres, OpenFGA and Solr, as compose.yaml does — with no container runtime socket, no host path and
// no settings to start. Issue #1288: the master key from a mounted Secret (one the admin makes, or an External Secrets
// Operator ExternalSecret fills), and AWS KMS for the vault's data key. Asserted on what `helm template` renders: `helm`
// on PATH, else Helm's image through the docker CLI, the chart mounted read-only.
import { describe, expect, it } from 'vitest';
import { composeImage, type Container, container, env, type ExternalSecret, find, helm, pod, render, type Resource, workloads } from '../support/helm-chart.ts';

describe('the Helm chart, installed with no values', () => {
  const rs = render();
  const hopper = find(rs, 'Deployment', 'hopper');
  const daemon = container(hopper, 'hopper');

  it('passes helm lint', () => {
    const out = helm(['lint', '/chart', '--strict']);
    expect(out.status, out.stdout + out.stderr).toBe(0);
  });

  it('runs the hopper, its Postgres, OpenFGA and Solr', () => {
    expect(daemon.image).toBe('ghcr.io/henningfutrell/hopper:latest');
    find(rs, 'StatefulSet', 'hopper-postgres');
    find(rs, 'Deployment', 'hopper-openfga');
    find(rs, 'StatefulSet', 'hopper-solr');
  });

  it('runs one hopper, never two at once: one database writer, one home volume', () => {
    expect(hopper.spec?.replicas).toBe(1);
    expect(hopper.spec?.strategy?.type).toBe('Recreate');
  });

  it('uses the images compose.yaml pins, so both installs run the same Postgres, OpenFGA and Solr', () => {
    expect(container(find(rs, 'StatefulSet', 'hopper-postgres'), 'postgres').image).toBe(composeImage('postgres'));
    expect(container(find(rs, 'Deployment', 'hopper-openfga'), 'openfga').image).toBe(composeImage('openfga'));
    expect(container(find(rs, 'StatefulSet', 'hopper-solr'), 'solr').image).toBe(composeImage('solr'));
  });

  it('needs nothing of the node: no host path, no container runtime socket, nothing privileged', () => {
    for (const w of workloads(rs)) {
      const p = pod(w);
      for (const v of p.volumes ?? []) expect(v.hostPath, `${w.metadata.name} volume ${v.name}`).toBeUndefined();
      for (const c of [...p.containers, ...(p.initContainers ?? [])]) {
        for (const m of c.volumeMounts ?? []) expect(m.mountPath, `${w.metadata.name}/${c.name}`).not.toMatch(/\.sock$|^\/run\/podman|^\/var\/run\/docker/);
        for (const e of c.env ?? []) expect(e.name, `${w.metadata.name}/${c.name}`).not.toMatch(/^HOPPER_(PODMAN|DOCKER)_SOCKET$/);
        expect(c.securityContext?.privileged ?? false, `${w.metadata.name}/${c.name}`).toBe(false);
        expect(c.securityContext?.allowPrivilegeEscalation, `${w.metadata.name}/${c.name}`).toBe(false);
        expect(c.securityContext?.capabilities?.drop, `${w.metadata.name}/${c.name}`).toContain('ALL');
      }
      expect(p.securityContext?.runAsNonRoot, w.metadata.name).toBe(true);
      expect(p.automountServiceAccountToken, w.metadata.name).toBe(false);
    }
  });

  // Kubernetes gives a pod <SERVICE>_PORT=tcp://… for each Service by default: for the Service `hopper`, HOPPER_PORT and
  // a score of HOPPER_* variables the hopper reads as leftovers.
  it('gives no pod the Service link variables, which name HOPPER_* variables of their own', () => {
    for (const w of workloads(rs)) expect(pod(w).enableServiceLinks, w.metadata.name).toBe(false);
  });

  it('starts the hopper once Postgres takes connections, not in a crash loop before', () => {
    const wait = pod(hopper).initContainers?.find((c) => c.name === 'wait-for-postgres');
    expect(wait?.image).toBe(composeImage('postgres'));
    expect(wait?.command?.join(' ')).toContain('pg_isready -q -h hopper-postgres');
  });

  it('gives the hopper its database URL and OpenFGA\'s key as files of a generated Secret, kept across an uninstall', () => {
    const secret = find(rs, 'Secret', 'hopper-runtime');
    expect(secret.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    const values = secret.stringData ?? {};
    expect(Object.keys(values).sort()).toEqual(['database_url', 'openfga_datastore_uri', 'openfga_key', 'postgres_password', 'vault_key']);
    expect(values.database_url).toBe(`postgres://hopper:${values.postgres_password}@hopper-postgres:5432/hopper`);
    expect(values.openfga_datastore_uri).toBe(`postgres://hopper:${values.postgres_password}@hopper-postgres:5432/hopper?sslmode=disable&search_path=openfga`);
    expect(values.postgres_password).toMatch(/^[A-Za-z0-9]{32,}$/);
    expect(values.openfga_key).toMatch(/^[A-Za-z0-9]{32,}$/);
    expect(env(daemon, 'HOPPER_DATABASE_URL_FILE')?.value).toBe('/run/hopper-secrets/database_url');
    expect(env(daemon, 'HOPPER_OPENFGA_KEY_FILE')?.value).toBe('/run/hopper-secrets/openfga_key');
    expect(pod(hopper).volumes?.find((v) => v.secret)?.secret?.secretName).toBe('hopper-runtime');
  });

  it('takes the master key from a Secret the admin makes, and starts without it: the first start makes one', () => {
    const key = env(daemon, 'HOPPER_MASTER_KEY')?.valueFrom?.secretKeyRef;
    expect(key).toEqual({ name: 'hopper-master-key', key: 'master-key', optional: true });
    expect(rs.find((r) => r.kind === 'Secret' && r.metadata.name === 'hopper-master-key')).toBeUndefined();
    const previous = env(daemon, 'HOPPER_MASTER_KEY_PREVIOUS')?.valueFrom?.secretKeyRef;
    expect(previous).toEqual({ name: 'hopper-master-key', key: 'previous', optional: true });
  });

  it('reaches OpenFGA and Solr by their Services, and answers on the same port inside and out', () => {
    expect(env(daemon, 'HOPPER_OPENFGA_URL')?.value).toBe('http://hopper-openfga:8080');
    expect(env(daemon, 'HOPPER_SOLR_URL')?.value).toBe('http://hopper-solr:8983/solr/hopper');
    expect(env(daemon, 'HOPPER_PORT')?.value).toBe('4790');
    expect(daemon.ports?.[0]?.containerPort).toBe(4790);
    expect(find(rs, 'Service', 'hopper').spec?.ports?.[0]?.port).toBe(4790);
  });

  it('answers the cluster by its Service names, from the pod network, and is not public', () => {
    expect(env(daemon, 'HOPPER_LAN_NAMES')?.value).toBe('hopper,hopper.hopper,hopper.hopper.svc,hopper.hopper.svc.cluster.local');
    expect(env(daemon, 'HOPPER_LAN_PEERS')?.value).toBe('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16');
    expect(env(daemon, 'HOPPER_PUBLIC_URL')).toBeUndefined();
    expect(rs.filter((r) => r.kind === 'Ingress')).toEqual([]);
  });

  it('keeps the hopper\'s home (the claude sign-in) on a volume of its own', () => {
    const home = container(hopper, 'hopper').volumeMounts?.find((m) => m.mountPath === '/home/node');
    expect(home).toBeDefined();
    const claim = pod(hopper).volumes?.find((v) => v.name === home?.name)?.persistentVolumeClaim?.claimName;
    expect(claim).toBe('hopper-home');
    find(rs, 'PersistentVolumeClaim', 'hopper-home');
  });

  it('migrates OpenFGA\'s schema before OpenFGA starts, with the datastore it serves', () => {
    const fga = find(rs, 'Deployment', 'hopper-openfga');
    const migrate = pod(fga).initContainers?.find((c) => c.name === 'migrate');
    expect(migrate?.args).toEqual(['migrate']);
    for (const c of [migrate, container(fga, 'openfga')]) {
      expect(env(c as Container, 'OPENFGA_DATASTORE_URI')?.valueFrom?.secretKeyRef).toEqual({ name: 'hopper-runtime', key: 'openfga_datastore_uri' });
    }
    const run = container(fga, 'openfga');
    expect(env(run, 'OPENFGA_AUTHN_METHOD')?.value).toBe('preshared');
    expect(env(run, 'OPENFGA_AUTHN_PRESHARED_KEYS')?.valueFrom?.secretKeyRef).toEqual({ name: 'hopper-runtime', key: 'openfga_key' });
    expect(env(run, 'OPENFGA_PLAYGROUND_ENABLED')?.value).toBe('false');
  });

  it('lets only the hopper and OpenFGA reach Postgres, and only the hopper reach OpenFGA and Solr', () => {
    const from = (name: string): string[] => (find(rs, 'NetworkPolicy', name).spec?.ingress ?? [])
      .flatMap((i) => i.from ?? []).map((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/component'] ?? '?').sort();
    expect(from('hopper-postgres')).toEqual(['hopper', 'openfga']);
    expect(from('hopper-openfga')).toEqual(['hopper']);
    expect(from('hopper-solr')).toEqual(['hopper']);
  });
});

describe('the Helm chart, with values', () => {
  it('runs the update channel the image tag names', () => {
    const rs = render('image.tag=dev');
    expect(container(find(rs, 'Deployment', 'hopper'), 'hopper').image).toBe('ghcr.io/henningfutrell/hopper:dev');
  });

  it('publishes the hopper through an Ingress, and that host is its public URL', () => {
    const rs = render('ingress.enabled=true', 'ingress.host=hopper.example.org');
    expect(find(rs, 'Ingress', 'hopper').spec?.rules?.[0]?.host).toBe('hopper.example.org');
    expect(env(container(find(rs, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_PUBLIC_URL')?.value).toBe('https://hopper.example.org');
  });

  it('refuses an Ingress with no host', () => {
    const out = helm(['template', 'hopper', '/chart', '--set', 'ingress.enabled=true']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/ingress\.host/);
  });

  // Issue #1288: a Secret the admin names is mounted as files; the hopper reads the key from the file, and refuses to
  // start when it is not there. The key before a rotation is the Secret's `previous`.
  const keyFromFiles = (rs: Resource[], secretName: string): void => {
    const hopper = find(rs, 'Deployment', 'hopper');
    const daemon = container(hopper, 'hopper');
    expect(env(daemon, 'HOPPER_MASTER_KEY')).toBeUndefined();
    expect(env(daemon, 'HOPPER_MASTER_KEY_PREVIOUS')).toBeUndefined();
    expect(env(daemon, 'HOPPER_MASTER_KEY_FILE')?.value).toBe('/run/hopper-master-key/master-key');
    expect(env(daemon, 'HOPPER_MASTER_KEY_PREVIOUS_FILE')?.value).toBe('/run/hopper-master-key/previous');
    const mount = daemon.volumeMounts?.find((m) => m.mountPath === '/run/hopper-master-key');
    expect(mount?.readOnly).toBe(true);
    expect(pod(hopper).volumes?.find((v) => v.name === mount?.name)?.secret?.secretName).toBe(secretName);
  };

  it('mounts the master key Secret it is given, and the hopper reads the key from its file', () => {
    keyFromFiles(render('masterKey.existingSecret=my-key'), 'my-key');
  });

  it('fills the master key Secret from an outside store through an External Secrets Operator ExternalSecret', () => {
    const rs = render(
      'masterKey.externalSecret.enabled=true', 'masterKey.externalSecret.secretStoreRef.name=vault-store',
      'masterKey.externalSecret.masterKey.key=hopper/master-key', 'masterKey.externalSecret.previous.key=hopper/master-key-previous',
    );
    keyFromFiles(rs, 'hopper-master-key');
    const es = rs.find((r) => r.kind === 'ExternalSecret') as unknown as ExternalSecret;
    expect(es.metadata.name).toBe('hopper-master-key');
    expect(es.spec.secretStoreRef).toEqual({ name: 'vault-store', kind: 'ClusterSecretStore' });
    expect(es.spec.target.name).toBe('hopper-master-key');
    expect(es.spec.data).toEqual([
      { secretKey: 'master-key', remoteRef: { key: 'hopper/master-key' } },
      { secretKey: 'previous', remoteRef: { key: 'hopper/master-key-previous' } },
    ]);
  });

  it('refuses an ExternalSecret with no store or no key to read', () => {
    const out = helm(['template', 'hopper', '/chart', '--set', 'masterKey.externalSecret.enabled=true']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/masterKey\.externalSecret\./);
  });

  it('makes no ExternalSecret unless asked', () => {
    expect(render().filter((r) => r.kind === 'ExternalSecret')).toEqual([]);
  });

  it('wraps the vault\'s data key with AWS KMS, as the service account\'s role', () => {
    const rs = render(
      'kms.aws.region=eu-west-1', 'kms.aws.key=alias/hopper-vault',
      'serviceAccount.create=true', 'serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=arn:aws:iam::123456789012:role/hopper-vault',
    );
    const hopper = find(rs, 'Deployment', 'hopper');
    const daemon = container(hopper, 'hopper');
    expect(env(daemon, 'HOPPER_KMS_REGION')?.value).toBe('eu-west-1');
    expect(env(daemon, 'HOPPER_KMS_KEY')?.value).toBe('alias/hopper-vault');
    expect(env(daemon, 'HOPPER_KMS_URL')).toBeUndefined();
    expect(pod(hopper).serviceAccountName).toBe('hopper');
    expect(find(rs, 'ServiceAccount', 'hopper').metadata.annotations?.['eks.amazonaws.com/role-arn']).toBe('arn:aws:iam::123456789012:role/hopper-vault');
  });

  it('refuses AWS KMS with no key: the hopper never makes one in AWS', () => {
    const out = helm(['template', 'hopper', '/chart', '--set', 'kms.aws.region=eu-west-1']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/kms\.aws\.key/);
  });

  it('names no KMS and no service account of its own unless asked', () => {
    const rs = render();
    const hopper = find(rs, 'Deployment', 'hopper');
    expect(env(container(hopper, 'hopper'), 'HOPPER_KMS_REGION')).toBeUndefined();
    expect(pod(hopper).serviceAccountName).toBeUndefined();
    expect(rs.filter((r) => r.kind === 'ServiceAccount')).toEqual([]);
  });

  it('runs no Solr when search is off, and the hopper then has no search', () => {
    const rs = render('solr.enabled=false');
    expect(rs.filter((r) => r.metadata.name === 'hopper-solr')).toEqual([]);
    expect(env(container(find(rs, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_SOLR_URL')).toBeUndefined();
  });

  it('makes no NetworkPolicy when they are off', () => {
    expect(render('networkPolicy.enabled=false').filter((r) => r.kind === 'NetworkPolicy')).toEqual([]);
  });
});
