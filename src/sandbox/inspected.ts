// What the hopper reads of a container's inspect answer (issue #708): Podman's (libpod) and Docker's have the same shape
// for these parts.
import type { ContainerInfo } from '../domain/sandboxes.ts';

export interface Inspected {
  Id?: string;
  Name?: string;
  ImageName?: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  State?: { Status?: string };
}

/** The container as the port answers it; `name` without Docker's leading slash. */
export function infoOf(c: Inspected, id: string): ContainerInfo {
  return { id: c.Id ?? id, name: (c.Name ?? '').replace(/^\//, ''), image: c.ImageName ?? c.Config?.Image ?? '', labels: c.Config?.Labels ?? {}, state: c.State?.Status ?? '' };
}
