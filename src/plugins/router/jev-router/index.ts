// jev-router: grok-bot-jev's usage router, run through jev_shim.py (design.md "Jev"). Reads the
// Jev checkout; never writes into it.
import { join } from 'node:path';
import { expandHome } from '../../expand-home.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { createJevShimRouter } from './shim.ts';

export interface JevRouterOptions {
  jevSrc: string;
  python: string;
  timeoutMs: number;
}

const jevRouter: PluginDefinition<'router', JevRouterOptions> = {
  id: 'jev-router',
  role: 'router',
  describe: "grok-bot-jev's usage router (Python, via a shim): admission and priority per job",
  options: (z) => z.object({
    jevSrc: z.string().min(1).default('~/workbench/jev-src/grok-bot-jev').meta({ commandBearing: true }),
    python: z.string().min(1).default('python3').meta({ commandBearing: true }),
    timeoutMs: z.number().int().positive().default(10_000),
  }),
  async detect(sys, o) {
    if (!(await sys.which(o.python))) return { status: 'unavailable', reason: `python not found: ${o.python}` };
    const router = join(expandHome(o.jevSrc), 'src', 'router.py');
    if (!(await sys.exists(router))) return { status: 'unavailable', reason: `no Jev checkout: ${router} not found` };
    return { status: 'available' };
  },
  create(ctx, o) {
    return createJevShimRouter({
      jevSrc: expandHome(o.jevSrc), python: o.python, timeoutMs: o.timeoutMs,
      dataDir: ctx.dataDir, mode: ctx.routerMode, clock: ctx.clock,
    });
  },
};

export default jevRouter;
