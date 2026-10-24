// Issue #558: the Vault settings page's pure model. A secret is only its metadata: the page says what it is, who set
// it and when — never a value — and checks a name before anything is sent.
import { describe, expect, it } from 'vitest';
import { BOX_TOOLS as SERVER_TOOLS } from '../../src/domain/sandboxes.ts';
import { approvalText, BOX_TOOLS, EGRESS_HOST, egressOf, egressText, checkText, markableProbes, probeMarksText, toolsText, explicitApprovals, giveProblem, profileAskOf, kindChoices, mintsOf, mintsValueOf, profileText, radiusText, keptText, nameProblem, referenceHint, requestWaiting, secretFacts } from '../../ui/src/model/vault.ts';

describe('a vault secret on the page', () => {
  it('says its scope, who set it and who last changed it; never a value', () => {
    const facts = secretFacts({ id: 'a', name: 'KUBE_TOKEN', scope: 'k3s lab, namespace default', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Bo', changedAt: '2026-10-09T11:00:00Z' });
    expect(facts.map((f) => f.label)).toEqual(['Scope', 'Set by', 'Changed by']);
    expect(facts[0]!.value).toBe('k3s lab, namespace default');
    expect(facts[2]!.value).toContain('Bo');
  });

  it('without a scope or a change since it was set: only who set it', () => {
    const facts = secretFacts({ id: 'a', name: 'X', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Ada', changedAt: '2026-10-09T10:00:00Z' });
    expect(facts.map((f) => f.label)).toEqual(['Set by']);
  });
});

describe('a vault secret kept in a vault backend (issue #585)', () => {
  const kept = { id: 'a', name: 'DB_PASS', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Ada', changedAt: '2026-10-09T10:00:00Z', backend: { name: 'my-vault', reference: 'apps/db#password' } };

  it('says where it is kept and that it is read there at each use; the hopper holds no value', () => {
    expect(secretFacts(kept).find((f) => f.label === 'Kept in')!.value).toBe('my-vault · apps/db#password');
    expect(keptText(kept)).toBe('kept in my-vault · read at each use');
    expect(keptText({ ...kept, backend: undefined })).toBe('value set · write-only');
  });

  it('the reference field shows the form each backend reads', () => {
    expect(referenceHint('hashicorp-vault')).toBe('apps/db#password');
    expect(referenceHint('1password')).toBe('op://Infra/db/password');
    expect(referenceHint('bitwarden')).toMatch(/^[0-9a-f-]{36}$/);
    expect(referenceHint('a-custom-plugin')).toBe('');
  });
});

describe('a name', () => {
  it('is a letter, then letters, digits, `_`, `.`, `-`, at most 64', () => {
    expect(nameProblem('KUBE_TOKEN')).toBeUndefined();
    expect(nameProblem('aws.prod-ro')).toBeUndefined();
    expect(nameProblem('')).toMatch(/name/);
    expect(nameProblem('1x')).toMatch(/letter/);
    expect(nameProblem('a b')).toMatch(/letter/);
    expect(nameProblem('x'.repeat(65))).toMatch(/64/);
  });
});

describe('a template on the page', () => {
  const radius = { level: 'low' as const, reasons: [], profiles: [] };
  const base = { name: 'kube', image: 'img', secrets: ['A', 'B'], profiles: [], savedBy: 'Ada', savedAt: '2026-10-09T10:00:00Z', radius };
  it('never approved: its boxes take no job and get nothing', () => {
    expect(approvalText({ ...base, pending: { secrets: ['A', 'B'], image: true, egress: [], profiles: [] }, gives: [] })).toBe('not approved yet: its boxes take no job and get nothing from the vault');
  });
  it('approved as it is', () => {
    expect(approvalText({ ...base, approval: { image: 'img', secrets: ['A', 'B'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, egress: [], profiles: [] }, gives: ['A', 'B'] })).toBe('approved');
  });
  it('widened or a new image: says what waits', () => {
    expect(approvalText({ ...base, approval: { image: 'old', secrets: ['A'], by: 'Ada', at: '' }, pending: { secrets: ['B'], image: true, egress: [], profiles: [] }, gives: [] })).toBe('waits for approval: a new image; B added');
  });
  // Issue #1875: an egress host added waits for a person, and the card says which.
  it('an egress host added: says what waits, and marks it', () => {
    const t = { ...base, egress: ['a.test:443', 'b.test:8443'], approval: { image: 'img', secrets: ['A', 'B'], egress: ['a.test:443'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, egress: ['b.test:8443'], profiles: [] }, gives: [] };
    expect(approvalText(t)).toBe('waits for approval: egress to b.test:8443');
    expect(egressText(t)).toBe('a.test:443, b.test:8443 (waits)');
    expect(egressText({})).toBe('none');
    expect(egressOf(' A.test:443,b.test:8443\nA.test:443 ')).toEqual(['a.test:443', 'b.test:8443']);
    expect(['a.test:443', '10.0.0.5:6443'].every((h) => EGRESS_HOST.test(h))).toBe(true);
    expect(['a.test', 'https://a.test:443', '*.a.test:443', 'a.test:0'].some((h) => EGRESS_HOST.test(h))).toBe(false);
  });
  // Issue #584: a profile added waits too; a write, sync or apply profile waits for its own explicit approval.
  const READ = { operation: 'read' as const, asset: { kind: 'cluster' as const, name: 'x' } };
  const WRITE = { operation: 'write' as const, asset: { kind: 'cluster' as const, name: 'x' } };
  it('a profile added: says which, and which needs an explicit approval', () => {
    const t = { ...base, profiles: [READ, WRITE], approval: { image: 'img', secrets: ['A', 'B'], by: 'Ada', at: '' }, pending: { secrets: [], image: false, egress: [], profiles: [READ, WRITE] }, gives: ['A', 'B'] };
    expect(approvalText(t)).toBe('waits for approval: read on cluster x; write on cluster x (explicit)');
    expect(explicitApprovals(t)).toEqual([WRITE]);
    expect(profileText(WRITE)).toBe('write on cluster x');
  });
  it('the rating in a few words, its level first', () => {
    expect(radiusText({ level: 'high', reasons: ['write on cluster x: it changes the asset; approved'], profiles: [] })).toBe('high radius: write on cluster x: it changes the asset; approved');
    expect(radiusText({ level: 'low', reasons: ['a', 'b'], profiles: [] })).toBe('low radius: a; b');
  });
});

describe('a delivered secret on the page', () => {
  it('says when it was last delivered, to which machine and job', () => {
    const facts = secretFacts({ id: 'a', name: 'KUBE_TOKEN', setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Ada', changedAt: '2026-10-09T10:00:00Z', lastUsed: { at: '2026-10-09T12:00:00Z', machine: 'hopper-sandbox-kube', job: 'f3b1c2d4-0000-4000-8000-000000000001' } });
    expect(facts.map((f) => f.label)).toEqual(['Set by', 'Last delivered']);
    expect(facts[1]!.value).toContain('hopper-sandbox-kube');
    expect(facts[1]!.value).toContain('f3b1c2d4');
  });
});

describe('a minting credential on the page (issue #580)', () => {
  it('says what it mints for, and when it last minted', () => {
    const facts = secretFacts({ id: 'a', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, setBy: 'Ada', createdAt: '2026-10-09T10:00:00Z', changedBy: 'Ada', changedAt: '2026-10-09T10:00:00Z', lastUsed: { at: '2026-10-09T12:00:00Z', machine: 'hopper-sandbox-kube', job: 'f3b1c2d4-0000-4000-8000-000000000001' } });
    expect(facts.map((f) => f.label)).toEqual(['Mints for', 'Set by', 'Last minted']);
    expect(facts[0]!.value).toBe('cluster lab');
  });

  it('reads "mints for" as an AWS account or a cluster, or says why not; empty is a plain secret', () => {
    expect(mintsOf('')).toBeUndefined();
    expect(mintsOf(' cluster/lab ')).toEqual({ kind: 'cluster', name: 'lab' });
    expect(mintsOf('aws-account/123456789012')).toEqual({ kind: 'aws-account', name: '123456789012' });
    expect(mintsOf('namespace/lab/web')).toMatch(/cluster\/NAME, aws-account\/ID or database\/CLUSTER\/NAMESPACE\/DATABASE/);
    expect(mintsOf('cluster/')).toMatch(/cluster\/NAME, aws-account\/ID or database/);
    // Issue #2231: a database, by its whole name.
    expect(mintsOf('database/lab/apps/orders')).toEqual({ kind: 'database', name: 'lab/apps/orders' });
  });

  it('shows a database\'s minting credential as one JSON value, and says why a value is not one (issue #2231)', () => {
    const db = { kind: 'database', name: 'lab/apps/orders' } as const;
    expect(mintsValueOf(db, '')).toEqual({ shape: expect.stringContaining('"engine": "postgres"') });
    expect(mintsValueOf(db, JSON.stringify({ engine: 'postgres', host: 'db', database: 'orders', user: 'm', password: 'p', schemas: ['app'] })).problem).toBeUndefined();
    expect(mintsValueOf(db, JSON.stringify({ engine: 'postgres', host: 'db', password: 'secret-pw' })).problem).toBe('a database\'s minting credential is JSON with engine, host, database, user, password and schemas');
    expect(mintsValueOf(db, 'secret-pw').problem).not.toContain('secret-pw');
  });

  it('shows an AWS account\'s minting credential as one JSON value with both keys, and says why a value is not one (issue #1761)', () => {
    const aws = { kind: 'aws-account', name: '123456789012' } as const;
    expect(mintsValueOf(undefined, 'anything')).toEqual({});
    expect(mintsValueOf(aws, '')).toEqual({ shape: expect.stringContaining('"AccessKeyId"') });
    expect(mintsValueOf(aws, '')).toEqual({ shape: expect.stringContaining('"SecretAccessKey"') });
    expect(mintsValueOf(aws, JSON.stringify({ AccessKeyId: 'AKIAEXAMPLE', SecretAccessKey: 'secret' })).problem).toBeUndefined();
    expect(mintsValueOf(aws, 'AKIAEXAMPLE').problem).toMatch(/AccessKeyId and SecretAccessKey/);
    expect(mintsValueOf(aws, 'AKIAEXAMPLE').problem).not.toContain('AKIAEXAMPLE');
    expect(mintsValueOf(aws, JSON.stringify({ AccessKeyId: 'AKIAEXAMPLE' })).problem).toMatch(/AccessKeyId and SecretAccessKey/);
    expect(mintsValueOf({ kind: 'cluster', name: 'lab' }, 'x')).toEqual({ shape: expect.stringContaining('"server"') });
  });
});

describe('a credential request on the page (issue #583)', () => {
  const request = {
    id: 'r1', skill: 'example-api', title: 'example-api', known: false, template: 'web', secret: 'example-api', setup: 'Ask whoever runs example-api for a token',
    kinds: [{ id: 'asked', title: 'an API token' }, { id: 'config', title: 'a config file' }],
    asked: [{ job: 'f3b1c2d4-0000-4000-8000-000000000001', machine: 'hopper-sandbox-web', why: 'deploy the web service', at: '2026-10-09T10:00:00Z' }],
    existing: [], createdAt: '2026-10-09T10:00:00Z',
  };

  it('says who waits — the job, its box and why — and offers the suggested kinds first, then something else', () => {
    expect(requestWaiting(request)).toEqual(['job f3b1c2d4 on hopper-sandbox-web: deploy the web service']);
    expect(kindChoices(request).map((k) => k.id)).toEqual(['asked', 'config', 'other']);
  });

  it('something else needs the user\'s words; a value is needed unless a secret the vault holds is given', () => {
    expect(giveProblem({ name: 'example-api', kind: 'asked', note: '', value: 'x' }, request)).toBeUndefined();
    expect(giveProblem({ name: 'example-api', kind: 'other', note: '', value: 'x' }, request)).toMatch(/say what/);
    expect(giveProblem({ name: 'example-api', kind: 'asked', note: '', value: '' }, request)).toMatch(/value/);
    expect(giveProblem({ name: 'example-api', kind: 'asked', note: '', value: '' }, { ...request, existing: ['example-api'] })).toBeUndefined();
    expect(giveProblem({ name: '1x', kind: 'asked', note: '', value: 'x' }, request)).toMatch(/letter/);
  });
});

describe('a template\'s tools (issue #716)', () => {
  it('the page offers the tools the server adds', () => {
    expect([...BOX_TOOLS]).toEqual([...SERVER_TOOLS]);
  });

  it('says its tools, and which wait for approval', () => {
    expect(toolsText({})).toBe('none');
    expect(toolsText({ tools: ['helm', 'kubectl'] })).toBe('helm, kubectl');
    expect(toolsText({ tools: ['aws', 'kubectl'], approval: { tools: ['kubectl'] } })).toBe('aws (waits), kubectl');
  });
});

describe('a template\'s read-only check on the page (issue #716)', () => {
  const at = '2026-10-10T20:00:00.000Z';
  const probe = (id: string, passed: boolean, outcome: string) => ({ id, asset: 'lab', outcome, passed });
  it('none for a template that takes no check', () => {
    expect(checkText({ savedAt: at })).toBeUndefined();
  });
  it('not run, running, passed and failed; a check of an older version is not run on this one', () => {
    expect(checkText({ readOnly: true, savedAt: at })).toEqual({ text: 'not run on this version yet: it runs once the template is approved', waits: true });
    expect(checkText({ readOnly: true, savedAt: at, check: { version: 'older', state: 'passed', probes: [] } })?.waits).toBe(true);
    expect(checkText({ readOnly: true, savedAt: at, check: { version: at, state: 'running', probes: [] } })).toEqual({ text: 'runs now', waits: true });
    expect(checkText({ readOnly: true, savedAt: at, check: { version: at, state: 'passed', probes: [probe('kube.get', true, 'allowed')] } }))
      .toEqual({ text: 'passed: 1 probes, every write refused, every read worked', waits: false });
    expect(checkText({ readOnly: true, savedAt: at, check: { version: at, state: 'failed', probes: [probe('kube.get', true, 'allowed'), probe('kube.create-namespace', false, 'allowed')], problem: 'it ran out of time' } }))
      .toEqual({ text: 'failed: kube.create-namespace on lab (allowed); it ran out of time', waits: true });
  });
  it('names the probes the template marks (issue #916), and offers each read probe for a mark', () => {
    const helm = { ...probe('helm.list', true, 'denied'), mark: 'expect-denied' };
    expect(checkText({ readOnly: true, savedAt: at, check: { version: at, state: 'passed', probes: [probe('kube.get', true, 'allowed'), helm] } }))
      .toEqual({ text: 'passed: 2 probes, every write refused, every read worked, as the template marks helm.list on lab (expect-denied)', waits: false });
    expect(probeMarksText({ 'helm.list': 'expect-denied' })).toEqual(['helm.list expect-denied']);
    expect(probeMarksText(undefined)).toEqual([]);
    const probes = [{ id: 'kube.get', expect: 'allowed' }, { id: 'kube.create-namespace', expect: 'denied' }, { id: 'helm.list', expect: 'denied', mark: 'expect-denied' }];
    expect(markableProbes({ check: { probes } }, {})).toEqual(['helm.list', 'kube.get']);
    expect(markableProbes({}, { 'argocd.get': 'skip' })).toEqual(['argocd.get']);
  });
  it('links the report of the current version\'s check (issue #715)', () => {
    expect(checkText({ readOnly: true, savedAt: at, check: { version: at, state: 'passed', probes: [probe('kube.get', true, 'allowed')], artifact: 'a-1' } }))
      .toEqual({ text: 'passed: 1 probes, every write refused, every read worked', waits: false, report: '#artifacts/a-1' });
    expect(checkText({ readOnly: true, savedAt: at, check: { version: 'older', state: 'passed', probes: [], artifact: 'a-1' } })?.report).toBeUndefined();
  });
});

describe('an agent\'s ask on a profile (issue #909)', () => {
  const asset = { kind: 'aws-role', name: '123456789012/deploy' } as const;
  const ask = { template: 'deploy', operation: 'apply', asset, asker: 'Grok Bot', at: '2026-10-12T10:10:00.000Z' } as const;
  it('is found for its template and profile only, and says who asked', () => {
    expect(profileAskOf([ask], 'deploy', { operation: 'apply', asset })).toBe('Grok Bot asked to approve this through the API at 2026-10-12T10:10:00.000Z: approve it here to confirm it.');
    expect(profileAskOf([ask], 'other', { operation: 'apply', asset })).toBeUndefined();
    expect(profileAskOf([ask], 'deploy', { operation: 'write', asset })).toBeUndefined();
    expect(profileAskOf(undefined, 'deploy', { operation: 'apply', asset })).toBeUndefined();
  });
});
