// jev-router: grok-bot-jev's usage router, run through jev_shim.py (design.md "Jev"). Reads the
// Jev checkout; never writes into it. Jev's gates go to TypeSafe (Jev's own service) once
// a key is set (TYPESAFE_API_KEY, or `typesafeKeyFile` read on every call), for the gates in
// `typesafeGates`; Haiku answers the rest.
import { join } from 'node:path';
import { detectClaude } from '../../claude-print.ts';
import { expandHome } from '../../expand-home.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { createJevShimRouter } from './shim.ts';

export interface JevRouterOptions {
  jevSrc: string;
  python: string;
  claudeBin: string;
  model: string;
  typesafeGates: string[];
  typesafeKeyFile: string;
  timeoutMs: number;
}

const jevRouter: PluginDefinition<'router', JevRouterOptions> = {
  id: 'jev-router',
  role: 'router',
  describe: "grok-bot-jev's usage router (Python, via a shim): admission and priority per job; gates by TypeSafe or Haiku",
  options: (z) => z.object({
    jevSrc: z.string().min(1).default('~/workbench/jev-src/grok-bot-jev').meta({ commandBearing: true }),
    python: z.string().min(1).default('python3').meta({ commandBearing: true }),
    claudeBin: z.string().min(1).default('claude').meta({ commandBearing: true }),
    model: z.string().min(1).default('haiku'),
    typesafeGates: z.array(z.string().min(1)).default(['intent', 'reuse_cache', 'stop_retry']),
    // Its contents go to TypeSafe as the key, so only plugins.yaml may point it elsewhere.
    typesafeKeyFile: z.string().min(1).default('~/.config/job-hopper/typesafe-api-key').meta({ commandBearing: true }),
    timeoutMs: z.number().int().positive().default(60_000),
  }),
  async detect(sys, o) {
    if (!(await sys.which(o.python))) return { status: 'unavailable', reason: `python not found: ${o.python}` };
    const router = join(expandHome(o.jevSrc), 'src', 'router.py');
    if (!(await sys.exists(router))) return { status: 'unavailable', reason: `no Jev checkout: ${router} not found` };
    const claude = await detectClaude(sys, o.claudeBin);
    if (claude.status === 'unavailable') return claude;
    let typesafe = `TypeSafe on (${o.typesafeGates.join(', ')})`;
    const keyFile = expandHome(o.typesafeKeyFile);
    if (!sys.env('TYPESAFE_API_KEY') && !(await sys.readable(keyFile))) typesafe = `TypeSafe off until a key is set: TYPESAFE_API_KEY or ${keyFile}`;
    else if (!(await sys.pythonImports(o.python, 'typesafe_sdk'))) typesafe = `TypeSafe off: ${o.python} cannot import typesafe_sdk`;
    return { status: 'available', detail: `${typesafe}; Haiku (${o.model}) via ${claude.detail}` };
  },
  create(ctx, o) {
    return createJevShimRouter({
      jevSrc: expandHome(o.jevSrc), python: o.python, claudeBin: o.claudeBin, model: o.model,
      typesafeGates: o.typesafeGates, typesafeKeyFile: expandHome(o.typesafeKeyFile), timeoutMs: o.timeoutMs,
      dataDir: ctx.dataDir, mode: ctx.routerMode, clock: ctx.clock,
    });
  },
};

export default jevRouter;
