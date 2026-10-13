// Issue #715, through the real composition root and the real HTTP server, as test/integration/read-only-check.test.ts
// runs the read-only check: the suite's result is a job artifact. The job that asked for the template owns one report,
// an HTML page of each probe; each check of the template, scheduled or asked for again, is a new revision of it. The
// check on the template and `template.checked` name it. A template a person asked for has no job: its check is kept on
// the template only.
//
// Feature: the read-only check's report as a job artifact
//   Scenario: a check makes a report artifact of the job that asked for the template; the next check revises it
//   Scenario: a template a person asked for keeps its check with no artifact
import { afterEach, describe, expect, it } from 'vitest';
import { boot, asked, runningJob, skill, stopAll, vault } from '../support/read-only-check.ts';

afterEach(stopAll);

describe('the read-only check\'s report as a job artifact (issue #715)', () => {
  it('a check makes a report artifact of the job that asked for the template; the next check revises it', async () => {
    const { a, token, cloud } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    const [job] = a.user().store.jobs.list();
    await skill(a, creds, ['sandbox-template', '--why', 'Read the lab for the report', '--needs', 'read/cluster/lab']);
    const t = await asked(a, token);
    expect(t.askedBy).toBe(job!.id);
    await a.app.sandboxes.check();

    const checked = await asked(a, token);
    expect(checked.check).toMatchObject({ state: 'passed', artifact: expect.any(String) });
    const id = checked.check!.artifact!;
    const art = a.user().artifacts.get(id)!;
    expect(art).toMatchObject({
      jobId: job!.id, name: `read-only-check-${t.name}.html`, kind: 'html', title: `Read-only check: ${t.name}`, revision: 1, revisedBy: 'read-only check',
      summary: `passed: ${checked.check!.probes.length} probes, every write refused, every read worked`,
    });
    const page = a.user().artifacts.content(id)!.toString('utf8');
    for (const p of checked.check!.probes) expect(page).toContain(p.id);
    const events = await a.events();
    expect(events.find((e) => e.type === 'template.checked')?.data).toEqual({ template: t.name, state: 'passed', failed: [], artifact: id });
    expect(events.find((e) => e.type === 'artifact.created')).toMatchObject({ jobId: job!.id, data: { artifact: id } });

    // The account changes; a person runs the check again: the same artifact, a new revision, the failure in it.
    cloud.setMode('writable');
    expect((await vault(a, token, { action: 'check-template', name: t.name })).status).toBe(200);
    await a.app.sandboxes.check();
    const failed = await asked(a, token);
    expect(failed.check).toMatchObject({ state: 'failed', artifact: id });
    expect(a.user().artifacts.get(id)).toMatchObject({ revision: 2, revisedBy: 'read-only check', summary: expect.stringMatching(/^failed: 3 of \d+ probes failed \(kube\.create-namespace on lab \(allowed\)/) });
    expect(a.user().artifacts.list()).toHaveLength(1);
    expect((await a.events()).filter((e) => e.type === 'artifact.revised').map((e) => e.data)).toEqual([expect.objectContaining({ artifact: id, revision: 2, by: 'read-only check' })]);
  });

  it('a template a person asked for keeps its check with no artifact', async () => {
    const { a, token } = await boot(['cluster/lab']);
    expect((await vault(a, token, { action: 'request-template', needs: 'read/cluster/lab' })).status).toBe(200);
    const t = await asked(a, token);
    expect(t.askedBy).toBeUndefined();
    await a.app.sandboxes.check();
    const checked = await asked(a, token);
    expect(checked.check).toMatchObject({ state: 'passed' });
    expect(checked.check!.artifact).toBeUndefined();
    expect(a.user().artifacts.list()).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'template.checked')?.data).toEqual({ template: t.name, state: 'passed', failed: [] });
  });
});
