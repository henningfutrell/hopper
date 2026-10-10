// Issue #651 over the real HTTP server, database and operator CLI: a proposal is a set of paths, and a person selects
// one or more to continue with. Each selected path continues as its own follow-on job, linked to the proposal and the
// parent job; the paths not selected stay on the proposal. Zero paths: accept, steer or ask for paths. Ask for more
// paths: the job writes the same proposal with more paths, and the selection made before is kept. A reviewer level may
// add a path or mark one not viable before a person sees it. The CLI's selection is the UI's. A proposal not written as
// paths reads as one path. The scripted executor's `propose` op writes the proposal; levels are doubles at their seam.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { EscalationLevel } from '../../src/domain/ports.ts';
import type { Job, ReviewItemView } from '../../src/domain/types.ts';
import { createFakeLevel } from '../../src/questions/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { LEGACY, NO_PATHS, THREE_PATHS } from '../support/proposal-paths.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(o: Omit<Parameters<typeof startTestApp>[0], 'dbPath'> = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, ...o });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const propose = (message: string, revised?: string) => ({ op: 'propose', message, ...(revised ? { revised } : {}) });
const proposalOf = async (a: TestApp, jobId: string): Promise<ReviewItemView | undefined> =>
  (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals?status=all')).body.items.find((p) => p.jobId === jobId);
const waitForProposal = (a: TestApp, jobId: string, ok: (p: ReviewItemView) => boolean) => waitFor(async () => {
  const p = await proposalOf(a, jobId);
  return p && ok(p) ? p : undefined;
}, { what: `a matching proposal on job ${jobId}` });
const forPerson = (a: TestApp, jobId: string) => waitForProposal(a, jobId, (p) => p.status === 'open' && p.stage === 'human');
const post = (a: TestApp, token: string, id: string, route: string, body: Record<string, unknown> = {}) =>
  a.ui<ReviewItemView>(`/ui/api/proposals/${id}/${route}`, body, { token });
const jobsOf = async (a: TestApp): Promise<Job[]> => {
  const q = (await a.api<Record<string, Job[]>>('GET', '/api/queue')).body;
  return Object.values(q).filter(Array.isArray).flat();
};
const followOnsOf = async (a: TestApp, parentId: string) => (await jobsOf(a)).filter((j) => j.followOn?.jobId === parentId);

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('a proposal with three paths (test 1)', () => {
  it('arrives as a path set; selecting two makes two follow-on jobs linked to the proposal and the parent job', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS), { title: 'paint the shed' });
    const p = await forPerson(a, job.id);
    expect(p.versions[0]!.paths!.paths.map((x) => [x.id, x.title, x.recommended ?? false])).toEqual([['1', 'Brush two coats', true], ['2', 'Spray gun', false], ['3', 'Leave it bare', true]]);
    expect(p.versions[0]!.sections).toMatchObject({ tldr: 'Paint the shed with a brush. It is cheap and safe.', problem: 'The shed is bare wood, and it rots in the rain.' });
    expect((await a.events()).find((e) => e.type === 'proposal.submitted' && e.jobId === job.id)!.data).toMatchObject({ tldr: 'Paint the shed with a brush. It is cheap and safe.', paths: 3 });

    expect((await post(a, token, p.id, 'accept', {})).status).toBe(400);
    expect((await post(a, token, p.id, 'accept', { paths: [{ id: '9' }] })).status).toBe(400);
    const r = await post(a, token, p.id, 'accept', { paths: [{ id: '1', note: 'oil paint, not latex' }, { id: '3' }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('accepted');
    const selected = r.body.signOff!.selected!;
    expect(selected.map((s) => [s.id, s.title, s.note])).toEqual([['1', 'Brush two coats', 'oil paint, not latex'], ['3', 'Leave it bare', undefined]]);

    const follow = await waitFor(async () => {
      const f = await followOnsOf(a, job.id);
      return f.length === 2 ? f : undefined;
    }, { what: 'two follow-on jobs' });
    expect(follow.map((f) => [f.followOn!.pathId, f.followOn!.proposalId, f.followOn!.note]).sort()).toEqual([['1', p.id, 'oil paint, not latex'], ['3', p.id, undefined]]);
    expect(selected.map((s) => s.jobId).sort()).toEqual(follow.map((f) => f.id).sort());
    expect(follow.every((f) => f.accepted === true && f.spec.proposal === undefined)).toBe(true);
    expect(follow[0]!.followOn!.siblings).toHaveLength(1);

    const parent = await a.waitForStatus(job.id, 'finished');
    expect(parent.result).toEqual({ proposal: { id: p.id, version: 1, decision: 'accept', followOns: selected.map((s) => ({ path: s.id, jobId: s.jobId })) } });
    for (const f of follow) expect((await a.waitForStatus(f.id, 'finished')).result).toEqual({ followOn: f.followOn!.pathId });

    // The proposal shows each follow-on and its live state; the path not selected stays on it.
    const after = (await a.api<ReviewItemView>('GET', `/api/proposals/${p.id}`)).body;
    expect(after.followOns!.map((f) => [f.pathId, f.jobStatus])).toEqual([['1', 'finished'], ['3', 'finished']]);
    expect(after.versions[0]!.paths!.paths.map((x) => x.id)).toEqual(['1', '2', '3']);
    const events = (await a.events()).filter((e) => e.jobId === job.id);
    expect(events.find((e) => e.type === 'proposal.accepted')!.data).toMatchObject({ proposalId: p.id, selected: [{ id: '1', note: 'oil paint, not latex' }, { id: '3' }] });
    expect((await a.events()).filter((e) => e.type === 'job.queued' && (e.data.followOn as { proposalId?: string } | undefined)?.proposalId === p.id)).toHaveLength(2);
  });

  it('a follow-on is told its path, the person\'s note and the other paths that run on their own', async () => {
    const { withAsks } = await import('../../src/job-rules/index.ts');
    const rules = withAsks('RULES', {}, undefined, { jobId: 'j', proposalId: 'p', pathId: '1', title: 'Brush two coats', text: 'Summary: two coats', note: 'oil paint', siblings: ['Path 3: Leave it bare'] });
    expect(rules).toMatch(/^RULES\n\[hopper path\] /);
    expect(rules).toContain('Path 1: Brush two coats');
    expect(rules).toContain('Summary: two coats');
    expect(rules).toContain('oil paint');
    expect(rules).toContain('Path 3: Leave it bare');
  });
});

describe('a proposal with zero paths (test 2)', () => {
  it('shows its reason; it is accepted, steered or asked for paths, never selected from or rejected', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(NO_PATHS));
    const p = await forPerson(a, job.id);
    expect(p.versions[0]!.paths).toEqual({ paths: [], none: 'the shed was painted last year.' });
    expect((await post(a, token, p.id, 'accept', { paths: [{ id: '1' }] })).status).toBe(400);
    expect((await post(a, token, p.id, 'reject', { notes: 'no' })).status).toBe(409);
    const r = await post(a, token, p.id, 'accept', { notes: 'agreed' });
    expect(r.body).toMatchObject({ status: 'accepted', signOff: { decision: 'accept', notes: 'agreed' } });
    expect(r.body.signOff!.selected).toBeUndefined();
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'accept' } });
    expect(await followOnsOf(a, job.id)).toEqual([]);
  });

  it('the proposal section declares its decisions: accept, ask for more paths, steer, reject all', async () => {
    const a = await start();
    const type = (await a.api<{ type: { decisions: { id: string; route: string; label: string }[] } }>('GET', '/api/proposals')).body.type;
    expect(type.decisions.map((d) => [d.id, d.route, d.label])).toEqual([
      ['accept', 'accept', 'Continue with selected'], ['more_paths', 'more-paths', 'Ask for more paths'], ['steer', 'steer', 'Steer'], ['reject', 'reject', 'Reject all'],
    ]);
  });
});

