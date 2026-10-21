// The drained machines (issue #1511) and the sandbox host (issue #2272), apart from settings.ts for its size: a user's
// key-value settings. Drains by machine id, absent when none was ever drained; the sandbox host absent when never set.
import type { MachineDrains } from '../domain/machines.ts';
import type { SandboxHost } from '../domain/sandbox-host.ts';

export function machineDrainSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getMachineDrains(): MachineDrains;
  setMachineDrains(drains: MachineDrains): void;
  getSandboxHost(): SandboxHost | undefined;
  setSandboxHost(host: SandboxHost): void;
} {
  return {
    getMachineDrains() {
      const text = read('machineDrains');
      return text === undefined ? {} : JSON.parse(text) as MachineDrains;
    },
    setMachineDrains(drains) {
      write('machineDrains', JSON.stringify(Object.fromEntries(Object.entries(drains).sort(([a], [b]) => a.localeCompare(b))
        .map(([id, d]) => [id, { person: d.person, via: d.via, at: d.at }]))));
    },
    getSandboxHost() {
      const text = read('sandboxHost');
      return text === undefined ? undefined : JSON.parse(text) as SandboxHost;
    },
    setSandboxHost(h) {
      write('sandboxHost', JSON.stringify({ hosts: [...h.hosts], person: h.person, via: h.via, at: h.at }));
    },
  };
}
