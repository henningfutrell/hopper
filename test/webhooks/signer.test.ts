import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { sign, verify } from '../../src/webhooks/index.ts';

describe('signer', () => {
  it('signs "<timestamp>.<body>" with HMAC-SHA256 as sha256=<hex>', () => {
    const expected = 'sha256=' + createHmac('sha256', 'k').update('123.{"a":1}').digest('hex');
    expect(sign('k', '123', '{"a":1}')).toBe(expected);
  });

  it('verifies a good signature and rejects a wrong secret, body, timestamp or shape', () => {
    const sig = sign('k', '123', 'body');
    expect(verify('k', '123', 'body', sig)).toBe(true);
    expect(verify('other', '123', 'body', sig)).toBe(false);
    expect(verify('k', '123', 'bodY', sig)).toBe(false);
    expect(verify('k', '124', 'body', sig)).toBe(false);
    expect(verify('k', '123', 'body', 'sha256=abc')).toBe(false);
    expect(verify('k', '123', 'body', '')).toBe(false);
  });
});