describe('ask for more paths (test 3)', () => {
  it('the job returns the same proposal with extra paths, and the selection made before is kept', async () => {
    const two = THREE_PATHS.replace(/Path 3: Leave it bare[\s\S]*?(?=Recommended:)/, '').replace('1 and 3', '1');
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(two, THREE_PATHS));
    const p = await forPerson(a, job.id);
    expect(p.versions[0]!.paths!.paths.map((x) => x.id)).toEqual(['1', '2']);
    const back = await post(a, token, p.id, 'more-paths', { notes: 'is there a way with no work?', paths: [{ id: '2', note: 'if the gun is cheap' }] });
    expect(back.body).toMatchObject({ status: 'revising', selection: { version: 1, paths: [{ id: '2', note: 'if the gun is cheap' }] } });
    const v2 = await waitForProposal(a, job.id, (x) => x.versions.length === 2 && x.stage === 'human');
    expect(v2.versions[1]!.paths!.paths.map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(v2.selection).toEqual({ version: 1, paths: [{ id: '2', note: 'if the gun is cheap' }] });
    expect(v2.reviews).toEqual([expect.objectContaining({ stage: 'human', verdict: 'more_paths', notes: 'is there a way with no work?' })]);
    const told = (await a.events()).find((e) => e.type === 'proposal.revision_requested' && e.jobId === job.id)!;
    expect(told.data).toMatchObject({ decision: 'more_paths', notes: 'is there a way with no work?' });
    const accepted = await post(a, token, v2.id, 'accept', { paths: [{ id: '2', note: 'if the gun is cheap' }, { id: '3' }] });
    expect(accepted.body.signOff!.selected!.map((s) => s.id)).toEqual(['2', '3']);
  });

  it('the brief keeps the paths and their numbers, and asks for new ones after them', async () => {
    const { REVIEW_SECTIONS } = await import('../../src/domain/types.ts');
    const item = { versions: [{ number: 1, text: THREE_PATHS }] } as unknown as Parameters<typeof REVIEW_SECTIONS.proposal.brief>[0];
    const brief = REVIEW_SECTIONS.proposal.brief(item, 'human', 'more_paths', 'cheaper ones');
    expect(brief).toContain('Keep paths 1, 2, 3 with their numbers');
    expect(brief).toContain('new paths from 4');
    expect(brief).toContain('cheaper ones');
    expect(brief).toContain('HOPPER_PROPOSAL');
  });

  it('steer sends a note back, and needs one', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS));
    const p = await forPerson(a, job.id);
    expect((await post(a, token, p.id, 'steer', {})).status).toBe(400);
    expect((await post(a, token, p.id, 'steer', { notes: 'think about the cost of paint' })).body).toMatchObject({ status: 'revising' });
    const v2 = await waitForProposal(a, job.id, (x) => x.versions.length === 2);
    expect(v2.versions[1]!.text).toContain('think about the cost of paint');
  });

  it('reject all ends the job with the rejection', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(THREE_PATHS));
    const p = await forPerson(a, job.id);
    expect((await post(a, token, p.id, 'reject', { notes: 'not this year' })).body).toMatchObject({ status: 'rejected' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'reject' } });
    expect(await followOnsOf(a, job.id)).toEqual([]);
  });
});

