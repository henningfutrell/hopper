// Attached machines follow plugins.yaml without a restart (issue #18): every list() reads the
// configured set. A new machine appears (offline until its first probe), a removed one disappears,
// and a change of lanes, executors or label applies at once without losing what the probe knows.
import { describe, expect, it } from 'vitest';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { createAttachedMachines } from '../../src/machines/index.ts';

const flush = () => new Promise((r) => setImmediate(r));
const laptop: AttachedMachine = { name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], session: 'hopper', herdrBin: '/h/herdr' };
const desk: AttachedMachine = { name: 'desk', ssh: 'desk', lanes: 1, executors: ['herdr-claude'], session: 'hopper', herdrBin: '/h/herdr' };

function harness(initial: AttachedMachine[]) {
  let configured = initial;
  const probed: string[] = [];
  const lines: string[] = [];
  const src = createAttachedMachines({
    machines: () => configured,
    probe: async (m) => { probed.push(m.name); return { online: true }; },
    logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
  });
  return { src, probed, lines, set: (next: AttachedMachine[]) => { configured = next; } };
}

describe('createAttachedMachines', () => {
  it('lists the configured machines in order; one added later appears, offline until its probe answers', async () => {
    const h = harness([laptop]);
    await h.src.list(); await flush();
    expect((await h.src.list()).map((m) => [m.id, m.online])).toEqual([['laptop', true]]);
    h.set([laptop, desk]);
    expect((await h.src.list()).map((m) => [m.id, m.online])).toEqual([['laptop', true], ['desk', false]]);
    await flush();
    expect((await h.src.list()).map((m) => [m.id, m.online])).toEqual([['laptop', true], ['desk', true]]);
  });

  it('a removed machine disappears, and its removal is logged', async () => {
    const h = harness([laptop, desk]);
    await h.src.list();
    h.set([desk]);
    expect((await h.src.list()).map((m) => m.id)).toEqual(['desk']);
    expect(h.lines).toContain('hopper: attached machine laptop removed');
  });

  it('lanes, executors and label apply at once; the machine stays online (no new probe)', async () => {
    const h = harness([laptop]);
    await h.src.list(); await flush();
    h.set([{ ...laptop, lanes: 5, executors: ['test'], label: 'arch' }]);
    expect((await h.src.list())[0]).toMatchObject({ id: 'laptop', maxLanes: 5, executors: ['test'], label: 'arch', online: true });
    expect(h.probed).toEqual(['laptop']);
  });

  it('a changed ssh target is another machine: probed again', async () => {
    const h = harness([laptop]);
    await h.src.list(); await flush();
    h.set([{ ...laptop, ssh: 'laptop-wifi' }]);
    expect((await h.src.list())[0]).toMatchObject({ ssh: 'laptop-wifi', online: false });
    await flush();
    expect(h.probed).toEqual(['laptop', 'laptop']);
  });
});
