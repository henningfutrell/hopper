// A cluster install (issue #1285, design.md "Self-update"): the hopper's image run as a Kubernetes workload, a Helm release.
// Found by KUBERNETES_SERVICE_HOST, which Kubernetes gives every container of a pod. Its update is `helm upgrade` of the
// release to a new image tag, never a compose command; its stack drift compares the image it runs with the update channel,
// never a compose file. The update notice (ui/src/model/update.ts) keeps its own copy of the command: the UI imports nothing of src/.
import { readFileSync } from 'node:fs';
import { CANARY_BRANCH } from '../domain/landing-canary.ts';
import type { ClusterInstall, StackDrift, UpdateStatus } from '../domain/types.ts';

/** The chart a cluster install's release is upgraded with (the Helm chart of issue #1281). */
export const HELM_CHART = 'oci://ghcr.io/henningfutrell/charts/hopper';

/** The release, when the chart sets no HOPPER_HELM_RELEASE. */
export const DEFAULT_RELEASE = 'hopper';

/** Where Kubernetes puts the namespace of the pod's service account. */
const NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

/** A release or namespace name: a DNS label, nothing a shell or Helm reads otherwise. */
const NAME = /^[a-z0-9]([a-z0-9-]{0,51}[a-z0-9])?$/;

const readNamespaceFile = (): string | undefined => {
  try { return readFileSync(NAMESPACE_FILE, 'utf8').trim() || undefined; } catch { return undefined; }
};

/** The cluster install this hopper is, from its environment; undefined when it does not run in a Kubernetes pod. */
export function clusterInstall(env: Record<string, string | undefined>, readNamespace: () => string | undefined = readNamespaceFile): ClusterInstall | undefined {
  if (!env.KUBERNETES_SERVICE_HOST) return undefined;
  const release = env.HOPPER_HELM_RELEASE && NAME.test(env.HOPPER_HELM_RELEASE) ? env.HOPPER_HELM_RELEASE : DEFAULT_RELEASE;
  const namespace = readNamespace();
  return { release, ...(namespace && NAME.test(namespace) ? { namespace } : {}), chart: HELM_CHART };
}

/** The update of a cluster install: the release upgraded to `tag` of the published image, its other values kept. */
export const helmUpgradeCommand = (c: ClusterInstall, tag: string): string =>
  `helm upgrade ${c.release} ${c.chart}${c.namespace ? ` --namespace ${c.namespace}` : ''} --reuse-values --set image.tag=${tag}`;

/** The image tag an update to `commit` sets: the `sha-<commit>` tag that pins that one build, so the release rolls out. */
export const clusterUpdateTag = (commit: string): string => `sha-${commit.slice(0, 7)}`;

/** The image tag of the selected channel: the channel's, or `canary` for a stable install in the canary subset while it leads. */
export const clusterChannelTag = (s: Pick<UpdateStatus, 'channel' | 'target'>): string => (s.target?.ref === CANARY_BRANCH ? CANARY_BRANCH : s.channel);

/**
 * How a cluster install differs from its update channel: the branch the running image was built from (install.json)
 * against `channelTag`, the image tag of the selected channel (`canary` for a stable install in the canary subset).
 */
export function checkCluster(o: { branch: string | undefined; channelTag: string }): StackDrift {
  if (!o.branch) return { state: 'unchecked', reason: 'this build does not know its branch: install.json lacks it', gaps: [] };
  if (o.branch === o.channelTag) return { state: 'checked', gaps: [] };
  return {
    state: 'checked',
    gaps: [{
      kind: 'image', name: 'hopper', what: `the hopper runs the ${o.branch} image; the update channel is ${o.channelTag}`,
      off: `updates of the ${o.channelTag} channel: the update check compares with a build of another channel`,
    }],
  };
}
