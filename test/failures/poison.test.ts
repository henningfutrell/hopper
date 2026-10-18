// A poison failure (issue #1961) is one whose own data makes the assessment throw. A store that fails — a lock wait
// past its time under load, a dropped connection — is not: the job stays unassessed for the next sweep, is not handed
// to a person for it, and is not left. Before this, a host whose store failed once on a job left that job for good.
//
// Feature: a store failure is not a poison failure
//   Scenario: the store fails during an assessment
//     Given an assessment that threw a StoreError
//     When the assessor hands the job off as poison
//     Then nothing is written, the job is not left, and the log says the sweep tries again
//   Scenario: the store fails during a poison hand-off
//     Given an assessment that threw on the job's data, and a store that then fails
//     When the assessor hands the job off
//     Then the job is not left: the next sweep assesses it again
import { describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/ports.ts';
import { createPoison } from '../../src/failures/poison.ts';
import { StoreError } from '../../src/store/db.ts';

function poisonWith(tx: () => never) {
  const lines: string[] = [];
  let txs = 0;
  const store = { tx: () => { txs++; return tx(); } } as unknown as UserStore;
  const poison = createPoison({ store, now: () => new Date(), assessedRun: () => false, afterRecord: () => undefined, logger: { warn: (l) => lines.push(l) } });
  return { poison, lines, txs: () => txs };
}

describe('a store failure is not a poison failure (issue #1961)', () => {
  it('a StoreError in the assessment: nothing is handed off, and the job is not left', () => {
    const p = poisonWith(() => { throw new Error('not called'); });
    p.poison.handOff('j1', new StoreError('postgres: canceling statement due to statement timeout (57014)'));
    expect(p.txs()).toBe(0);
    expect(p.poison.skips('j1')).toBe(false);
    expect(p.lines).toEqual(['hopper: the assessment of job j1 failed in the store: postgres: canceling statement due to statement timeout (57014); the sweep tries again']);
  });

  it('a StoreError in the hand-off: the job is not left', () => {
    const p = poisonWith(() => { throw new StoreError('postgres: the connection was lost inside a transaction'); });
    p.poison.handOff('j1', new TypeError("Cannot read properties of undefined (reading 'model')"));
    expect(p.txs()).toBe(1);
    expect(p.poison.skips('j1')).toBe(false);
  });

  it('another error in the hand-off: the job is left, said once', () => {
    const p = poisonWith(() => { throw new TypeError('bad data'); });
    p.poison.handOff('j1', new TypeError("Cannot read properties of undefined (reading 'model')"));
    expect(p.poison.skips('j1')).toBe(true);
    expect(p.lines.filter((l) => l.includes('the assessor leaves it'))).toHaveLength(1);
  });
});
