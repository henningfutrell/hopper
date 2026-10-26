// The label mirror on two hoppers at once (issue #1892, design.md "The item lifecycle"): both sync the same source on one
// database, and only the holder of the mirror's lease judges. #7's stale `hopper:failed` is corrected once, as one remove and
// one add; #9's `hopper:pr-ready`, taken off by hand, is one Run again and one new job, and no hopper puts it back. The other
// hopper logs no mirror line. Then the holder is killed: once its lease ends, the other takes it, and a label taken off #7 by
// hand is its Run again, once.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { waitFor } from '../support/wait.ts';
import { stopHosts, type CrashHost } from './harness.ts';
import { endHeld, events, issueUrl, itemOf, labelWorld, mirrorRows, REPO, requests, SCENARIO_MS, type LabelWorld } from './label-world.ts';

const worlds: LabelWorld[] = [];
afterEach(async () => {
  await stopHosts();
  for (const w of worlds.splice(0)) await w.close();
});

/** Long enough for each host to discover a few times (a host syncs every 500 ms). */
/** What the mirror logs when it judges: a drift, or a label taken off by hand. */
const MIRROR_LINES = ['differ from its work item', 'by hand: a Run again'];
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 3_000));
const jobsOf = async (h: CrashHost, n: number): Promise<Job[]> => (await h.get<{ jobs: Job[] }>('/api/jobs?limit=1000')).jobs.filter((j) => j.source?.key === issueUrl(n));
const editsOf = async (h: CrashHost, n: number): Promise<unknown[]> =>
  (await events(h, 'work_item.label_edited')).filter((ev) => ev.data.key === issueUrl(n)).map((ev) => ({ from: ev.data.from, label: ev.data.label }));

describe('the label mirror on two hoppers on one database (issue #1892)', () => {
  it('only the lease holder judges: a correction and a label edit by hand each happen once; the other takes over once the holder is killed', async () => {
    const w = await labelWorld();
    worlds.push(w);
    const a = await w.host({ connect: true });
    const b = await w.host();
    w.seed();
    await waitFor(() => (mirrorRows(w, 7).length > 0 && mirrorRows(w, 7).every((r) => r.state === 'sent') ? true : undefined), { timeoutMs: 60_000, what: 'the correction of #7 sent' })
      .catch((err: unknown) => { throw new Error(`${(err as Error).message}: ${JSON.stringify(mirrorRows(w, 7))}\n${a.output()}\n${b.output()}`); });
    // Both hosts saw #9's `hopper:pr-ready`; a person takes it off by hand.
    await settle();
    w.takeOff(9, 'hopper:pr-ready');
    await waitFor(async () => ((await jobsOf(a, 9)).length > 1 ? true : undefined), { timeoutMs: 60_000, what: 'the new job of #9' })
      .catch((err: unknown) => { throw new Error(`${(err as Error).message}: ${JSON.stringify(itemOf(w, 9))}\n${a.output()}\n${b.output()}`); });
    await settle();
    expect(w.labels(7)).toContain('hopper:pr-ready');
    expect(w.labels(7)).not.toContain('hopper:failed');
    expect(mirrorRows(w, 7).map((r) => r.op), 'the correction of #7 queued once').toEqual(['remove_labels', 'add_labels']);
    expect(requests(w, 'DELETE', `/repos/${REPO}/issues/7/labels/hopper:failed`)).toBe(1);
    expect(requests(w, 'POST', `/repos/${REPO}/issues/7/labels`)).toBe(1);
    expect(await editsOf(a, 9), 'one Run again of #9').toEqual([{ from: 'pr_open', label: 'hopper:pr-ready' }]);
    // Each new job's times and both hosts' output (issue #2831): which hopper made the second one, and after what.
    const newJobs9 = (await jobsOf(b, 9)).filter((j) => j.id !== w.jobs[9]);
    const seen9 = newJobs9.map((j) => ({ id: j.id, status: j.status, rerunOf: j.rerunOf, createdAt: j.createdAt, updatedAt: j.updatedAt, finishedAt: j.finishedAt, sync: j.sourceState?.sync }));
    expect(newJobs9, `one new job of #9: ${JSON.stringify(seen9)}\n${JSON.stringify(itemOf(w, 9))}\n${a.output()}\n${b.output()}`).toHaveLength(1);
    expect(mirrorRows(w, 9), 'no hopper put the label of #9 back').toEqual([]);

    // Only the lease holder judged: the other logged no mirror line.
    const judged = (h: CrashHost): boolean => MIRROR_LINES.some((l) => h.output().includes(l));
    expect([a, b].filter(judged), 'the hoppers that logged a mirror line').toHaveLength(1);
    const [holder, other] = judged(a) ? [a, b] : [b, a];

    // The holder is killed, and its lease ends: the other takes it and goes on alone.
    await holder.kill();
    endHeld(w);
    w.takeOff(7, 'hopper:pr-ready');
    await waitFor(async () => ((await jobsOf(other, 7)).length > 1 ? true : undefined), { timeoutMs: 60_000, what: 'the new job of #7' })
      .catch((err: unknown) => { throw new Error(`${(err as Error).message}: ${JSON.stringify(itemOf(w, 7))}\n${other.output()}`); });
    await settle();
    expect(await editsOf(other, 7), 'one Run again of #7').toEqual([{ from: 'pr_open', label: 'hopper:pr-ready' }]);
    expect((await jobsOf(other, 7)).filter((j) => j.id !== w.jobs[7])).toHaveLength(1);
    expect(mirrorRows(w, 7).map((r) => r.op), 'no second correction of #7').toEqual(['remove_labels', 'add_labels']);
  }, SCENARIO_MS);
});
