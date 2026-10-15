// The Helm chart (issue #1281 part 1, docs/deploy.md "On Kubernetes, with Helm"): `helm install` alone brings up the hopper
// in a cluster — its Postgres, OpenFGA and Solr, as compose.yaml does — with no container runtime socket, no host path and
// no settings to start. Asserted on what `helm template` renders: `helm` on PATH, else Helm's image through the docker
// CLI, the chart mounted read-only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const CHART = join(ROOT, 'deploy', 'helm', 'hopper');
const HELM_IMAGE = 'docker.io/alpine/helm:3.19.0';

interface EnvVar {
  name: string; value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean }; fieldRef?: { fieldPath: string } };
}
interface Container {
  name: string; image: string; args?: string[]; command?: string[]; env?: EnvVar[];
  ports?: { containerPort: number }[];
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
  securityContext?: {
    runAsNonRoot?: boolean; allowPrivilegeEscalation?: boolean; privileged?: boolean; readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[] };
  };
}
interface PodSpec {
  containers: Container[]; initContainers?: Container[];
  securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; fsGroup?: number };
  volumes?: {
    name: string; hostPath?: unknown; secret?: { secretName: string; items?: { key: string; path: string }[] };
    persistentVolumeClaim?: { claimName: string };
  }[];
  automountServiceAccountToken?: boolean;
  terminationGracePeriodSeconds?: number;
  enableServiceLinks?: boolean;
}
interface Resource {
  apiVersion: string; kind: string;
  metadata: { name: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  spec?: {
    replicas?: number; strategy?: { type: string }; podManagementPolicy?: string;
    persistentVolumeClaimRetentionPolicy?: { whenScaled?: string; whenDeleted?: string };
    volumeClaimTemplates?: { metadata: { name: string }; spec: { resources: { requests: { storage: string } } } }[];
    selector?: Record<string, string> | { matchLabels?: Record<string, string> };
    policyTypes?: string[];
    template?: { spec: PodSpec; metadata?: { labels?: Record<string, string> } };
    ports?: { port: number; targetPort?: number | string }[];
    rules?: { host: string }[];
    podSelector?: { matchLabels?: Record<string, string> };
    ingress?: { from?: { podSelector?: { matchLabels?: Record<string, string> } }[] }[];
    egress?: unknown[];
  };
  stringData?: Record<string, string>;
  data?: Record<string, string>;
}

function helm(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const opts = { encoding: 'utf8' as const, env: { ...process.env } };
  const local = spawnSync('helm', args.map((a) => a.replace('/chart', CHART)), opts);
  if (!local.error) return local;
  // The docker CLI, as every container test here: DOCKER_HOST names a podman socket when that is the runtime. Podman's
  // Docker API gives a container a pids limit too small for Go's threads unless one is named.
  return spawnSync('docker', ['run', '--rm', '--pids-limit=512', '-v', `${CHART}:/chart:ro`, HELM_IMAGE, ...args], { ...opts, timeout: 300_000 });
}

/** `helm template` of the chart with `set` (`key=value`), every document parsed. */
function render(...set: string[]): Resource[] {
  const out = helm(['template', 'hopper', '/chart', '--namespace', 'hopper', ...set.flatMap((s) => ['--set', s])]);
  expect(out.status, out.stderr).toBe(0);
  return parseAllDocuments(out.stdout).map((d) => d.toJS() as Resource | null).filter((r): r is Resource => r !== null);
}

const find = (rs: Resource[], kind: string, name: string): Resource => {
  const r = rs.find((x) => x.kind === kind && x.metadata.name === name);
  if (!r) throw new Error(`no ${kind} ${name}: ${rs.map((x) => `${x.kind}/${x.metadata.name}`).join(', ')}`);
  return r;
};
const pod = (r: Resource): PodSpec => {
  const s = r.spec?.template?.spec;
  if (!s) throw new Error(`${r.kind} ${r.metadata.name} has no pod`);
  return s;
};
const container = (r: Resource, name: string): Container => {
  const c = pod(r).containers.find((x) => x.name === name);
  if (!c) throw new Error(`${r.metadata.name} has no container ${name}`);
  return c;
};
const env = (c: Container, name: string): EnvVar | undefined => c.env?.find((e) => e.name === name);
const workloads = (rs: Resource[]): Resource[] => rs.filter((r) => ['Deployment', 'StatefulSet', 'Job', 'DaemonSet'].includes(r.kind));
const composeImage = (service: string): string => {
  const c = parse(readFileSync(join(ROOT, 'compose.yaml'), 'utf8')) as { services: Record<string, { image: string }> };
  const s = c.services[service];
  if (!s) throw new Error(`compose.yaml has no ${service}`);
  return s.image;
};

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
    expect(Object.keys(values).sort()).toEqual(['database_url', 'openfga_datastore_uri', 'openfga_key', 'postgres_password']);
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

