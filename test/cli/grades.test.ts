// `hopper grades [--by <group>] [--repo <owner/repo>] [--since <date>]`, `hopper grades --job <id>` and
// `hopper grades set <job> <1-5> [--note <text>]` (issue #2845): the calls the operator CLI makes, before any daemon. They
// read GET /api/grades and GET /api/jobs/:id/grade, and give a user grade through POST /ui/api/jobs/:id/grade, as the UI does.
import { describe, expect, it } from 'vitest';
import { gradesCall } from '../../src/cli-operator-grades.ts';

describe('hopper grades (issue #2845)', () => {
  it('reads the rollup by executor, or with the group and filters it is given', () => {
    expect(gradesCall([])).toEqual({ role: 'viewer', path: '/api/grades' });
    expect(gradesCall(['--by', 'model', '--repo', 'octo/shed', '--since', '2026-10-01']))
      .toEqual({ role: 'viewer', path: '/api/grades?by=model&repo=octo%2Fshed&since=2026-10-01' });
  });

  it('reads one job\'s grades', () => {
    expect(gradesCall(['--job', 'j1'])).toEqual({ role: 'viewer', path: '/api/jobs/j1/grade' });
  });

  it('gives a user grade with a note', async () => {
    const set = gradesCall(['set', 'j1', '4', '--note', 'good work']);
    expect(set).toMatchObject({ role: 'operator', path: '/ui/api/jobs/j1/grade' });
    expect(await set.body!(async () => undefined)).toEqual({ score: 4, note: 'good work' });
    expect(await gradesCall(['set', 'j1', '1']).body!(async () => undefined)).toEqual({ score: 1 });
  });

  it('refuses a bad score, a stray word and a job with other filters, before any call', () => {
    expect(() => gradesCall(['set', 'j1', '6'])).toThrow(/usage: hopper grades/);
    expect(() => gradesCall(['set', 'j1'])).toThrow(/usage: hopper grades/);
    expect(() => gradesCall(['more'])).toThrow(/usage: hopper grades/);
    expect(() => gradesCall(['--job', 'j1', '--by', 'model'])).toThrow(/usage: hopper grades/);
    expect(() => gradesCall(['set', 'j1', '3', '--by', 'model'])).toThrow(/usage: hopper grades/);
  });
});
