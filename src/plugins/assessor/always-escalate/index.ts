// always-escalate: every question goes to the owner. The assessor the host falls back to when the
// configured one cannot run (fail safe), and a plain choice for whoever wants no model judging.
import type { PluginDefinition } from '../../sdk.ts';

const alwaysEscalate: PluginDefinition<'assessor', Record<string, never>> = {
  id: 'always-escalate',
  role: 'assessor',
  describe: 'Escalates every question to the owner; no model call',
  async detect() {
    return { status: 'available' };
  },
  create() {
    return {
      name: 'always-escalate',
      async assess() {
        return { escalate: true, reason: 'always-escalate: every question goes to the owner' };
      },
    };
  },
};

export default alwaysEscalate;
