// Settings → GitHub webhook in the UI (ui/src/model/github-deliveries.ts, issue #1079), pure: the URL to give GitHub or a
// relay, the secret's line (never its value), the relay command, and what came in since the start.
import { describe, expect, it } from 'vitest';
import { deliveriesLine, deliverySecretLine, deliveryUrl, relayCommand } from '../../ui/src/model/github-deliveries.ts';

const AT = '2026-10-14T01:19:25Z';

describe('Settings → GitHub webhook (issue #1079)', () => {
  it('the URL is the page\'s origin and the path', () => {
    expect(deliveryUrl('https://hopper.example.com', '/github/webhook')).toBe('https://hopper.example.com/github/webhook');
    expect(deliveryUrl('http://127.0.0.1:7878/', '/github/webhook')).toBe('http://127.0.0.1:7878/github/webhook');
  });

  it('the secret: set, its last 4 characters and who; or not set', () => {
    expect(deliverySecretLine({ set: false })).toBe('No secret: the hopper takes no delivery.');
    expect(deliverySecretLine({ set: true, last4: 'beef', setBy: 'Ada', setAt: AT })).toMatch(/^Set — ends in beef — .* by Ada · sealed$/);
  });

  it('the relay command names the repository, the event, the URL and where the secret goes', () => {
    expect(relayCommand('http://127.0.0.1:7878/github/webhook'))
      .toBe('gh webhook forward --repo=OWNER/NAME --events=issues --url=http://127.0.0.1:7878/github/webhook --secret=SECRET');
  });

  it('what came in: none yet, or the counts and the last one', () => {
    expect(deliveriesLine({ received: 0, refused: 0, ignored: 0 })).toBe('No delivery since the hopper started.');
    expect(deliveriesLine({ received: 3, refused: 1, ignored: 2, last: { at: AT, delivery: 'd', event: 'issues', action: 'labeled', repo: 'octo/hello' } }))
      .toMatch(/^3 taken, 1 refused, 2 not read since the hopper started\. Last: issues labeled on octo\/hello, .+\.$/);
  });
});
