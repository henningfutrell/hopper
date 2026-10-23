// Issue #2146 (the bastion path, part 1): the job's bastion ask, `sh "$HOPPER_SKILL" bastion`. It names a template with an
// observe on each target; the job's sandbox runs of that template wait for the same approvals as a sandbox ask, and the
// bastion starts only once they are approved and the template is ready. `bastion` alone says where it stands; `bastion
// stop` stops it. Part 3: each target is one the template names as a bastion target, approved with it. Part 6: the vault
// secrets its box holds (`--secrets`), and `bastion read`, one HTTP read of a target in the box. The user's
// templates, sandbox runs and bastions are doubles.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { SandboxRequestView } from '../../src/domain/sandbox-approvals.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { BastionRead } from '../../src/sandbox/bastion-read.ts';
import type { BastionView } from '../../src/sandbox/bastions.ts';
import { bastionAsk, type BastionFields, type BastionUser } from '../../src/skills/bastion-skill.ts';

const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const MONITORING = { operation: 'observe', asset: { kind: 'namespace', name: 'utility/monitoring' } } as const;
const ready = { name: 'observe-utility', approval: { by: 'Ada', at: 'now' }, pending: { egress: [], profiles: [], bastionTargets: [] }, profiles: [MONITORING], bastionTargets: ['utility/monitoring/svc/grafana:80'] } as unknown as TemplateView;
const VIEW: BastionView = {
  id: 'b-1', jobId: 'job-1', template: 'observe-utility', box: 'hopper-bastion-observe-utility-b1', targets: [{ target: 'utility/monitoring/svc/grafana:80', local: 20000 }],
  state: 'running', startedAt: '2026-10-20T12:00:00.000Z', expiresAt: '2026-10-20T13:00:00.000Z', log: '',
};
const TARGETS = 'utility/monitoring/svc/grafana:80';

function ask(f: BastionFields, o: { template?: TemplateView; request?: SandboxRequestView['state']; bastions?: BastionUser['bastions'] | null } = {}) {
  const asked: { about?: unknown }[] = [];
  const started: string[] = [];
  const reads: BastionRead[] = [];
  const u: BastionUser = {
    template: (name) => (name === (o.template ?? ready).name ? o.template ?? ready : undefined),
    sandbox: (template, _job, about) => { asked.push({ about }); return { id: 'r-1', jobId: 'job-1', template, state: o.request ?? 'approved', askedAt: 'now', approvedBy: 'Ada' }; },
    ...(o.bastions === null ? {} : {
      bastions: o.bastions ?? {
        start: async (_job, t, targets, secrets) => { started.push(`${t.name} ${targets.length}${secrets?.length ? ` ${secrets.join(',')}` : ''}`); return VIEW; },
        of: (id) => (id === 'job-1' ? VIEW : undefined),
        stop: (id) => (id === 'job-1' ? VIEW : undefined),
        read: async (_id, r) => { reads.push(r); return r.path === '/api/forbidden' ? { status: 403, body: Buffer.from('{"message":"Permission denied"}') } : { status: 200, body: Buffer.from('[{"uid":"abc"}]') }; },
      },
    }),
  };
  const answer = bastionAsk(u, JOB, f, {
    no: (status, reason) => ({ status, text: `no: ${reason}` }), loaded: (text) => ({ status: 200, text }), waiting: (text) => ({ status: 202, text }),
    waitingText: (t) => `waiting: the sandbox runs of template ${t} wait for a person`, declinedText: (t) => `a person declined the sandbox runs of template ${t}`,
  });
  return { answer, asked, started, reads };
}

