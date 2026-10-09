// Issue #567: a login ends on a login signal only — a token obtained, the CLI saying it is logged in, the code
// expired or denied — read from what the run printed after it reported the login. A device-flow script polling
// (`authorization_pending`, `slow_down`, "waiting for authorization", the same code printed again) is no signal,
// nor is Claude saying it still waits.
import { describe, expect, it } from 'vitest';
import { loginSignalIn } from '../../src/logins/signals.ts';

/** A Python MCP auth helper's device flow, as it prints while it polls the token endpoint. */
const PYTHON_POLLING = [
  '● Bash(python auth.py &)',
  '  ⎿  To sign in, open https://auth.example.com/device and enter the code QWER-TYUI',
  '     Waiting for authorization...',
  '     authorization_pending: polling again in 5s',
  '     Waiting for authorization...',
  '     {"error": "authorization_pending", "error_description": "The authorization request is still pending"}',
  '     slow_down: polling every 10s now',
  '     To sign in, open https://auth.example.com/device and enter the code QWER-TYUI',
  '     Waiting for authorization...',
  '● The script still waits on the device login; the code has not been entered yet.',
].join('\n');

describe('loginSignalIn', () => {
  it('reads no signal in a device-flow script that polls, however often it prints', () => {
    expect(loginSignalIn(PYTHON_POLLING)).toBeUndefined();
    expect(loginSignalIn(Array(20).fill(PYTHON_POLLING).join('\n'))).toBeUndefined();
  });

  it('reads no signal when Claude says it still waits, or that it is not logged in', () => {
    for (const line of [
      'The login has not completed yet; still waiting.',
      'Not yet authenticated: the user has not entered the code.',
      'You are not logged into any GitHub hosts. To log in, run: gh auth login',
      "The token isn't obtained yet.",
      '  HOPPER_AUTH_PENDING',
      '  expires_in: 900',
    ]) expect(loginSignalIn(line), line).toBeUndefined();
  });

  it('reads completed on a token obtained, from a script', () => {
    expect(loginSignalIn(`${PYTHON_POLLING}\n     Token obtained; saved to the MCP token cache.`)).toBe('completed');
    expect(loginSignalIn('     Access token received (expires in 3600s).')).toBe('completed');
    expect(loginSignalIn('     Authorization complete.')).toBe('completed');
  });

  it("reads completed on gh's device flow ending", () => {
    const gh = [
      '● Bash(gh auth login --hostname github.com --git-protocol https --web)',
      '  ⎿  ! First copy your one-time code: WDJB-MJHT',
      '     Open this URL to continue in your web browser: https://github.com/login/device',
      '     ✓ Authentication complete.',
      '     - gh config set -h github.com git_protocol https',
      '     ✓ Configured git protocol',
      '     ✓ Logged in as octocat',
    ].join('\n');
    expect(loginSignalIn(gh)).toBe('completed');
    expect(loginSignalIn('  ✓ Logged in to github.com account octocat (keyring)')).toBe('completed');
  });

  it("reads completed on codex's, and on Claude saying the login went through", () => {
    expect(loginSignalIn('Successfully logged in')).toBe('completed');
    expect(loginSignalIn('● gh is now authenticated; pushing the branch.')).toBe('completed');
    expect(loginSignalIn('● The login completed, going on.')).toBe('completed');
  });

  it('reads expired on the code running out, denied on the user refusing', () => {
    expect(loginSignalIn(`${PYTHON_POLLING}\n     {"error": "expired_token"}`)).toBe('expired');
    expect(loginSignalIn('     The device code has expired. Run the command again.')).toBe('expired');
    expect(loginSignalIn('     {"error": "access_denied"}')).toBe('denied');
    expect(loginSignalIn('     Authorization denied by the user.')).toBe('denied');
  });

  it('takes the last signal printed: a code that expired, then a new one obtained, completes', () => {
    expect(loginSignalIn('{"error": "expired_token"}\nStarting again.\nToken obtained.')).toBe('completed');
    expect(loginSignalIn('Token obtained.\nLater: {"error": "expired_token"}')).toBe('expired');
  });
});
