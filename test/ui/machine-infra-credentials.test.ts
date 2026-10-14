// Issue #1128 part 7: a machine must hold no infra credentials. Machines and Accounts flag the infra credential folders a
// machine's home holds, by name; none, or not read, flags nothing.
import { describe, expect, it } from 'vitest';
import { infraCredentialsText } from '../../ui/src/model/machines.ts';

describe('infra credentials on Machines', () => {
  const base = { id: 'seat', label: 'seat', maxLanes: 1, online: true, executors: [] };

  it('the folders its home holds, and what to do', () => {
    expect(infraCredentialsText({ ...base, infraCredentials: ['.aws', '.terraform.d'] }))
      .toBe('.aws, .terraform.d in its home: a machine must hold no infra credentials. Remove them on the machine.');
  });

  it('none, or not read: null', () => {
    expect(infraCredentialsText({ ...base, infraCredentials: [] })).toBeNull();
    expect(infraCredentialsText(base)).toBeNull();
  });
});
