// Issue #308: a machine joins a hopper with one copied line, and from then on dials in. The client and
// the hopper each hold an X25519 key; the client token is what both derive from their own private half
// and the other's public half, so neither side stores a shared secret and the token never crosses the
// wire (design.md "Joining a machine").
import { describe, expect, it } from 'vitest';
import { checkToken } from '../../src/client/signature.ts';
import { linkToken, mintLinkKey, parseJoinLine, publicKeyOf } from '../../src/client/link.ts';

describe('a link key', () => {
  it('is X25519: a PKCS#8 private half and a 43-character base64url public half', () => {
    const k = mintLinkKey();
    expect(k.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(publicKeyOf(k.privateKey)).toBe(k.publicKey);
    expect(mintLinkKey().publicKey).not.toBe(k.publicKey);
  });
});

describe('the client token', () => {
  const hopper = mintLinkKey();
  const machine = mintLinkKey();

  it('is the same on both ends: each derives it from its own private half and the other\'s public half', () => {
    const atHopper = linkToken(hopper.privateKey, machine.publicKey);
    expect(linkToken(machine.privateKey, hopper.publicKey)).toBe(atHopper);
    expect(checkToken(atHopper)).toBe(atHopper);
  });

  it('is another for another machine, and never either public half', () => {
    const other = mintLinkKey();
    const token = linkToken(hopper.privateKey, machine.publicKey);
    expect(linkToken(hopper.privateKey, other.publicKey)).not.toBe(token);
    expect(token).not.toBe(machine.publicKey);
    expect(token).not.toBe(hopper.publicKey);
  });

  it('a public half that is not a key: refused', () => {
    expect(() => linkToken(hopper.privateKey, 'not-a-key')).toThrow(/not a link key/);
  });
});

describe('the join line', () => {
  const code = 'a'.repeat(64);

  it('is the hopper\'s URL and the join code after #', () => {
    expect(parseJoinLine(`http://hopper:4790#${code}`)).toEqual({ url: 'http://hopper:4790', code });
    expect(parseJoinLine(`https://hopper.example.com/#${code}`)).toEqual({ url: 'https://hopper.example.com', code });
  });

  it('anything else is refused, with what it must be', () => {
    for (const bad of ['http://hopper:4790', `ftp://hopper#${code}`, `http://hopper:4790#short`, `hopper:4790#${code}`]) {
      expect(() => parseJoinLine(bad)).toThrow(/<hopper URL>#<join code>/);
    }
  });
});
