// The sagas another live host drives (issue #1954, design.md "The crash harness" part 7): a host's sweeps leave the
// work of a saga whose lease another owner holds, on the database's clock. A lease that ended, or the host's own, is not
// another's; an ended saga is held by nobody.
import { afterEach, describe, expect, it } from 'vitest';
import { newSaga } from '../../src/domain/sagas.ts';
import { openInstanceStore, type InstanceStore } from '../../src/store/index.ts';
import { endLeases } from '../crash/harness.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const temp = useTempStore();
const opened: InstanceStore[] = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); });

describe('the sagas another host holds (issue #1954)', () => {
  it('names the open sagas of a kind whose lease another owner holds now; not the own, not an ended lease, not an ended saga', () => {
    const url = temp.url(), clock = fixedClock();
    const store = openInstanceStore({ url, clock });
    opened.push(store);
    const at = clock.now().toISOString();
    const begin = (id: string, kind: string, key: string) => store.sagas.begin(newSaga({ id, kind, key, steps: ['run'], data: {}, at }));
    begin('s1', 'need-step', 'step-1');
    begin('s2', 'need-step', 'step-2');
    begin('s3', 'git-push', 'push-1');
    begin('s4', 'need-step', 'step-4');
    expect(store.sagas.claim('s1', { owner: 'host-a', ms: 60_000 })).toBeDefined();
    expect(store.sagas.claim('s2', { owner: 'host-b', ms: 60_000 })).toBeDefined();
    expect(store.sagas.claim('s3', { owner: 'host-a', ms: 60_000 })).toBeDefined();
    expect(store.sagas.heldByOthers('need-step', 'host-b')).toEqual(['step-1']);
    expect(store.sagas.heldByOthers('need-step', 'host-a')).toEqual(['step-2']);
    expect(store.sagas.heldByOthers('need-step', 'host-c').sort()).toEqual(['step-1', 'step-2']);

    // host-b's saga ends: its lease goes with it.
    const s2 = store.sagas.get('s2')!;
    expect(store.sagas.save({ ...s2, state: 'done', endedAt: at }, 'host-b')).toBe(true);
    expect(store.sagas.heldByOthers('need-step', 'host-c')).toEqual(['step-1']);

    // host-a stops renewing: once its lease ended, nobody holds step-1.
    endLeases(url);
    expect(store.sagas.heldByOthers('need-step', 'host-c')).toEqual([]);
  });
});
