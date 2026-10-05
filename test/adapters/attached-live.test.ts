// The target pool (issue #74): how the hopper reaches each attached machine, one machine-source
// instance each. A machine whose instance is rebuilt with other lanes, executors or label keeps its
// source and what its probe knows; another ssh target is another machine, offline until probed.
import { describe, expect, it } from 'vitest';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { createTargetPool } from '../../src/machines/index.ts';

const flush = () => new Promise((r) => setImmediate(r));
const laptop: AttachedMachine = { name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], herdr: true, session: 'hopper', herdrBin: '/h/herdr' };
const desk: AttachedMachine = { name: 'desk', ssh: 'desk', lanes: 1, executors: ['herdr-claude'], herdr: true, session: 'hopper', herdrBin: '/h/herdr' };

function harness() {
  const probed: string[] = [];
  const target = createTargetPool({ probe: async (m) => { probed.push(m.name); return { online: true }; } });
  return { target, probed };
}

describe('createTargetPool', () => {
  it('a machine is offline until its probe answers, then online', async () => {
    const h = harness();
    const src = h.target(desk);
    expect((await src.list()).map((m) => [m.id, m.online])).toEqual([['desk', false]]);
    await flush();
    expect((await src.list()).map((m) => [m.id, m.online])).toEqual([['desk', true]]);
  });

  it('lanes, executors and label apply at once; the machine stays online (no new probe)', async () => {
    const h = harness();
    await h.target(laptop).list(); await flush();
    const again = h.target({ ...laptop, lanes: 5, executors: ['test'], label: 'arch' });
    expect((await again.list())[0]).toMatchObject({ id: 'laptop', maxLanes: 5, executors: ['test'], label: 'arch', online: true });
    expect(h.probed).toEqual(['laptop']);
  });

  it('a changed ssh target is another machine: probed again', async () => {
    const h = harness();
    await h.target(laptop).list(); await flush();
    const moved = h.target({ ...laptop, ssh: 'laptop-wifi' });
    expect((await moved.list())[0]).toMatchObject({ ssh: 'laptop-wifi', online: false });
    await flush();
    expect(h.probed).toEqual(['laptop', 'laptop']);
  });
});
