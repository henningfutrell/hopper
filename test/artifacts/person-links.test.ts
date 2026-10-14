// Issue #712: a person's link — a notification's question link, a UI link, an artifact's — opens on the computer that
// runs the hopper. On a hopper in a container, the first LAN name is the container's bare name (`hopper`), which only the
// container network resolves: a person's link never names it. The host link base, an instance setting, is the address
// people open; its default is `http://localhost:<port>`. Pure.
import { describe, expect, it } from 'vitest';
import { personBase } from '../../src/artifacts/links.ts';

const reach = { linkBase: '', hostLinkBase: '', lanNames: [] as string[], port: 4790 };

describe('the base of a person\'s link (issue #712)', () => {
  it('is http://localhost:<port> when nothing else is set', () => {
    expect(personBase(reach)).toBe('http://localhost:4790');
  });

  it('never names a bare LAN name such as a container\'s', () => {
    expect(personBase({ ...reach, lanNames: ['hopper', 'host.containers.internal'] })).toBe('http://localhost:4790');
  });

  it('names a LAN name a LAN client resolves (an IP or a .local name), as before (issue #673)', () => {
    expect(personBase({ ...reach, lanNames: ['hopper', 'box.local', '192.0.2.29'] })).toBe('http://box.local:4790');
  });

  it('takes the host link base over a LAN name', () => {
    expect(personBase({ ...reach, hostLinkBase: 'http://127.0.0.1:4790', lanNames: ['box.local'] })).toBe('http://127.0.0.1:4790');
  });

  it('takes the public URL\'s origin over the host link base', () => {
    expect(personBase({ ...reach, hostLinkBase: 'http://127.0.0.1:4790', publicUrl: 'https://hopper.example/ui' })).toBe('https://hopper.example');
  });

  it('takes the user\'s link base over everything', () => {
    expect(personBase({ ...reach, linkBase: 'http://192.0.2.29:4790', hostLinkBase: 'http://127.0.0.1:4790', publicUrl: 'https://hopper.example' })).toBe('http://192.0.2.29:4790');
  });
});
