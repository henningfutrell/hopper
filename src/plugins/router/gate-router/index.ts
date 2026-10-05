// gate-router: a router that asks grok-bot-jev's gates about each job and routes on the answers,
// run through gate_shim.py (design.md "Gate router"). Reads the grok-bot-jev checkout; never writes
// into it. Jev, through TypeSafe, answers the gates in `jevGates` once TYPESAFE_API_KEY is in the
// daemon's environment; the Claude model (`claudeModel`, Haiku) answers the rest.
import { join } from 'node:path';
import { detectClaude } from '../../claude-print.ts';
import { expandHome } from '../../expand-home.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { createGateRouter } from './shim.ts';

export interface GateRouterOptions {
  grokBotJevSrc: string;
  python: string;
  claudeBin: string;
  claudeModel: string;
  jevGates: string[];
  timeoutMs: number;
}

const gateRouter: PluginDefinition<'router', GateRouterOptions> = {
  id: 'gate-router',
  role: 'router',
  describe: "admission and priority per job from grok-bot-jev's gates (Python, via a shim); Jev or a Claude model answers each gate",
  options: (z) => z.object({
    grokBotJevSrc: z.string().min(1).meta({ commandBearing: true, description: 'a checkout of grok-bot-jev; no default' }),
    python: z.string().min(1).default('python3').meta({ commandBearing: true }),
    claudeBin: z.string().min(1).default('claude').meta({ commandBearing: true }),
    claudeModel: z.string().min(1).default('haiku').meta({ description: 'the Claude model that answers every gate Jev does not' }),
    jevGates: z.array(z.string().min(1)).default(['intent', 'reuse_cache', 'stop_retry']).meta({ description: 'the gates Jev answers, through TypeSafe' }),
    timeoutMs: z.number().int().positive().default(60_000),
  }),
  async detect(sys, o) {
    if (!(await sys.which(o.python))) return { status: 'unavailable', reason: `python not found: ${o.python}` };
    const router = join(expandHome(o.grokBotJevSrc), 'src', 'router.py');
    if (!(await sys.exists(router))) return { status: 'unavailable', reason: `no grok-bot-jev checkout: ${router} not found` };
    const claude = await detectClaude(sys, o.claudeBin);
    if (claude.status === 'unavailable') return claude;
    let jev = `Jev through TypeSafe for ${o.jevGates.join(', ')}`;
    if (!sys.env('TYPESAFE_API_KEY')) jev = 'Jev off until TYPESAFE_API_KEY is set';
    else if (!(await sys.pythonImports(o.python, 'typesafe_sdk'))) jev = `Jev off: ${o.python} cannot import typesafe_sdk`;
    return { status: 'available', detail: `${jev}; Claude ${o.claudeModel} answers the other gates via ${claude.detail}` };
  },
  create(ctx, o) {
    return createGateRouter({
      grokBotJevSrc: expandHome(o.grokBotJevSrc), python: o.python, claudeBin: o.claudeBin, claudeModel: o.claudeModel,
      jevGates: o.jevGates, typesafeKey: () => ctx.env('TYPESAFE_API_KEY'), timeoutMs: o.timeoutMs,
      dataDir: ctx.dataDir, mode: ctx.routerMode, clock: ctx.clock,
    });
  },
};

export default gateRouter;
