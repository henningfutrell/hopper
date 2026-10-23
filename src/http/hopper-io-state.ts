// The hopper.io state snapshot as this instance makes it now (issue #466 part 2, design.md "The hopper.io state
// snapshot"): every running user's machines, lanes, queue and open questions, with the installed version and channel,
// through the pure projection, then checked against the schema. It reads only: nothing is sent, changed or recorded.
// GET /api/cloud-link/state shows it to the instance admin; the cloud link's connection (issue #464) sends it.
import { HOPPER_IO_STATE_SCHEMA, projectHopperIoState, type HopperIoState, type HopperIoStateInputs } from '../domain/hopper-io-state.ts';
import type { Clock } from '../domain/ports.ts';
import type { UpdateStatus } from '../domain/update.ts';
import type { TenantParts, Tenants } from './tenants.ts';

type Tenant = {
  engine: Pick<TenantParts['engine'], 'getMachines' | 'getQueue'>;
  store: { questions: Pick<TenantParts['store']['questions'], 'list'> };
  plugins: Pick<TenantParts['plugins'], 'report'>;
};

export interface HopperIoStateSource {
  /**
   * The snapshot now. `machineKey(userId, machineId)`: the opaque key a machine goes out as, never its id; undefined:
   * `machine-<n>`, its place in the list (the preview's key, since the cloud link's own key is #464's).
   */
  snapshot(machineKey?: (userId: string, machineId: string) => string): Promise<HopperIoState>;
}

export function createHopperIoStateSource(o: {
  tenants: { list: Tenants['list']; user(id: string): Tenant | undefined };
  updater: { status(): Pick<UpdateStatus, 'installed' | 'channel'> };
  clock: Clock;
}): HopperIoStateSource {
  return {
    async snapshot(machineKey) {
      const machines: HopperIoStateInputs['machines'][number][] = [];
      const lanes: HopperIoStateInputs['lanes'][number][] = [];
      const queue = { waiting: [] as unknown[], running: [] as unknown[], locked: [] as unknown[] };
      const questions: HopperIoStateInputs['questions'][number][] = [];
      const keys = new Map<string, string>();
      let review = false;
      for (const user of o.tenants.list()) {
        const t = o.tenants.user(user.id);
        if (!t) continue;
        // Executor names are a user's own too: each machine goes in with its executors' plugin ids ('' for none).
        const pluginOf = new Map(t.plugins.report().executors.instances.map((e) => [e.instance.name, e.instance.plugin]));
        // Machine ids are a user's own: two users' `local` are two machines, so each gets a place of its own here.
        for (const m of await t.engine.getMachines()) {
          const place = String(keys.size);
          keys.set(place, machineKey ? machineKey(user.id, m.id) : `machine-${keys.size + 1}`);
          machines.push({ ...m, id: place, executors: m.executors.map((e) => pluginOf.get(e) ?? '') });
          for (const l of m.lanes) lanes.push({ machineId: place, state: l.state });
        }
        const q = t.engine.getQueue();
        queue.waiting.push(...q.waiting);
        queue.running.push(...q.running);
        queue.locked.push(...q.locked);
        // One gate for the instance: `review` while any user reviews new jobs, since then jobs can wait on a person.
        if (q.gate.mode === 'review') review = true;
        questions.push(...t.store.questions.list({ status: ['open'] }));
      }
      const { installed, channel } = o.updater.status();
      return HOPPER_IO_STATE_SCHEMA.parse(projectHopperIoState({
        sentAt: o.clock.now().toISOString(),
        installed,
        channel,
        machines,
        lanes,
        queue: { ...queue, gate: { mode: review ? 'review' : 'auto-accept', autoAcceptPerHour: null } },
        questions,
        machineKey: (place) => keys.get(place)!,
        executorPlugin: (plugin) => plugin || undefined,
      }));
    },
  };
}
