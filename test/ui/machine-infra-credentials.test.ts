// Issues #1128 part 7, #1248, #1467: a machine whose job user holds credentials takes jobs with a warning. Machines says
// what it holds, by name, and how to set up a dedicated job user. A card shows one state, from the daemon's `credentialHeld`
// (the decider's own rule): held, taking jobs with a warning, or acknowledged. Needs you lists each held machine and each
// warning no admin acknowledged. None, or not read, says nothing.
import { describe, expect, it } from 'vitest';
import { credentialCard, HELD_HEADLINE, infraCredentialsText, jobUserFix, JOB_USER, notReadyLines, TAKING_HEADLINE } from '../../ui/src/model/machines.ts';

const base = { id: 'seat', label: 'seat', maxLanes: 1, online: true, executors: [] };
const creds = { ...base, infraCredentials: ['.kube', '$AWS_ACCESS_KEY_ID'] };
const at = '2026-10-16T00:00:00.000Z';
/** Text no card that takes jobs may say. */
const CONTRADICTS = /not ready|takes no new job|wait for another machine|not taking jobs/i;

describe('infra credentials on Machines', () => {
  it('what its job user holds, as a warning', () => {
    expect(infraCredentialsText(creds)).toBe('Its job user holds credentials a job could use: .kube, $AWS_ACCESS_KEY_ID.');
  });

  it('none, or not read: null', () => {
    expect(infraCredentialsText({ ...base, infraCredentials: [] })).toBeNull();
    expect(infraCredentialsText(base)).toBeNull();
    expect(credentialCard(base)).toBeNull();
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
});

describe('the credential card: one state', () => {
  it('by default: taking jobs, with the warning, the fix folded', () => {
    const card = credentialCard(creds)!;
    expect(card).toMatchObject({ state: 'warning', headline: TAKING_HEADLINE, fixOpen: false, added: [] });
    expect(`${card.badge} ${card.headline} ${card.detail}`).not.toMatch(CONTRADICTS);
  });

  it('acknowledged: taking jobs, the warning folded', () => {
    const card = credentialCard({ ...creds, credentialAcceptance: { credentials: creds.infraCredentials, acceptedAt: at } })!;
    expect(card).toMatchObject({ state: 'acknowledged', headline: TAKING_HEADLINE, fixOpen: false });
    expect(`${card.badge} ${card.headline} ${card.detail}`).not.toMatch(CONTRADICTS);
  });

  it('a credential found after the acknowledgement raises the warning again, and names it', () => {
    const card = credentialCard({ ...creds, credentialAcceptance: { credentials: ['.kube'], acceptedAt: at } })!;
    expect(card).toMatchObject({ state: 'warning', headline: TAKING_HEADLINE, added: ['$AWS_ACCESS_KEY_ID'] });
  });

  it('held in strict mode: not taking jobs, why, and the fix open', () => {
    const card = credentialCard({ ...creds, credentialHeld: true })!;
    expect(card).toMatchObject({ state: 'held', headline: HELD_HEADLINE, badge: 'not taking jobs', fixOpen: true });
    expect(card.detail).toMatch(/^Strict mode is on/);
    expect(card.detail).toContain('Its jobs wait for another machine.');
    expect(card.detail).not.toMatch(/accepted|takes jobs despite/i);
  });

  it('held by an admin\'s stop: says so', () => {
    const card = credentialCard({ ...creds, credentialHeld: true, credentialAcceptance: { credentials: [], acceptedAt: at, revokedAt: at } })!;
    expect(card).toMatchObject({ state: 'held', headline: HELD_HEADLINE });
    expect(card.detail).toMatch(/^An admin stopped it/);
  });
});

describe('Needs you', () => {
  it('lists each held machine, each warning no admin acknowledged, and each off-network machine', () => {
    expect(notReadyLines([
      { ...base, id: 'wsl', label: 'WSL', infraCredentials: ['.kube', '.aws'], credentialHeld: true },
      { ...base, id: 'laptop', label: 'Laptop', infraCredentials: ['.kube'] },
      { ...base, id: 'seen', infraCredentials: ['.kube'], credentialAcceptance: { credentials: ['.kube'], acceptedAt: at } },
      { ...base, id: 'far', label: '', addressProblem: 'the hopper cannot be reached from it' },
      { ...base, id: 'gone', online: false, infraCredentials: ['.aws'] },
      { ...base, id: 'ok', infraCredentials: [] },
    ])).toEqual([
      'WSL: not taking jobs — its job user holds .kube, .aws',
      'Laptop: takes jobs, but its job user holds .kube',
      'far: not ready — the hopper cannot be reached from it',
    ]);
  });
});
