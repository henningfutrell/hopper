// Each job's pane shell in a systemd user scope of its own (issue #410): entered after the scratch dir is
// made and before Claude starts, so everything the job starts is in it; a machine without systemd goes on
// without one, and the reap falls back to the environment variable.
import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, JOB_ID, setup } from './support.ts';

const DONE = { output: ['Done.', 'HOPPER_DONE'] };
const UNIT = `hopper-job-${JOB_ID}`;

describe('herdr-claude executor: the job\'s scope (issue #410)', () => {
  it('replaces the pane\'s shell with a login shell in the scope, before Claude starts, and records it', async () => {
    const { herdr, executor } = setup({ turns: [DONE], scopes: true });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    const order = herdr.calls.map((c) => (c.method === 'runInPane' ? String(c.args[1]) : c.method));
    const scratch = order.findIndex((m) => m.includes('hopper-scratch'));
    const enter = order.findIndex((m) => m.includes('exec systemd-run'));
    const check = order.findIndex((m) => m.startsWith('case "$(cat /proc/self/cgroup'));
    expect(scratch).toBeGreaterThan(-1);
    expect(enter).toBeGreaterThan(scratch);
    expect(check).toBeGreaterThan(enter);
    expect(order.indexOf('startAgent')).toBeGreaterThan(check);
    const command = order[enter]!;
    expect(command).toContain(`--unit=${UNIT}`);
    expect(command).toContain('-p KillMode=control-group -p TimeoutStopSec=10s');
    expect(command).toContain('-- "${SHELL:-/bin/sh}" -l');
    expect(command).toContain('--user --scope --quiet --collect');
    expect(saved.at(-1)).toMatchObject({ scope: UNIT });
  });

  it('a machine without systemd: the shell stays, the job runs, no scope recorded', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.agentStarts).toHaveLength(1);
    expect(saved.at(-1)).not.toHaveProperty('scope');
  });

  it('a shell that never answers fails the job before Claude starts, pane closed', async () => {
    const { herdr, executor } = setup({ turns: [DONE], scopes: true });
    // After the scope command the new shell drops every check typed into it.
    const run = herdr.runInPane.bind(herdr);
    herdr.runInPane = async (paneId, command) => { if (!command.startsWith('case ')) await run(paneId, command); };
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^pane w1:p1 never answered where its shell runs within 60000 ms/) });
    expect(herdr.agentStarts).toEqual([]);
    expect(herdr.closed).toEqual(['w1:p1']);
  });
});
