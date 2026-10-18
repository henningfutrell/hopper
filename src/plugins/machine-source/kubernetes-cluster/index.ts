// kubernetes-cluster: the cluster as a machine (issue #1283, design.md "Job pods on Kubernetes"). Its lanes are how many job pods
// run at once; its executors start each job in a pod of its own (the `kubernetes` executor). Nothing runs on it: online
// while the Kubernetes API answers a pod list in its namespace, read in the background at most every 30 s, so a list
// never waits on the API.
import { createKubernetesPods, inClusterOptions } from '../../../kubernetes/api.ts';
import type { KubernetesPods } from '../../../domain/pods.ts';
import type { MachineSnapshot } from '../../../domain/types.ts';
import { elbowInsOption, reservedLanesOption, usageLimitsOf, usageLimitsOption } from '../attached.ts';
import type { UsageLimitPair } from '../../../domain/usage.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface KubernetesMachineOptions { label?: string; namespace?: string; lanes: number; reservedLanes?: number; elbowIns?: number; usageLimits?: UsageLimitPair; executors: string[] }

const PROBE_MS = 30000;

export function kubernetesMachinePlugin(seam?: (namespace?: string) => KubernetesPods): PluginDefinition<'machine-source', KubernetesMachineOptions> {
  return {
    id: 'kubernetes-cluster',
    role: 'machine-source',
    describe: 'A Kubernetes cluster: each job on it runs in a pod of its own, started through the Kubernetes API',
    options: (z) => z.strictObject({
      label: z.string().min(1).optional().meta({ description: 'shown instead of the name' }),
      namespace: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).optional()
        .meta({ commandBearing: true, description: 'the namespace whose pods it checks. Absent: the hopper\'s own namespace' }),
      lanes: z.number().int().min(0, 'lanes must not be negative').default(4).meta({ description: 'job pods it runs at once; 0 rests it' }),
      reservedLanes: reservedLanesOption(z),
      elbowIns: elbowInsOption(z),
      usageLimits: usageLimitsOption(z),
      executors: z.array(z.string().min(1)).default(['kubernetes']).meta({ description: 'executor instances that run there: those that start a pod per job' }),
    }),
    async detect(sys, o) {
      if (seam) return { status: 'available', detail: 'Kubernetes API seam (tests)' };
      try { return { status: 'available', detail: `pods in namespace ${createKubernetesPods(inClusterOptions(sys.env, undefined, o.namespace)).namespace}` }; } catch (e) {
        return { status: 'unavailable', reason: (e as Error).message };
      }
    },
    create(ctx, o) {
      const pods = seam?.(o.namespace) ?? createKubernetesPods(inClusterOptions(ctx.env, undefined, o.namespace));
      let online = false;
      let probedAt = -Infinity;
      let probing = false;
      let said: string | undefined;
      const probe = (): void => {
        const now = ctx.clock.now().getTime();
        if (probing || now - probedAt < PROBE_MS) return;
        probing = true;
        probedAt = now;
        void pods.problem().then((problem) => {
          online = problem === undefined;
          const line = problem ? `offline: ${problem}` : `online (pods in namespace ${pods.namespace})`;
          if (line !== said) ctx.logger.info(`hopper: kubernetes machine ${ctx.instanceName} ${(said = line)}`);
        }, () => { online = false; }).finally(() => { probing = false; });
      };
      return {
        async list(): Promise<MachineSnapshot[]> {
          probe();
          return [{
            id: ctx.instanceName, label: o.label ?? ctx.instanceName, maxLanes: o.lanes, online, executors: [...o.executors],
            ...(o.reservedLanes !== undefined ? { reservedLanes: o.reservedLanes } : {}), ...(o.elbowIns !== undefined ? { elbowIns: o.elbowIns } : {}), ...usageLimitsOf(o),
          }];
        },
      };
    },
  };
}

export default kubernetesMachinePlugin();