describe('frontier review of the paths', () => {
  const level = (): EscalationLevel => createFakeLevel({
    name: 'fable',
    script: () => ({ escalate: true, reason: 'never asked' }),
    review: () => ({
      verdict: 'approve', notes: 'Sound; one option was missing.',
      paths: { add: [{ title: 'Stain it', summary: 'One coat of wood stain.', tradeoffs: { security: 'none', effort: 'one hour', risk: 'low', friction: 'none' }, creates: 'one job' }], notViable: [{ id: '2', why: 'no spray gun for rent nearby' }] },
    }),
  });

  it('a level adds a path and marks one not viable before the person sees them; a path not viable cannot be selected', async () => {
    const a = await start({ seams: { levels: [level()] } });
    const token = await a.login();
    await a.ui('/ui/api/proposals/settings', { reviewers: ['fable'] }, { token });
    const job = await a.pull(propose(THREE_PATHS));
    const p = await forPerson(a, job.id);
    const paths = p.versions[0]!.paths!.paths;
    expect(paths.map((x) => [x.id, x.addedBy, x.notViable?.why])).toEqual([
      ['1', undefined, undefined], ['2', undefined, 'no spray gun for rent nearby'], ['3', undefined, undefined], ['4', 'fable', undefined],
    ]);
    expect(p.reviews[0]).toMatchObject({ stage: 'fable', verdict: 'approve', paths: { added: ['4'], notViable: ['2'] } });
    expect((await post(a, token, p.id, 'accept', { paths: [{ id: '2' }] })).status).toBe(400);
    expect((await post(a, token, p.id, 'accept', { paths: [{ id: '4' }] })).body.signOff!.selected!.map((s) => s.title)).toEqual(['Stain it']);
  });
});

