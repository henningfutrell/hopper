// local: this laptop as the one machine (glossary "Machine"), named after the instance (`local`:
// lanes are stored under it). `lanes` is the lane count — a lane has no options of its own.
// `executors`, when given, narrows what runs here (issue #58: a `command` job goes to its target only).
// `session`, when given, is the herdr session its jobs run in, which the hopper starts when it is not
// running (issue #260); absent, the herdr-claude instance's own. `workTree`: its jobs' default work tree (issue #324).
// `reservedLanes`: lanes kept for jobs pinned to it (issue #372).
// `diskLowBelowGiB` / `diskLowBelowPercent`: when its disk is low and it takes no new job (issue #410).
// `reapEveryMinutes` / `scratchMaxAgeHours`: how the sweep treats it (issue #410).
import { createLocalMachineSource } from '../../../machines/index.ts';
import { ensureHerdrSession, sessionProblem } from '../../../executors/herdr/index.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { diskLowOf, diskLowShape, reservedLanesOption, sweepOf, sweepShape, workTreeOption } from '../attached.ts';

export interface LocalOptions {
  lanes: number; reservedLanes?: number; executors?: string[]; session?: string; workTree?: string; diskLowBelowGiB?: number; diskLowBelowPercent?: number;
  reapEveryMinutes?: number; scratchMaxAgeHours?: number;
}

/** Starts this machine's herdr session when it is not running; rejects with the reason. */
export type StartSession = (session: string, userEnv: Readonly<Record<string, string>>) => Promise<unknown>;

export const startHerdrSession: StartSession = (session, userEnv) => ensureHerdrSession({ bin: 'herdr', session, userEnv });

/** The plugin. `start` (tests, `UserSeams.herdrSession`) replaces starting the herdr session. */
export function localPlugin(start: StartSession = startHerdrSession): PluginDefinition<'machine-source', LocalOptions> {
  return {
    id: 'local',
    role: 'machine-source',
    describe: 'This machine, running every registered executor (or the `executors` named) on up to `lanes` lanes at once',
    options: (z) => z.object({
      lanes: z.number().int().min(0).default(4).meta({ description: 'concurrent jobs on this machine' }),
      reservedLanes: reservedLanesOption(z),
      executors: z.array(z.string().min(1)).optional().meta({ description: 'executor instances that run on this machine; absent: every registered one' }),
      session: z.string().min(1).superRefine((s, c) => { const p = sessionProblem(s); if (p) c.addIssue({ code: 'custom', message: p }); }).optional()
        .meta({ description: 'the herdr session jobs here run in, started by the hopper; absent: the herdr-claude instance\'s own' }),
      workTree: workTreeOption(z),
      ...diskLowShape(z),
      ...sweepShape(z),
    }),
    async detect() { return { status: 'available' }; },
    create: (ctx, o) => createLocalMachineSource({
      id: ctx.instanceName, maxLanes: o.lanes, ...(o.reservedLanes !== undefined ? { reservedLanes: o.reservedLanes } : {}), ...(o.workTree !== undefined ? { workTree: o.workTree } : {}),
      diskLow: () => diskLowOf(o), sweep: () => sweepOf(o),
      executors: o.executors ? () => ctx.executors().filter((x) => o.executors!.includes(x)) : ctx.executors,
      ...(o.session ? {
        session: o.session,
        ensureSession: () => start(o.session!, ctx.userEnv),
        logger: ctx.logger,
      } : {}),
    }),
  };
}

export default localPlugin();