describe('the bastion ask (issue #2146)', () => {
  it('starts the job\'s bastion once its sandbox runs of the template are approved, and says what it forwards', async () => {
    const { answer, asked, started } = ask({ template: 'observe-utility', targets: TARGETS, why: 'read the grafana dashboards' });
    const r = await answer;
    expect(r.status).toBe(200);
    expect(r.text).toContain('bastion b-1 of template observe-utility is running');
    expect(r.text).toContain('utility/monitoring/svc/grafana:80 on 127.0.0.1:20000 in the box');
    expect(r.text).toContain('Its kube tokens stay in the box');
    expect(r.text).toContain('sh "$HOPPER_RELAY" utility/monitoring/svc/grafana:80 -- sh -c');
    expect(started).toEqual(['observe-utility 1']);
    expect(asked).toEqual([{ about: { purpose: 'read the grafana dashboards', plan: 'a bastion that port-forwards to utility/monitoring/svc/grafana:80' } }]);
  });

  it('waits while its sandbox runs wait for a person, or the template does; a decline is a no', async () => {
    expect(await ask({ template: 'observe-utility', targets: TARGETS, why: 'w' }, { request: 'waiting' }).answer).toMatchObject({ status: 202, text: expect.stringContaining('wait for a person') });
    const pending = { ...ready, pending: { egress: [], profiles: [MONITORING], bastionTargets: [] } } as unknown as TemplateView;
    expect(await ask({ template: 'observe-utility', targets: TARGETS, why: 'w' }, { template: pending }).answer).toMatchObject({ status: 202, text: expect.stringContaining('waits for a person to approve observe on namespace utility/monitoring') });
    expect(await ask({ template: 'observe-utility', targets: TARGETS, why: 'w' }, { request: 'declined' }).answer).toMatchObject({ status: 403 });
  });

  it('refuses what it cannot start, and says what to ask', async () => {
    expect(await ask({ template: 'observe-utility', why: 'w' }).answer).toMatchObject({ status: 400, text: expect.stringContaining('name the targets with --targets') });
    expect(await ask({ template: 'observe-utility', targets: TARGETS }).answer).toMatchObject({ status: 400, text: expect.stringContaining('say why the job needs the bastion') });
    expect(await ask({ template: 'other', targets: TARGETS, why: 'w' }).answer).toMatchObject({ status: 404, text: expect.stringContaining('observe/namespace/<cluster>/<namespace>') });
    expect(await ask({ template: 'observe-utility', targets: 'prod/monitoring/svc/grafana:80', why: 'w' }).answer).toMatchObject({ status: 400, text: expect.stringContaining('observe/namespace/prod/monitoring') });
    expect(await ask({ template: 'observe-utility', targets: TARGETS, why: 'w' }, { bastions: null }).answer).toMatchObject({ status: 503 });
    expect(await ask({ asset: 'open' }).answer).toMatchObject({ status: 400 });
  });

  it('takes only targets the template names as bastion targets; one a person has not approved yet waits (part 3)', async () => {
    const loki = 'utility/monitoring/svc/loki:3100';
    const unnamed = await ask({ template: 'observe-utility', targets: loki, why: 'w' }).answer;
    expect(unnamed).toMatchObject({ status: 400 });
    expect(unnamed.text).toContain(`template observe-utility names no bastion target ${loki}`);
    expect(unnamed.text).toContain(`sh "$HOPPER_SKILL" sandbox-template --needs "observe/namespace/utility/monitoring" --targets "${loki}"`);
    const waiting = { ...ready, bastionTargets: [TARGETS, loki], pending: { egress: [], profiles: [], bastionTargets: [loki] } } as unknown as TemplateView;
    const r = ask({ template: 'observe-utility', targets: `${TARGETS} ${loki}`, why: 'w' }, { template: waiting });
    expect(await r.answer).toMatchObject({ status: 202, text: expect.stringContaining(`the bastion target ${loki} of template observe-utility waits for a person to approve it`) });
    expect(r.started).toEqual([]);
  });

  it('says where the job\'s bastion stands, and stops it', async () => {
    expect(await ask({}).answer).toMatchObject({ status: 200, text: expect.stringContaining('bastion b-1 of template observe-utility is running') });
    expect(await ask({ asset: 'stop' }).answer).toMatchObject({ status: 200, text: expect.stringMatching(/^stopped: bastion b-1/) });
    const none = { start: async () => VIEW, of: () => undefined, stop: () => undefined, read: async () => ({ status: 404, no: 'this job has no bastion that runs' }) };
    expect(await ask({}, { bastions: none }).answer).toMatchObject({ status: 404, text: expect.stringContaining('this job has no bastion') });
    expect(await ask({ asset: 'stop' }, { bastions: none }).answer).toMatchObject({ status: 404 });
  });

  it('gives the bastion the vault secrets the job names, and says how to read with them (part 6)', async () => {
    const r = ask({ template: 'observe-utility', targets: TARGETS, why: 'w', secrets: ' grafana-viewer ' });
    expect((await r.answer).status).toBe(200);
    expect(r.started).toEqual(['observe-utility 1 grafana-viewer']);
    const holding = { ...VIEW, secrets: ['grafana-viewer'] };
    const status = await ask({}, { bastions: { start: async () => holding, of: () => holding, stop: () => holding, read: async () => ({ status: 200, body: Buffer.alloc(0) }) } }).answer;
    expect(status.text).toContain('It holds the vault secrets grafana-viewer for reads in the box');
    expect(status.text).toContain('sh "$HOPPER_SKILL" bastion read --targets TARGET --path');
  });

  it('runs a bastion read and answers the target\'s body; another status is a no with it (part 6)', async () => {
    const r = ask({ asset: 'read', targets: TARGETS, path: '/api/search?query=latency', secrets: 'grafana-viewer' });
    expect(await r.answer).toEqual({ status: 200, text: '[{"uid":"abc"}]' });
    expect(r.reads).toEqual([{ target: TARGETS, path: '/api/search?query=latency', method: 'GET', secret: 'grafana-viewer' }]);
    const data = '{"queries":[{"refId":"A","expr":"up"}]}';
    const post = ask({ asset: 'read', targets: TARGETS, path: '/api/ds/query', secrets: 'grafana-viewer', data });
    await post.answer;
    expect(post.reads).toMatchObject([{ method: 'POST', data }]);
    expect(await ask({ asset: 'read', targets: TARGETS, path: '/api/forbidden' }).answer).toEqual({ status: 502, text: `no: ${TARGETS} answered 403: {"message":"Permission denied"}` });
  });

  it('refuses a read it cannot run, and passes on the bastion\'s no (part 6)', async () => {
    const write = await ask({ asset: 'read', targets: TARGETS, path: '/api/dashboards/db', data: '{}' }).answer;
    expect(write).toMatchObject({ status: 400, text: expect.stringContaining('a read POSTs only to /api/ds/query') });
    expect(await ask({ asset: 'read', path: '/api/health' }).answer).toMatchObject({ status: 400, text: expect.stringContaining('name one target') });
    const none = { start: async () => VIEW, of: () => undefined, stop: () => undefined, read: async () => ({ status: 404, no: 'this job has no bastion that runs' }) };
    expect(await ask({ asset: 'read', targets: TARGETS, path: '/api/health' }, { bastions: none }).answer).toEqual({ status: 404, text: 'no: this job has no bastion that runs' });
  });
});
