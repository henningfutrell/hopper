// What a discovery printed, read into its facts (issue #542). Pure: the script is src/client/discover.ts, which a
// client target runs too.
import { DISCOVER_DONE } from '../client/discover.ts';
import type { AwsIdentity, DiscoveryFacts, KubeContext } from '../domain/types.ts';

const TAB = '\t';

const fields = (line: string, prefix: string): string[] => line.slice(prefix.length).split(TAB);

/** What a finished discovery found; undefined when it did not finish. Pure. */
export function readDiscovery(stdout: string): DiscoveryFacts | undefined {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  if (!lines.includes(DISCOVER_DONE)) return undefined;
  const path: string[] = [];
  const bins: { dir: string; name: string }[] = [];
  const versions: Record<string, string> = {};
  const aws = new Map<string, AwsIdentity>();
  const kube = new Map<string, KubeContext>();
  const env: string[] = [];
  const files: string[] = [];
  const identity = (profile: string): AwsIdentity => {
    let a = aws.get(profile);
    if (!a) aws.set(profile, (a = { profile }));
    return a;
  };
  for (const l of lines) {
    if (l.startsWith('hopper-path ')) path.push(l.slice('hopper-path '.length));
    else if (l.startsWith('hopper-bin ')) {
      const f = l.slice('hopper-bin '.length);
      const i = f.lastIndexOf('/');
      if (i > 0) bins.push({ dir: f.slice(0, i), name: f.slice(i + 1) });
    } else if (l.startsWith('hopper-version ')) {
      const [tool, v] = fields(l, 'hopper-version ');
      if (tool && v) versions[tool] = v;
    } else if (l.startsWith('hopper-aws-error ')) {
      const [p, e] = fields(l, 'hopper-aws-error ');
      identity(p!).error = e || 'no identity';
    } else if (l.startsWith('hopper-aws-identity ')) {
      const [p, account, arn, region] = fields(l, 'hopper-aws-identity ');
      Object.assign(identity(p!), { ...(account ? { account } : {}), ...(arn ? { arn } : {}), ...(region ? { region } : {}) });
    } else if (l.startsWith('hopper-aws-sim ')) {
      const [p, action, decision] = fields(l, 'hopper-aws-sim ');
      const a = identity(p!);
      (a.simulated ??= []).push({ action: action!, decision: decision ?? '' });
    } else if (l.startsWith('hopper-aws-sim-error ')) {
      const [p, e] = fields(l, 'hopper-aws-sim-error ');
      identity(p!).simulationError = e || 'simulation failed';
    } else if (l.startsWith('hopper-kube-context ')) {
      const [name, cluster, namespace, current] = fields(l, 'hopper-kube-context ');
      kube.set(name!, { name: name!, ...(cluster ? { cluster } : {}), ...(namespace ? { namespace } : {}), current: current === 'current', can: [] });
    } else if (l.startsWith('hopper-kube-can ')) {
      const [name, check, answer] = fields(l, 'hopper-kube-can ');
      kube.get(name!)?.can.push({ check: check!, answer: answer || 'no answer' });
    } else if (l.startsWith('hopper-cred-env ')) env.push(l.slice('hopper-cred-env '.length));
    else if (l.startsWith('hopper-cred-file ')) files.push(l.slice('hopper-cred-file '.length));
  }
  return { path, bins, versions, aws: [...aws.values()], kube: [...kube.values()], credentials: { env, files } };
}