  it('names the master key Secret it is given', () => {
    const rs = render('masterKey.existingSecret=my-key');
    const key = env(container(find(rs, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_MASTER_KEY')?.valueFrom?.secretKeyRef;
    expect(key?.name).toBe('my-key');
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

// Lane pods (issue #1284, docs/deploy.md "Lane pods on Kubernetes"): a StatefulSet of machines that join the hopper by
// dialling out with the lane pool key, one machine per pod under its pod's name. No sshd, no inbound port.
describe('the Helm chart\'s lane pods', () => {
  const rs = render('lanes.replicas=3');
  const lanes = find(rs, 'StatefulSet', 'hopper-lanes');
  const join = pod(lanes).initContainers?.find((c) => c.name === 'join');
  const lane = container(lanes, 'lane');
  const daemon = container(find(rs, 'Deployment', 'hopper'), 'hopper');
  const mounts = (c: Container | undefined): string[] => (c?.volumeMounts ?? []).map((m) => m.name);

  it('runs none until replicas says so, then one machine per pod', () => {
    expect(find(render(), 'StatefulSet', 'hopper-lanes').spec?.replicas).toBe(0);
    expect(lanes.spec?.replicas).toBe(3);
    expect(lanes.spec?.podManagementPolicy).toBe('Parallel');
  });

  it('runs the sandbox box image of the hopper\'s update channel', () => {
    expect(lane.image).toBe('ghcr.io/henningfutrell/hopper:box-claude');
    expect(join?.image).toBe(lane.image);
    expect(container(find(render('image.tag=stable'), 'StatefulSet', 'hopper-lanes'), 'lane').image).toBe('ghcr.io/henningfutrell/hopper:box-claude');
    expect(container(find(render('image.tag=dev'), 'StatefulSet', 'hopper-lanes'), 'lane').image).toBe('ghcr.io/henningfutrell/hopper:box-claude-dev');
  });

  it('makes the lane pool key at the first install and keeps it, and gives it to the hopper as a file', () => {
    const secret = find(rs, 'Secret', 'hopper-lane-pool');
    expect(secret.metadata.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(Object.keys(secret.stringData ?? {})).toEqual(['key']);
    expect(secret.stringData?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(env(daemon, 'HOPPER_LANE_POOL_KEY_FILE')?.value).toBe('/run/lane-pool/key');
    const name = daemon.volumeMounts?.find((m) => m.mountPath === '/run/lane-pool')?.name;
    expect(find(rs, 'Deployment', 'hopper').spec?.template?.spec.volumes?.find((v) => v.name === name)?.secret?.secretName).toBe('hopper-lane-pool');
  });

  it('joins each pod under its pod\'s name by dialling out to the hopper\'s Service, and tries again until it is let in', () => {
    expect(env(join as Container, 'POD_NAME')?.valueFrom?.fieldRef?.fieldPath).toBe('metadata.name');
    expect(env(join as Container, 'HOPPER_URL')?.value).toBe('http://hopper:4790');
    const script = join?.command?.join(' ') ?? '';
    expect(script).toContain('join "$HOPPER_URL#$(cat /run/lane-pool/key)" "$POD_NAME"');
    expect(script).toMatch(/until .*; do sleep \d+; done/);
  });

  it('lets only the join step see the lane pool key: never the container the jobs run in', () => {
    const key = pod(lanes).volumes?.find((v) => v.secret?.secretName === 'hopper-lane-pool');
    expect(key).toBeDefined();
    expect(mounts(join)).toContain(key?.name);
    expect(mounts(lane)).not.toContain(key?.name);
    for (const e of lane.env ?? []) expect(e.name).not.toMatch(/LANE_POOL/);
  });

  it('keeps each pod\'s home on a volume of its own, so a restart joins as the same machine', () => {
    expect(lanes.spec?.volumeClaimTemplates?.map((t) => t.metadata.name)).toEqual(['home']);
    expect(lanes.spec?.volumeClaimTemplates?.[0]?.spec.resources.requests.storage).toBe('20Gi');
    expect(lane.volumeMounts?.find((m) => m.name === 'home')?.mountPath).toBe('/home/agent');
    expect(join?.volumeMounts?.find((m) => m.name === 'home')).toBeDefined();
    // A pod scaled away was retired: its volume goes, and a new pod with its name starts as a new machine.
    expect(lanes.spec?.persistentVolumeClaimRetentionPolicy).toEqual({ whenScaled: 'Delete', whenDeleted: 'Retain' });
  });

  it('drains on stop: no new job, and the jobs on it end within the grace period', () => {
    expect(env(lane, 'HOPPER_CLIENT_DRAIN')?.value).toBe('1');
    expect(pod(lanes).terminationGracePeriodSeconds).toBe(3600);
    expect(pod(find(render('lanes.drainSeconds=600'), 'StatefulSet', 'hopper-lanes')).terminationGracePeriodSeconds).toBe(600);
  });

  it('needs no inbound port, no sshd and no Service: nothing reaches a lane pod', () => {
    for (const c of [lane, join as Container]) expect(c.ports ?? []).toEqual([]);
    expect(lane.command).toBeUndefined();
    expect(lane.securityContext?.readOnlyRootFilesystem).toBe(true);
    const selects = (r: Resource): string | undefined => (r.spec?.selector as Record<string, string> | undefined)?.['app.kubernetes.io/component'];
    expect(rs.filter((r) => r.kind === 'Service').map(selects)).not.toContain('lanes');
    const policy = find(rs, 'NetworkPolicy', 'hopper-lanes');
    expect(policy.spec?.podSelector?.matchLabels?.['app.kubernetes.io/component']).toBe('lanes');
    expect(policy.spec?.policyTypes).toEqual(['Ingress']);
    expect(policy.spec?.ingress ?? []).toEqual([]);
  });
});
