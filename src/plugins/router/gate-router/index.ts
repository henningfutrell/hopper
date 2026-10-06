// gate-router: a router that asks Jev's gates about each job and routes on the answers, run through
// gate_shim.py (design.md "Gate router"). Reads the grok-bot-jev checkout at `jevPath`; never writes
// into it. Jev, through TypeSafe, answers the gates in JEV_GATES once TYPESAFE_API_KEY is in the
// daemon's environment; the Claude model (`model`, Haiku) answers the rest, through the `claude` on PATH.
import { join } from 'node:path';
import { claudeModelChoices, detectClaude } from '../../claude-print.ts';
import { expandHome } from '../../expand-home.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { createGateRouter, JEV_GATES } from './shim.ts';

export interface GateRouterOptions {
  jevPath: string;
  python: string;
  model: string;
  timeoutSeconds: number;
}

const gateRouter: PluginDefinition<'router', GateRouterOptions> = {
  id: 'gate-router',
  role: 'router',
  describe: 'admission and priority per job from Jev (grok-bot-jev, Python); Jev or a Claude model answers each of its gates',
  options: (z) => z.object({
    jevPath: z.string().min(1).meta({ commandBearing: true, description: 'the folder where grok-bot-jev (Jev) is checked out; no default' }),
    python: z.string().min(1).default('python3').meta({ commandBearing: true, description: 'the Python that runs Jev' }),
    model: z.string().min(1).default('haiku').meta({ description: 'the Claude model that judges a job where Jev does not' }),
    timeoutSeconds: z.number().positive().default(60).meta({ description: 'how long the router may take over one job; after it, the job goes ahead without advice' }),
  }),
  async detect(sys, o) {
    if (!(await sys.which(o.python))) return { status: 'unavailable', reason: `python not found: ${o.python}` };
    const router = join(expandHome(o.jevPath), 'src', 'router.py');
    if (!(await sys.exists(router))) return { status: 'unavailable', reason: `no grok-bot-jev checkout: ${router} not found` };
    const claude = await detectClaude(sys, 'claude');
    if (claude.status === 'unavailable') return claude;
    let jev = `Jev through TypeSafe for ${JEV_GATES.join(', ')}`;
    if (!sys.env('TYPESAFE_API_KEY')) jev = 'Jev off until TYPESAFE_API_KEY is set';
    else if (!(await sys.pythonImports(o.python, 'typesafe_sdk'))) jev = `Jev off: ${o.python} cannot import typesafe_sdk`;
    return { status: 'available', detail: `${jev}; Claude ${o.model} answers the other gates via ${claude.detail}` };
  },
  choices: (sys) => claudeModelChoices(sys, 'model'),
  create(ctx, o) {
    return createGateRouter({
      jevPath: expandHome(o.jevPath), python: o.python, model: o.model,
      typesafeKey: () => ctx.env('TYPESAFE_API_KEY'), timeoutMs: o.timeoutSeconds * 1000,
      dataDir: ctx.dataDir, clock: ctx.clock, userEnv: ctx.userEnv,
    });
  },
};

export default gateRouter;
