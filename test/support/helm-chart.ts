// What `helm template` renders of the Helm chart (deploy/helm/hopper), for test/scripts/helm-chart*.test.ts: `helm` on
// PATH, else Helm's image through the docker CLI, the chart mounted read-only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const CHART = join(ROOT, 'deploy', 'helm', 'hopper');
const HELM_IMAGE = 'docker.io/alpine/helm:3.19.0';

export interface EnvVar {
  name: string; value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean }; fieldRef?: { fieldPath: string }; resourceFieldRef?: { containerName?: string; resource: string; divisor?: string } };
}
export interface Container {
  name: string; image: string; args?: string[]; command?: string[]; env?: EnvVar[];
  ports?: { containerPort: number }[];
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
  securityContext?: {
    runAsNonRoot?: boolean; allowPrivilegeEscalation?: boolean; privileged?: boolean; readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[] };
  };
}
export interface PodSpec {
  containers: Container[]; initContainers?: Container[]; serviceAccountName?: string;
  securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; fsGroup?: number };
  volumes?: {
    name: string; hostPath?: unknown; secret?: { secretName: string; optional?: boolean; items?: { key: string; path: string }[] };
    persistentVolumeClaim?: { claimName: string };
  }[];
  automountServiceAccountToken?: boolean;
  terminationGracePeriodSeconds?: number;
  enableServiceLinks?: boolean;
}
export interface Resource {
  apiVersion: string; kind: string;
  metadata: { name: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  spec?: {
    replicas?: number; strategy?: { type: string }; podManagementPolicy?: string;
    persistentVolumeClaimRetentionPolicy?: { whenScaled?: string; whenDeleted?: string };
    volumeClaimTemplates?: {
      apiVersion?: string; kind?: string; metadata: { name: string };
      spec: { volumeMode?: string; resources: { requests: { storage: string } } };
    }[];
    selector?: Record<string, string> | { matchLabels?: Record<string, string> };
    policyTypes?: string[];
    template?: { spec: PodSpec; metadata?: { labels?: Record<string, string> } };
    ports?: { port: number; targetPort?: number | string; nodePort?: number }[];
    loadBalancerIP?: string;
    rules?: { host: string }[];
    podSelector?: { matchLabels?: Record<string, string> };
    ingress?: { from?: { podSelector?: { matchLabels?: Record<string, string> } }[] }[];
    egress?: unknown[];
  };
  stringData?: Record<string, string>;
  data?: Record<string, string>;
}
export interface ExternalSecret {
  kind: string; metadata: { name: string };
  spec: {
    refreshInterval?: string; secretStoreRef: { name: string; kind: string };
    target: { name: string; creationPolicy?: string; deletionPolicy?: string };
    data: { secretKey: string; remoteRef: { key: string; property?: string } }[];
  };
}

export function helm(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const opts = { encoding: 'utf8' as const, env: { ...process.env } };
  const local = spawnSync('helm', args.map((a) => a.replace('/chart', CHART)), opts);
  if (!local.error) return local;
  // The docker CLI, as every container test here: DOCKER_HOST names a podman socket when that is the runtime. Podman's
  // Docker API gives a container a pids limit too small for Go's threads unless one is named.
  return spawnSync('docker', ['run', '--rm', '--pids-limit=512', '-v', `${CHART}:/chart:ro`, HELM_IMAGE, ...args], { ...opts, timeout: 300_000 });
}

/** `helm template` of the chart with `set` (`key=value`), every document parsed. */
export function render(...set: string[]): Resource[] {
  const out = helm(['template', 'hopper', '/chart', '--namespace', 'hopper', ...set.flatMap((s) => ['--set', s])]);
  expect(out.status, out.stderr).toBe(0);
  return parseAllDocuments(out.stdout).map((d) => d.toJS() as Resource | null).filter((r): r is Resource => r !== null);
}

export const find = (rs: Resource[], kind: string, name: string): Resource => {
  const r = rs.find((x) => x.kind === kind && x.metadata.name === name);
  if (!r) throw new Error(`no ${kind} ${name}: ${rs.map((x) => `${x.kind}/${x.metadata.name}`).join(', ')}`);
  return r;
};
export const pod = (r: Resource): PodSpec => {
  const s = r.spec?.template?.spec;
  if (!s) throw new Error(`${r.kind} ${r.metadata.name} has no pod`);
  return s;
};
export const container = (r: Resource, name: string): Container => {
  const c = pod(r).containers.find((x) => x.name === name);
  if (!c) throw new Error(`${r.metadata.name} has no container ${name}`);
  return c;
};
export const env = (c: Container, name: string): EnvVar | undefined => c.env?.find((e) => e.name === name);
export const workloads = (rs: Resource[]): Resource[] => rs.filter((r) => ['Deployment', 'StatefulSet', 'Job', 'DaemonSet'].includes(r.kind));
export const composeImage = (service: string): string => {
  const c = parse(readFileSync(join(ROOT, 'compose.yaml'), 'utf8')) as { services: Record<string, { image: string }> };
  const s = c.services[service];
  if (!s) throw new Error(`compose.yaml has no ${service}`);
  return s.image;
};
