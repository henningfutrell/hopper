// `hopper ledger rebuild` (issue #1067): the work-item ledger replayed from every event and the issue graph, in place of
// the rows there are, for one user.
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.ts';
import { openAdminStore } from './support/files.ts';
import { installFromBefore, testDatabaseUrl } from './support/database.ts';

async function cli(url: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: url }, stdin: () => '', out: (t) => out.push(t), err: (t) => err.push(t) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('hopper ledger rebuild', () => {
  it('replays the user\'s events into the ledger and says how many items it holds', async () => {
    const url = installFromBefore(testDatabaseUrl());
    const s = openAdminStore(url);
    try {
      const job = s.jobs.create({ executor: 'test', payload: {}, goal: 'g' }, 50, { source: 'github', kind: 'github', key: 'https://github.com/o/r/issues/1' });
      s.events.append({ type: 'job.queued', jobId: job.id, data: {} });
      s.events.append({ type: 'job.failed', jobId: job.id, data: { error: 'boom' } });
    } finally { s.close(); }
    const r = await cli(url, ['ledger', 'rebuild']);
    expect(r).toMatchObject({ code: 0, out: '1\n' });
    expect(r.err).toMatch(/failed 1/);
    const after = openAdminStore(url);
    try { expect(after.workItems.counts().failed).toBe(1); } finally { after.close(); }
  });

  it('refuses any other ledger command', async () => {
    expect(await cli(installFromBefore(testDatabaseUrl()), ['ledger', 'drop'])).toMatchObject({ code: 2, err: expect.stringMatching(/hopper ledger rebuild/) });
  });
});
