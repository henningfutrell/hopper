// Issue #870 part 4: no plan and no apply slides under the radar. The Grok Bot routine posts each plan a job records,
// each approval (a person's, or the hopper's with auto-approve on), and each apply (a credential the vault minted for a
// plan, not its renewal), with what the plan changes, its risk and the watchers of its environments. A loopback receiver.
//
// Feature: every plan and apply is sent, to the watchers of its environments
//   Scenario: a plan recorded, approved and applied: three posts, each naming the plan's watchers
//   Scenario: a renewal of an apply's credential, and a credential minted for no plan (a read), are not sent
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import type { InfraPlanNotice } from '../../src/domain/infra-watchers.ts';
import { createGrokBotNotifier } from '../../src/plugins/notifier/grokbot-routine/notifier.ts';
import { waitFor } from '../support/wait.ts';

let server: Server | undefined;
afterEach(async () => {
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
});

async function receiver(): Promise<{ url: string; hits: Record<string, unknown>[] }> {
  const hits: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { hits.push(JSON.parse(raw) as Record<string, unknown>); res.end(); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits };
}

const PLAN = '11111111-2222-4333-8444-555555555555';
const ASSET = { kind: 'aws-role', name: '123456789012/deploy' };
const NOTICE: InfraPlanNotice = {
  plan: PLAN, tool: 'terraform', asset: { kind: 'aws-role', name: '123456789012/deploy' }, target: 'prod-network', repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40),
  pullRequest: 4, words: 'Destroys 1 security group in prod', level: 'high', risks: ['destroy', 'prod', 'network'], environments: ['prod'],
  blastRadius: '1 resource of 1 kind, in prod; applied as aws-role 123456789012/deploy to prod-network', failed: false,
  approver: { who: 'admin', why: 'high risk: destroys, prod' }, watchers: ['ops-lead', 'prod-owner'],
};
let seq = 0;
const event = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent =>
  ({ seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-12T10:00:00.000Z', jobId: 'j1', data });
const minted = (extra: Record<string, unknown>) => event('vault.minted', {
  kind: 'aws', operation: 'apply', asset: ASSET, template: 'deploy', machine: 'box-1', job: 'j1', credential: 'AWS_LAB', decision: 'd1',
  expiresAt: '2026-10-12T10:15:00.000Z', renewal: false, ...extra,
});

async function start(): Promise<{ hits: Record<string, unknown>[]; send: (e: DomainEvent) => void; stop: () => Promise<void> }> {
  const r = await receiver();
  const listeners: ((e: DomainEvent) => void)[] = [];
  const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
  n.start({
    subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '',
    infraUrl: () => 'http://hopper.lan:4790/#infra', infraPlan: (id) => (id === PLAN ? NOTICE : undefined),
  });
  return { hits: r.hits, send: (e) => { for (const l of listeners) l(e); }, stop: () => n.stop() };
}

describe('Grok Bot routine: infra plans and applies', () => {
  it('posts each plan recorded, approved and applied, each naming the watchers of its environments', async () => {
    const { hits, send, stop } = await start();
    send(event('infra.plan_recorded', {
      plan: PLAN, tool: 'terraform', asset: ASSET, target: 'prod-network', repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40), file: true,
      expiresAt: '2026-10-12T11:00:00.000Z', summary: { words: NOTICE.words, level: 'high', risks: NOTICE.risks, failed: false },
    }));
    send(event('infra.plan_approved', { plan: PLAN, tool: 'terraform', asset: ASSET, target: 'prod-network', by: 'Ada', level: 'high' }));
    send(minted({ plan: PLAN }));
    await waitFor(() => hits.length === 3, { what: 'three posts' });
    await stop();
    const plan = {
      source: 'hopper', jobId: 'j1', plan: PLAN, tool: 'terraform', asset: ASSET, target: 'prod-network', repo: 'octo/infra', ref: 'issue-1', commit: 'a'.repeat(40),
      pullRequest: 4, words: NOTICE.words, level: 'high', risks: NOTICE.risks, environments: ['prod'], blastRadius: NOTICE.blastRadius, failed: false,
      approver: NOTICE.approver, watchers: ['ops-lead', 'prod-owner'], infraUrl: 'http://hopper.lan:4790/#infra',
    };
    const byKind = Object.fromEntries(hits.map((h) => [h.kind, h]));
    expect(byKind['infra.plan_recorded']).toEqual(expect.objectContaining(plan));
    expect(byKind['infra.plan_approved']).toEqual(expect.objectContaining({ ...plan, approvedBy: 'Ada' }));
    expect(byKind['infra.plan_applied']).toEqual(expect.objectContaining({ ...plan, operation: 'apply', expiresAt: '2026-10-12T10:15:00.000Z' }));
    expect(JSON.stringify(hits)).not.toMatch(/AWS_LAB|box-1/);
  });

  it('sends no renewal of an apply\'s credential, and no credential minted for no plan', async () => {
    const { hits, send, stop } = await start();
    send(minted({ plan: PLAN, renewal: true }));
    send(minted({ operation: 'read' }));
    send(event('infra.plan_approved', { plan: PLAN, tool: 'terraform', asset: ASSET, target: 'prod-network', by: 'the hopper', auto: true }));
    await waitFor(() => hits.length === 1, { what: 'one post' });
    await new Promise((r) => setTimeout(r, 100));
    await stop();
    expect(hits).toEqual([expect.objectContaining({ kind: 'infra.plan_approved', approvedBy: 'the hopper', auto: true })]);
  });
});
