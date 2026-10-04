// The ssh command the update mirror fetches with: never prompts, and reads only the user's ssh
// config — a unit with PrivateTmp runs in a user namespace where root-owned files under
// /etc/ssh show as owned by nobody, and ssh refuses them ("Bad owner or permissions").
import { describe, expect, it } from 'vitest';
import { sshCommand } from '../../src/update/git.ts';

describe('sshCommand', () => {
  it('batch mode, with the user config when there is one, else none', () => {
    expect(sshCommand({}, '/home/u', () => true)).toBe("ssh -o BatchMode=yes -F '/home/u/.ssh/config'");
    expect(sshCommand({}, '/home/u', () => false)).toBe('ssh -o BatchMode=yes -F /dev/null');
  });

  it('a GIT_SSH_COMMAND already set wins', () => {
    expect(sshCommand({ GIT_SSH_COMMAND: 'ssh -i k' }, '/home/u', () => true)).toBe('ssh -i k');
  });

  it("quotes a home with a quote or space in it", () => {
    expect(sshCommand({}, "/home/a b'c", () => true)).toBe("ssh -o BatchMode=yes -F '/home/a b'\\''c/.ssh/config'");
  });
});
