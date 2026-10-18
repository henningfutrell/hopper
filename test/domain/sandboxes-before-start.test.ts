// Issue #1471: before a job starts, the hopper finds the sandbox templates its prompt names, asks for each of them at
// once, and holds the job until every one is approved and ready. A job no longer learns of a missing sandbox mid-run.
import { describe, expect, it } from 'vitest';
import { namedTemplates, SANDBOXES_HOLD, sandboxesHold } from '../../src/domain/sandboxes-before-start.ts';
import type { SandboxRequestView } from '../../src/domain/sandbox-approvals.ts';
import type { TemplateView } from '../../src/domain/vault.ts';

const names = ['cluster-role-builder', 'web', 'web-2', 'aws.read'];

describe('the templates a job names (issue #1471)', () => {
  it('finds a template named after "template" or "box", quoted or not, each once, in the order of the user\'s templates', () => {
    const prompt = [
      'Work in a box of template `cluster-role-builder`.',
      'Then run: sh "$HOPPER_STEP" box cluster-role-builder --command "kubectl get ns"',
      'Use the template "aws.read" for the reads.',
    ].join('\n');
    expect(namedTemplates(prompt, names)).toEqual(['cluster-role-builder', 'aws.read']);
  });

  it('a template name that is only a word of the text is not named: it needs "template" or "box" before it', () => {
    expect(namedTemplates('Fix the web page and the cluster-role-builder docs.', names)).toEqual([]);
  });

  it('a name is matched whole: "template web-2" names web-2, not web; "box web." names web; "templates web" names none', () => {
    expect(namedTemplates('Use template web-2 here.', names)).toEqual(['web-2']);
    expect(namedTemplates('Run it in the box web.', names)).toEqual(['web']);
    expect(namedTemplates('Use templates web and web-2.', names)).toEqual([]);
  });

  it('a name no template of the user has is not named', () => {
    expect(namedTemplates('Use template cluster-admin.', names)).toEqual([]);
  });
});

const ready = (name: string): TemplateView => ({ name, approval: { by: 'Ada', at: 'now' }, pending: { egress: [], profiles: [] } }) as unknown as TemplateView;
const notReady = (name: string): TemplateView => ({ name, pending: { egress: [], profiles: [] } }) as unknown as TemplateView;
const request = (template: string, state: SandboxRequestView['state']): SandboxRequestView => ({ id: `r-${template}`, jobId: 'j', template, state, askedAt: 'now' });

describe('the hold of a job whose sandboxes are not approved yet (issue #1471)', () => {
  it('holds while a request waits for a person, naming every one that waits', () => {
    const hold = sandboxesHold([request('a', 'waiting'), request('b', 'approved'), request('c', 'waiting')], [ready('a'), ready('b'), ready('c')]);
    expect(hold).toBe(`${SANDBOXES_HOLD}: the sandbox runs of template a, c wait for a person on Access requests`);
  });

  it('holds while an approved request\'s template is not ready', () => {
    expect(sandboxesHold([request('a', 'approved')], [notReady('a')])).toBe(`${SANDBOXES_HOLD}: template a waits for a person or for its read-only check on Access requests`);
    expect(sandboxesHold([request('a', 'approved')], [])).toBe(`${SANDBOXES_HOLD}: template a waits for a person or for its read-only check on Access requests`);
  });

  it('says both when both hold it', () => {
    expect(sandboxesHold([request('a', 'waiting'), request('b', 'approved')], [ready('a'), notReady('b')]))
      .toBe(`${SANDBOXES_HOLD}: the sandbox runs of template a wait for a person on Access requests; template b waits for a person or for its read-only check on Access requests`);
  });

  it('a declined request does not hold the job: a person said no, and the job finds another way', () => {
    expect(sandboxesHold([request('a', 'declined')], [notReady('a')])).toBeUndefined();
  });

  it('every request approved and every template ready: no hold', () => {
    expect(sandboxesHold([request('a', 'approved'), request('b', 'approved')], [ready('a'), ready('b')])).toBeUndefined();
    expect(sandboxesHold([], [])).toBeUndefined();
  });
});
