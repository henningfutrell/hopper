// Issues #1128 part 7, #1248: a machine's job user must hold no credentials. A machine that holds any is not ready: Machines
// says what it holds, by name, and how to set up a dedicated job user; Needs you lists every machine not ready. None, or not
// read, says nothing.
import { describe, expect, it } from 'vitest';
import { infraCredentialsText, jobUserFix, JOB_USER, notReadyLines } from '../../ui/src/model/machines.ts';

describe('infra credentials on Machines', () => {
  const base = { id: 'seat', label: 'seat', maxLanes: 1, online: true, executors: [] };

  it('what its job user holds, and that it takes no new job', () => {
    expect(infraCredentialsText({ ...base, infraCredentials: ['.kube', '$AWS_ACCESS_KEY_ID'] }))
      .toBe('Not ready, takes no new job: its job user holds credentials a job could use: .kube, $AWS_ACCESS_KEY_ID. Its jobs wait for another machine. Run its jobs as a dedicated user that holds none; a job that needs a credential gets it from the vault, through a grant.');
  });

  it('none, or not read: null', () => {
    expect(infraCredentialsText({ ...base, infraCredentials: [] })).toBeNull();
    expect(infraCredentialsText(base)).toBeNull();
  });

  it('the guided fix: the commands that make a dedicated job user, then how the machine moves to it', () => {
    const client = jobUserFix({ ...base, client: {}, infraCredentials: ['.kube'] })!;
    expect(client.commands).toEqual([`sudo useradd --create-home --shell /bin/bash ${JOB_USER}`, `sudo passwd --lock ${JOB_USER}`, `sudo loginctl enable-linger ${JOB_USER}`]);
    expect(client.then).toMatch(/Add machine/);
    expect(client.then).toContain(`sudo -iu ${JOB_USER}`);
    const ssh = jobUserFix({ ...base, ssh: 'me@laptop', infraCredentials: ['.aws'] })!;
    expect(ssh.commands.slice(0, 2)).toEqual(client.commands.slice(0, 2));
    expect(ssh.then).toContain(`${JOB_USER}@laptop`);
    expect(jobUserFix({ ...base, infraCredentials: [] })).toBeNull();
  });

  it('Needs you lists each online machine not ready: credentials, or off-network', () => {
    expect(notReadyLines([
      { ...base, id: 'wsl', label: 'WSL', infraCredentials: ['.kube', '.aws'] },
      { ...base, id: 'far', label: '', addressProblem: 'the hopper cannot be reached from it' },
      { ...base, id: 'gone', online: false, infraCredentials: ['.aws'] },
      { ...base, id: 'ok', infraCredentials: [] },
    ])).toEqual([
      'WSL: not ready — its job user holds .kube, .aws',
      'far: not ready — the hopper cannot be reached from it',
    ]);
  });
});
