// Allowed hosts in the UI (ui/src/model/allowed-hosts.ts, issue #1024), pure: the tailnet line and the typed list.
import { describe, expect, it } from 'vitest';
import { hostsOf, tailnetLine } from '../../ui/src/model/allowed-hosts.ts';

describe('allowed hosts in the UI', () => {
  it('names each tailnet name and address with the port, an IPv6 address in brackets', () => {
    expect(tailnetLine({ hosts: [], lan: [], port: 4790, tailnet: { on: true, names: ['box.example.ts.net', 'fd7a:115c:a1e0::1'] } }))
      .toBe('On a tailnet: the hopper also answers to box.example.ts.net:4790, [fd7a:115c:a1e0::1]:4790.');
    expect(tailnetLine({ hosts: [], lan: [], port: 4790, tailnet: { on: false, names: [] } })).toMatch(/^Not on a tailnet/);
  });

  it('reads a host a line or comma-separated, trimmed, lowercase, each once', () => {
    expect(hostsOf(' Hopper.example.net\n\n192.0.2.4, hopper.example.net ')).toEqual(['hopper.example.net', '192.0.2.4']);
    expect(hostsOf('')).toEqual([]);
  });
});
