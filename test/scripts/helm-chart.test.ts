// The Helm chart (issue #1281 part 1, docs/deploy.md "On Kubernetes, with Helm"): `helm install` alone brings up the hopper
// in a cluster — its Postgres, OpenFGA and Solr, as compose.yaml does — with no container runtime socket, no host path and
// no settings to start. Issue #1288: the master key from a mounted Secret (one the admin makes, or an External Secrets
// Operator ExternalSecret fills), and AWS KMS for the vault's data key. Asserted on what `helm template` renders: `helm`
// on PATH, else Helm's image through the docker CLI, the chart mounted read-only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeImage, container, env, type ExternalSecret, find, helm, pod, render, type Resource, workloads } from '../support/helm-chart.ts';

const ROOT = join(import.meta.dirname, '..', '..');

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

  it('gives the hopper its database URL, OpenFGA\'s key and the tunnel key as files of a generated Secret, kept across an uninstall', () => {
    const secret = find(rs, 'Secret', 'hopper-runtime');
    expect(secret.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    const values = secret.stringData ?? {};
    expect(Object.keys(values).sort()).toEqual(['database_url', 'openfga_datastore_uri', 'openfga_key', 'postgres_password', 'tunnel_key', 'vault_key']);
    expect(values.database_url).toBe(`postgres://hopper:${values.postgres_password}@hopper-postgres:5432/hopper`);
    expect(values.openfga_datastore_uri).toBe(`postgres://hopper:${values.postgres_password}@hopper-postgres:5432/hopper?sslmode=disable&search_path=openfga`);
    expect(values.postgres_password).toMatch(/^[A-Za-z0-9]{32,}$/);
    expect(values.openfga_key).toMatch(/^[A-Za-z0-9]{32,}$/);
    expect(env(daemon, 'HOPPER_DATABASE_URL_FILE')?.value).toBe('/run/hopper-secrets/database_url');
    expect(env(daemon, 'HOPPER_OPENFGA_KEY_FILE')?.value).toBe('/run/hopper-secrets/openfga_key');
    expect(pod(hopper).volumes?.find((v) => v.secret)?.secret?.secretName).toBe('hopper-runtime');
  });

  // Issue #1406: `helm install` alone keeps the master key. The chart makes the key in the Secret <release>-master-key,
  // kept across upgrades and an uninstall, and the hopper reads it from its file: a pod restart opens the same secrets.
  it('makes the master key in a Secret of its own, kept across an uninstall, and the hopper reads it from its file', () => {
    const secret = find(rs, 'Secret', 'hopper-master-key');
    expect(secret.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(Object.keys(secret.stringData ?? {})).toEqual(['master-key']);
    expect(secret.stringData?.['master-key']).toMatch(/^[0-9a-f]{64}$/);
    expect(env(daemon, 'HOPPER_MASTER_KEY')).toBeUndefined();
    expect(env(daemon, 'HOPPER_MASTER_KEY_FILE')?.value).toBe('/run/hopper-master-key/master-key');
    const mount = daemon.volumeMounts?.find((m) => m.mountPath === '/run/hopper-master-key');
    expect(pod(hopper).volumes?.find((v) => v.name === mount?.name)?.secret?.secretName).toBe('hopper-master-key');
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

  it('migrates OpenFGA\'s schema in a Job, and OpenFGA serves the datastore it migrated', () => {
    const fga = find(rs, 'Deployment', 'hopper-openfga');
    expect(pod(fga).initContainers).toBeUndefined();
    const jobs = rs.filter((r) => r.kind === 'Job');
    expect(jobs.map((j) => j.metadata.name)).toEqual([expect.stringMatching(/^hopper-openfga-migrate-[0-9a-f]{10}$/)]);
    const migrate = container(jobs[0]!, 'migrate');
    expect(migrate.args).toEqual(['migrate']);
    for (const c of [migrate, container(fga, 'openfga')]) {
      expect(env(c, 'OPENFGA_DATASTORE_URI')?.valueFrom?.secretKeyRef).toEqual({ name: 'hopper-runtime', key: 'openfga_datastore_uri' });
    }
    const run = container(fga, 'openfga');
    expect(env(run, 'OPENFGA_AUTHN_METHOD')?.value).toBe('preshared');
    expect(env(run, 'OPENFGA_AUTHN_PRESHARED_KEYS')?.valueFrom?.secretKeyRef).toEqual({ name: 'hopper-runtime', key: 'openfga_key' });
    expect(env(run, 'OPENFGA_PLAYGROUND_ENABLED')?.value).toBe('false');
  });

  it('lets only the hopper, OpenFGA and its migration reach Postgres, and only the hopper reach OpenFGA and Solr', () => {
    const from = (name: string): string[] => (find(rs, 'NetworkPolicy', name).spec?.ingress ?? [])
      .flatMap((i) => i.from ?? []).map((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/component'] ?? '?').sort();
    expect(from('hopper-postgres')).toEqual(['hopper', 'openfga', 'openfga-migrate']);
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
    expect(render('masterKey.existingSecret=my-key').filter((r) => r.kind === 'Secret' && r.metadata.name.includes('master-key'))).toEqual([]);
  });

  // Issue #1406: a key the person brings, through values.
  it('puts the key masterKey.value gives in its Secret', () => {
    const key = 'ab'.repeat(32);
    const rs = render(`masterKey.value=${key}`);
    keyFromFiles(rs, 'hopper-master-key');
    expect(find(rs, 'Secret', 'hopper-master-key').stringData).toEqual({ 'master-key': key });
    const base64 = Buffer.alloc(32, 7).toString('base64');
    expect(find(render(`masterKey.value=${base64}`), 'Secret', 'hopper-master-key').stringData).toEqual({ 'master-key': base64 });
  });

  it('refuses a masterKey.value that is no master key, and one beside masterKey.existingSecret', () => {
    const short = helm(['template', 'hopper', '/chart', '--set', 'masterKey.value=abc']);
    expect(short.status).not.toBe(0);
    expect(short.stderr).toMatch(/masterKey\.value: .*64 hex digits/);
    const both = helm(['template', 'hopper', '/chart', '--set', `masterKey.value=${'ab'.repeat(32)}`, '--set', 'masterKey.existingSecret=my-key']);
    expect(both.status).not.toBe(0);
    expect(both.stderr).toMatch(/masterKey\.value/);
  });

  // An upgrade of a release with no master key Secret: its hopper made its key at the first start and holds it only in
  // memory. A new key now would lose the key that seals every secret it keeps, so the upgrade stops before any pod does.
  it('refuses an upgrade that finds no master key Secret, unless masterKey.value gives the key', () => {
    const out = helm(['template', 'hopper', '/chart', '--is-upgrade']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/no Secret hopper-master-key/);
    expect(out.stderr).toMatch(/masterKey\.value/);
    expect(helm(['template', 'hopper', '/chart', '--is-upgrade', '--set', `masterKey.value=${'ab'.repeat(32)}`]).status).toBe(0);
    expect(helm(['template', 'hopper', '/chart', '--is-upgrade', '--set', 'masterKey.existingSecret=my-key']).status).toBe(0);
  });

  it('fills the master key Secret from an outside store through an External Secrets Operator ExternalSecret', () => {
    const rs = render(
      'masterKey.externalSecret.enabled=true', 'masterKey.externalSecret.secretStoreRef.name=vault-store',
      'masterKey.externalSecret.masterKey.key=hopper/master-key', 'masterKey.externalSecret.previous.key=hopper/master-key-previous',
    );
    keyFromFiles(rs, 'hopper-master-key');
    expect(rs.filter((r) => r.kind === 'Secret' && r.metadata.name === 'hopper-master-key')).toEqual([]);
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

  // Issue #1373: hopper-cluster.sh migrate installs the release with the hopper at 0 while it moves a compose install's data
  // in, publishes it on this host's port on a cluster bootstrap made, and names the names machines dialled the compose
  // hopper by.
  it('runs no hopper with replicas=0, and never more than one', () => {
    expect(find(render('replicas=0'), 'Deployment', 'hopper').spec?.replicas).toBe(0);
    for (const n of ['2', '-1']) {
      const out = helm(['template', 'hopper', '/chart', '--set', `replicas=${n}`]);
      expect(out.status, n).not.toBe(0);
      expect(out.stderr).toMatch(/replicas is 0 or 1/);
    }
  });

  it('puts the hopper\'s Service on the cluster\'s load balancer, at its port, with service.type', () => {
    const type = (rs: Resource[]) => (find(rs, 'Service', 'hopper').spec as { type?: string }).type;
    expect(type(render())).toBe('ClusterIP');
    const rs = render('service.type=LoadBalancer', 'port=4801');
    expect(type(rs)).toBe('LoadBalancer');
    expect(find(rs, 'Service', 'hopper').spec?.ports?.[0]?.port).toBe(4801);
    const out = helm(['template', 'hopper', '/chart', '--set', 'service.type=ExternalName']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/service\.type/);
  });

  it('pins the Service\'s node port with service.nodePort, for NodePort and LoadBalancer, and else lets Kubernetes pick one (issue #1407)', () => {
    const nodePort = (rs: Resource[]) => find(rs, 'Service', 'hopper').spec?.ports?.[0]?.nodePort;
    expect(nodePort(render('service.type=NodePort'))).toBeUndefined();
    expect(nodePort(render('service.type=NodePort', 'service.nodePort=30791'))).toBe(30791);
    expect(nodePort(render('service.type=LoadBalancer', 'service.nodePort=30791'))).toBe(30791);
    const out = helm(['template', 'hopper', '/chart', '--set', 'service.nodePort=30791']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/service\.nodePort/);
  });

  it('is in the image, so hopper-cluster.sh migrate installs the chart of the version the compose install runs', () => {
    expect(readFileSync(join(ROOT, 'Dockerfile'), 'utf8')).toMatch(/^COPY deploy\/helm \.\/deploy\/helm$/m);
    expect(readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n')).not.toContain('deploy');
  });

  // Issue #1421: a request through a port-forward, a node port or a load balancer under this host's own name or address
  // got 421. allowedHosts adds names to the Host guard's LAN names, through Helm values alone.
  it('answers to the names allowedHosts gives too, after its Service\'s names (issue #1421)', () => {
    const rs = render('allowedHosts={box.lan, box.tailnet.ts.net,192.0.2.7}');
    expect(env(container(find(rs, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_LAN_NAMES')?.value)
      .toBe('hopper,hopper.hopper,hopper.hopper.svc,hopper.hopper.svc.cluster.local,box.lan,box.tailnet.ts.net,192.0.2.7');
  });

  it('answers to the load balancer address service.loadBalancerIP asks for, and gives it to the Service (issue #1421)', () => {
    const rs = render('service.type=LoadBalancer', 'service.loadBalancerIP=192.0.2.8', 'allowedHosts={box.lan}');
    expect(find(rs, 'Service', 'hopper').spec?.loadBalancerIP).toBe('192.0.2.8');
    expect(env(container(find(rs, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_LAN_NAMES')?.value)
      .toBe('hopper,hopper.hopper,hopper.hopper.svc,hopper.hopper.svc.cluster.local,box.lan,192.0.2.8');
    expect(find(render('service.type=LoadBalancer'), 'Service', 'hopper').spec?.loadBalancerIP).toBeUndefined();
    const out = helm(['template', 'hopper', '/chart', '--set', 'service.loadBalancerIP=192.0.2.8']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/service\.loadBalancerIP/);
  });

  // The ingress host is the public URL's host, which the Host guard takes already as a public request. As a LAN name it
  // would make each request through the ingress a LAN request.
  it('keeps the ingress host out of the LAN names: a request through it stays a public request', () => {
    const rs = render('ingress.enabled=true', 'ingress.host=hopper.example.com');
    expect(env(container(find(rs, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_LAN_NAMES')?.value).not.toMatch(/hopper\.example\.com/);
    expect(env(container(find(rs, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_PUBLIC_URL')?.value).toBe('https://hopper.example.com');
  });

  it('refuses lanNames, the name allowedHosts had before, so an upgrade with old values loses no name', () => {
    const out = helm(['template', 'hopper', '/chart', '--set', 'lanNames=box.lan']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/allowedHosts/);
  });
});
