// The user's Windows hosts (issue #731): the config record `windows-hosts`, read and replaced whole against its
// version, from the UI (POST /ui/api/windows-hosts) or with `hopper config set`. Read at each step, so an edit reaches
// the next step without a restart.
import type { ConfigRecords } from '../domain/ports.ts';
import { WINDOWS_HOSTS, windowsHostsOf, windowsHostsProblem, type WindowsHost, type WindowsHostsView } from '../domain/windows-steps.ts';

/** The hosts now; none while the record is missing. */
export const readWindowsHosts = (config: ConfigRecords): WindowsHost[] => windowsHostsOf(config.read(WINDOWS_HOSTS));

export function windowsHostsView(config: ConfigRecords): WindowsHostsView {
  return { hosts: readWindowsHosts(config), version: config.version(WINDOWS_HOSTS) };
}

export type WindowsHostsWrite = { ok: true; view: WindowsHostsView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the hosts with `hosts` if the record is still at `version`. A label left empty, or no secrets, is dropped. */
export function writeWindowsHosts(config: ConfigRecords, hosts: WindowsHost[], version: string): WindowsHostsWrite {
  const value = { hosts: hosts.map(({ label, secrets, ...h }) => ({ ...h, ...(label?.trim() ? { label: label.trim() } : {}), ...(secrets?.length ? { secrets } : {}) })) };
  const problem = windowsHostsProblem(value);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (!config.write(WINDOWS_HOSTS, value, version)) return { ok: false, code: 'conflict', error: 'the Windows hosts changed since they were read; reload and edit again' };
  return { ok: true, view: windowsHostsView(config) };
}
