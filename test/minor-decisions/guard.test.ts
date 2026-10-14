// Never for consequential actions (issue #550): what makes a decider call consequential — the question's risk
// rules (delete, deploy and publish, force-push, spend, credentials, sending a message), changing permissions, and a
// job on a machine the blast-radius gate keeps — so it is never applied, whatever Jev says.
import { describe, expect, it } from 'vitest';
import { consequentialOf } from '../../src/minor-decisions/guard.ts';

describe('consequentialOf', () => {
  it('names each thing that makes it consequential', () => {
    expect(consequentialOf(['Remove the old files?', '1. Delete the branch'])).toEqual(['delete']);
    expect(consequentialOf(['Publish the package?'])).toEqual(['deploy']);
    expect(consequentialOf(['Grant write access to the team?'])).toEqual(['permissions']);
    expect(consequentialOf(['chmod 777 the dir?'])).toEqual(['permissions']);
    expect(consequentialOf(['Pick a name'], { gatedMachine: 'desk' })).toEqual(['gated machine desk']);
  });

  it('nothing for a plain choice', () => {
    expect(consequentialOf(['Which name?', '1. ledger', '2. journal'])).toEqual([]);
  });
});