describe('the operator CLI (test 4)', () => {
  it('lists the paths and selects them as the UI does', async () => {
    const a = await start();
    const viaUi = await a.pull(propose(THREE_PATHS));
    const viaCli = await a.pull(propose(THREE_PATHS));
    const pu = await forPerson(a, viaUi.id);
    const pc = await forPerson(a, viaCli.id);

    const list = await hopper(a, ['proposal', 'list', '--json']);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.out) as { id: string }[]).map((x) => x.id).sort()).toEqual([pu.id, pc.id].sort());
    const shown = await hopper(a, ['proposal', 'paths', pc.id]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ id: pc.id, version: 1, problem: 'The shed is bare wood, and it rots in the rain.', paths: [{ id: '1', title: 'Brush two coats', recommended: true }, { id: '2' }, { id: '3' }] });

    const token = await a.login();
    const ui = (await post(a, token, pu.id, 'accept', { paths: [{ id: '1', note: 'oil paint' }, { id: '3' }] })).body;
    const cli = await hopper(a, ['proposal', 'select', pc.id, '1', '3', '--path-note', '1=oil paint']);
    expect(cli.code).toBe(0);
    const byCli = JSON.parse(cli.out) as ReviewItemView;
    const shape = (p: ReviewItemView) => ({ status: p.status, selected: p.signOff!.selected!.map(({ id, title, note }) => ({ id, title, note })), jobs: p.signOff!.selected!.every((s) => typeof s.jobId === 'string') });
    expect(shape(byCli)).toEqual(shape(ui));
    expect(byCli.signOff!.by).toBe('operator CLI');
    await waitFor(async () => ((await followOnsOf(a, viaCli.id)).length === 2 ? true : undefined), { what: 'the CLI\'s two follow-ons' });

    const refused = await hopper(a, ['proposal', 'select', pc.id, '1']);
    expect(refused.code).toBe(2);
    expect((await hopper(a, ['proposal', 'select', pc.id])).code).toBe(2);
  });

  it('asks for more paths, steers and rejects all from the CLI', async () => {
    const a = await start();
    const one = await a.pull(propose(THREE_PATHS));
    const p = await forPerson(a, one.id);
    const more = await hopper(a, ['proposal', 'more-paths', p.id, '--note', 'a cheaper one', '--select', '2']);
    expect(more.code).toBe(0);
    expect(JSON.parse(more.out)).toMatchObject({ status: 'revising', selection: { paths: [{ id: '2' }] } });
    const v2 = await waitForProposal(a, one.id, (x) => x.versions.length === 2 && x.stage === 'human');
    expect((await hopper(a, ['proposal', 'steer', v2.id])).code).toBe(2);
    expect(JSON.parse((await hopper(a, ['proposal', 'reject', v2.id, '--note', 'not now'])).out)).toMatchObject({ status: 'rejected' });
  });
});

describe('a proposal not written as paths (test 5)', () => {
  it('reads as one path; selecting it continues as one follow-on', async () => {
    const a = await start();
    const token = await a.login();
    const job = await a.pull(propose(LEGACY));
    const p = await forPerson(a, job.id);
    expect(p.versions[0]!.paths).toMatchObject({ single: true, paths: [{ id: '1', title: 'paint the shed', summary: 'two coats with a brush' }] });
    const r = await post(a, token, p.id, 'accept', { paths: [{ id: '1' }] });
    expect(r.body.signOff!.selected!.map((s) => s.title)).toEqual(['paint the shed']);
    await waitFor(async () => ((await followOnsOf(a, job.id)).length === 1 ? true : undefined), { what: 'one follow-on' });
  });
});
