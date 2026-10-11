// A machine's link drops while the herdr-claude executor watches a turn (issue #752): the watch ends at once with a
// failure marked `linkLost`, so the engine holds the job instead of failing it. A herdr error while the link is up is
// not a lost link: it counts toward the three in a row that fail the job, as before.
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createHerdrCliClient } from '../../src/executors/herdr/cli-client.ts';
import { contextFor, jobWith, setup } from './support.ts';

const LONG = { steps: Array.from({ length: 10 }, (_, i) => `● Painting plank ${i + 1}`), output: ['● Painted the shed.', '  HOPPER_DONE'] };

describe('herdr-claude executor: the machine\'s link drops mid-turn (issue #752)', () => {
  it('the link goes down: the watch ends at once, failed and marked linkLost', async () => {
    const { herdr, executor } = setup({ turns: [LONG] });
    const { ctx } = contextFor(jobWith({ prompt: 'go' }));
    const plain = ctx.progress;
    ctx.progress = (f, m) => { plain(f, m); if (m?.includes('plank 3')) herdr.setUnreachable(true); };
    expect(await executor.run(ctx)).toMatchObject({ kind: 'failed', error: 'herdr: client is not dialled in', linkLost: true });
    expect(herdr.closed).toEqual([]);
  });

  it('a herdr error while the link is up is no lost link: the turn goes on and finishes', async () => {
    const { herdr, executor } = setup({ turns: [LONG] });
    const { ctx } = contextFor(jobWith({ prompt: 'go' }));
    const plain = ctx.progress;
    ctx.progress = (f, m) => { plain(f, m); if (m?.includes('plank 3')) herdr.failNext('read', 'boom'); };
    const outcome = await executor.run(ctx);
    expect(outcome).toMatchObject({ kind: 'finished' });
    expect(outcome).not.toHaveProperty('linkLost');
  });
});

describe('herdr CLI client of a client target: linkDown (issue #752)', () => {
  const on = (link: () => PassThrough | undefined) => createHerdrCliClient({ client: { machine: 'lab', link, token: () => 'token' } });

  it('down while the machine is not dialled in, up while its link is open, down once that link is closed', () => {
    expect(on(() => undefined).linkDown?.()).toBe(true);
    const socket = new PassThrough();
    const client = on(() => socket);
    expect(client.linkDown?.()).toBe(false);
    socket.destroy();
    expect(client.linkDown?.()).toBe(true);
  });

  it('a local herdr has no link', () => {
    expect(createHerdrCliClient({ bin: 'herdr', session: 'jh-test' }).linkDown).toBeUndefined();
  });
});
