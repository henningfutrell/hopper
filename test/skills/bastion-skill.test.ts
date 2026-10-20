// Issue #2146 (the bastion path, part 1): the job's bastion ask, `sh "$HOPPER_SKILL" bastion`. It names a template with an
// observe on each target; the job's sandbox runs of that template wait for the same approvals as a sandbox ask, and the
// bastion starts only once they are approved and the template is ready. `bastion` alone says where it stands; `bastion
// stop` stops it. The user's templates, sandbox runs and bastions are doubles.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { SandboxRequestView } from '../../src/domain/sandbox-approvals.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { BastionView } from '../../src/sandbox/bastions.ts';
import { bastionAsk, type BastionFields, type BastionUser } from '../../src/skills/bastion-skill.ts';

const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const MONITORING = { operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } } as const;
const ready = { name: 'observe-uat', approval: { by: 'Ada', at: 'now' }, pending: { egress: [], profiles: [] }, profiles: [MONITORING] } as unknown as TemplateView;
const VIEW: BastionView = {
  id: 'b-1', jobId: 'job-1', template: 'observe-uat', box: 'hopper-bastion-observe-uat-b1', targets: [{ target: 'uat/monitoring/svc/grafana:80', local: 20000 }],
  state: 'running', startedAt: '2026-10-20T12:00:00.000Z', expiresAt: '2026-10-20T13:00:00.000Z', log: '',
};
const TARGETS = 'uat/monitoring/svc/grafana:80';

function ask(f: BastionFields, o: { template?: TemplateView; request?: SandboxRequestView['state']; bastions?: BastionUser['bastions'] | null } = {}) {
  const asked: { about?: unknown }[] = [];
  const started: string[] = [];
  const u: BastionUser = {
    template: (name) => (name === (o.template ?? ready).name ? o.template ?? ready : undefined),
    sandbox: (template, _job, about) => { asked.push({ about }); return { id: 'r-1', jobId: 'job-1', template, state: o.request ?? 'approved', askedAt: 'now', approvedBy: 'Ada' }; },
    ...(o.bastions === null ? {} : {
      bastions: o.bastions ?? {
        start: async (_job, t, targets) => { started.push(`${t.name} ${targets.length}`); return VIEW; },
        of: (id) => (id === 'job-1' ? VIEW : undefined),
        stop: (id) => (id === 'job-1' ? VIEW : undefined),
      },
    }),
  };
  const answer = bastionAsk(u, JOB, f, {
    no: (status, reason) => ({ status, text: `no: ${reason}` }), loaded: (text) => ({ status: 200, text }), waiting: (text) => ({ status: 202, text }),
    waitingText: (t) => `waiting: the sandbox runs of template ${t} wait for a person`, declinedText: (t) => `a person declined the sandbox runs of template ${t}`,
  });
  return { answer, asked, started };
}

describe('the bastion ask (issue #2146)', () => {
  it('starts the job\'s bastion once its sandbox runs of the template are approved, and says what it forwards', async () => {
    const { answer, asked, started } = ask({ template: 'observe-uat', targets: TARGETS, why: 'read the grafana dashboards' });
    const r = await answer;
    expect(r.status).toBe(200);
    expect(r.text).toContain('bastion b-1 of template observe-uat is running');
    expect(r.text).toContain('uat/monitoring/svc/grafana:80 on 127.0.0.1:20000 in the box');
    expect(r.text).toContain('Its kube tokens stay in the box');
    expect(r.text).toContain('sh "$HOPPER_RELAY" uat/monitoring/svc/grafana:80 -- sh -c');
    expect(started).toEqual(['observe-uat 1']);
    expect(asked).toEqual([{ about: { purpose: 'read the grafana dashboards', plan: 'a bastion that port-forwards to uat/monitoring/svc/grafana:80' } }]);
  });

  it('waits while its sandbox runs wait for a person, or the template does; a decline is a no', async () => {
    expect(await ask({ template: 'observe-uat', targets: TARGETS, why: 'w' }, { request: 'waiting' }).answer).toMatchObject({ status: 202, text: expect.stringContaining('wait for a person') });
    const pending = { ...ready, pending: { egress: [], profiles: [MONITORING] } } as unknown as TemplateView;
    expect(await ask({ template: 'observe-uat', targets: TARGETS, why: 'w' }, { template: pending }).answer).toMatchObject({ status: 202, text: expect.stringContaining('waits for a person to approve observe on namespace uat/monitoring') });
    expect(await ask({ template: 'observe-uat', targets: TARGETS, why: 'w' }, { request: 'declined' }).answer).toMatchObject({ status: 403 });
  });

  it('refuses what it cannot start, and says what to ask', async () => {
    expect(await ask({ template: 'observe-uat', why: 'w' }).answer).toMatchObject({ status: 400, text: expect.stringContaining('name the targets with --targets') });
    expect(await ask({ template: 'observe-uat', targets: TARGETS }).answer).toMatchObject({ status: 400, text: expect.stringContaining('say why the job needs the bastion') });
    expect(await ask({ template: 'other', targets: TARGETS, why: 'w' }).answer).toMatchObject({ status: 404, text: expect.stringContaining('observe/namespace/<cluster>/<namespace>') });
    expect(await ask({ template: 'observe-uat', targets: 'prod/monitoring/svc/grafana:80', why: 'w' }).answer).toMatchObject({ status: 400, text: expect.stringContaining('observe/namespace/prod/monitoring') });
    expect(await ask({ template: 'observe-uat', targets: TARGETS, why: 'w' }, { bastions: null }).answer).toMatchObject({ status: 503 });
    expect(await ask({ asset: 'open' }).answer).toMatchObject({ status: 400 });
  });

  it('says where the job\'s bastion stands, and stops it', async () => {
    expect(await ask({}).answer).toMatchObject({ status: 200, text: expect.stringContaining('bastion b-1 of template observe-uat is running') });
    expect(await ask({ asset: 'stop' }).answer).toMatchObject({ status: 200, text: expect.stringMatching(/^stopping: bastion b-1/) });
    const none = { start: async () => VIEW, of: () => undefined, stop: () => undefined };
    expect(await ask({}, { bastions: none }).answer).toMatchObject({ status: 404, text: expect.stringContaining('this job has no bastion') });
    expect(await ask({ asset: 'stop' }, { bastions: none }).answer).toMatchObject({ status: 404 });
  });
});
