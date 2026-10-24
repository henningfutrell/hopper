// `hopper schedule` (issue #2716, src/cli-operator-schedule.ts): each verb is the UI call it makes, and a bad line is the usage.
import { describe, expect, it } from 'vitest';
import { scheduleCall } from '../src/cli-operator-schedule.ts';

const SAVE = ['save', 'phrase-drill-backup', '--template', 'phrase-drill', '--repo', 'acme/ops', '--input', 'ops/backup', '--script', 'ops/backup/step.sh', '--daily', '02:00', '--timeout', '1800'];
const none = async () => undefined;

describe('hopper schedule (issue #2716)', () => {
  it('save posts the schedule, the timeout in seconds; --input may be left out', async () => {
    const c = scheduleCall(SAVE);
    expect(c).toMatchObject({ role: 'operator', path: '/ui/api/step-schedules' });
    expect(await c.body!(none)).toEqual({ action: 'save', name: 'phrase-drill-backup', template: 'phrase-drill', repo: 'acme/ops', input: 'ops/backup', script: 'ops/backup/step.sh', daily: '02:00', timeoutSeconds: 1800 });
    expect(await scheduleCall(SAVE.filter((_, i) => i !== 6 && i !== 7)).body!(none)).not.toHaveProperty('input');
  });

  it('list and runs read; run, grant, revoke and remove post their action', async () => {
    expect(scheduleCall(['list'])).toMatchObject({ role: 'viewer', path: '/api/step-schedules' });
    expect(scheduleCall(['runs', 'a'])).toMatchObject({ role: 'viewer', path: '/api/step-schedules/a' });
    for (const action of ['run', 'grant', 'revoke', 'remove']) expect(await scheduleCall([action, 'a']).body!(none)).toEqual({ action, name: 'a' });
  });

  it.each([[['save', 'a']], [['run']], [['list', 'a']], [['run', 'a', '--daily', '02:00']], [[...SAVE.slice(0, -1), 'soon']], [['frob', 'a']]])('%j is the usage', (args) => {
    expect(() => scheduleCall(args)).toThrow(/^usage: hopper schedule/);
  });
});
