// What the hopper reads of a container's inspect answer (issue #708): Podman's (libpod) and Docker's have the same shape
// for these parts — its networks, its health check, and that check's runs.
import type { ContainerInfo, StartCheck } from '../domain/sandboxes.ts';

export interface Inspected {
  Id?: string;
  Name?: string;
  ImageName?: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null; Healthcheck?: unknown };
  State?: { Status?: string; Health?: { Status?: string; Log?: { ExitCode?: number; Output?: string }[] | null } };
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> | null };
}

/** The container as the port answers it; `name` without Docker's leading slash. */
export function infoOf(c: Inspected, id: string): ContainerInfo {
  const networks = Object.fromEntries(Object.entries(c.NetworkSettings?.Networks ?? {}).map(([n, v]) => [n, v.Aliases ?? []]));
  return {
    id: c.Id ?? id, name: (c.Name ?? '').replace(/^\//, ''), image: c.ImageName ?? c.Config?.Image ?? '', labels: c.Config?.Labels ?? {}, state: c.State?.Status ?? '',
    ...(Object.keys(networks).length ? { networks } : {}),
  };
}

/** The box's start check as its last run says. Undefined: the box has none (made before the start check). */
export function startCheckOf(c: Inspected | undefined): StartCheck | undefined {
  if (!c) return { passed: false, output: 'the box is gone' };
  if (!c.Config?.Healthcheck) return undefined;
  const state = c.State?.Status ?? 'unknown';
  if (state !== 'running') return { passed: false, output: `the box is ${state}, not running` };
  const last = c.State?.Health?.Log?.at(-1);
  if (!last) return { passed: false, output: 'its first check has not run yet' };
  return { passed: last.ExitCode === 0, output: (last.Output ?? '').trim() };
}
