// The container tool whose update commands show (issue #521), remembered per browser like the theme.
// Storage blocked: the choice holds for this tab only.
import { useSyncExternalStore } from 'react';
import { parseContainerTool, type ContainerTool } from '@/model/update';

const KEY = 'jh_container_tool';
const listeners = new Set<() => void>();

const stored = (): ContainerTool => { try { return parseContainerTool(localStorage.getItem(KEY)); } catch { return 'Podman'; } };
let tool: ContainerTool = stored();

function publish(next: ContainerTool) {
  tool = next;
  for (const l of listeners) l();
}

export function setContainerTool(next: ContainerTool) {
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked: this tab only */ }
  publish(next);
}

/** Reads the stored choice again (tests: another tab or a cleared browser). */
export const reloadContainerTool = () => publish(stored());

export const useContainerTool = (): ContainerTool => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => tool);
