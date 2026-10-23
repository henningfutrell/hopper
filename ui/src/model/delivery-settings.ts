// Delivery settings in Settings (issue #2554 part 3), pure: the repositories' settings are edited as one JSON object, and
// a save sends each changed or new repository whole and `null` for one taken away. The daemon checks each value.
import type { DeliveryRepo, DeliverySettings } from './wire.ts';

type Patch = { repos: Record<string, DeliveryRepo | null> };

/** The change the text makes to the saved settings: none when it says what is saved, or the problem of a bad text. */
export function deliveryPatch(saved: DeliverySettings, text: string): { patch: Patch | undefined } | { problem: string } {
  let draft: unknown;
  try { draft = JSON.parse(text); } catch (e) { return { problem: `not JSON: ${(e as Error).message}` }; }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { problem: 'a JSON object of repositories (owner/repo)' };
  const repos: Patch['repos'] = {};
  for (const [repo, v] of Object.entries(draft)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { problem: `${repo}: an object with its schedule and gates` };
    if (JSON.stringify(v) !== JSON.stringify(saved.repos[repo])) repos[repo] = v as DeliveryRepo;
  }
  for (const repo of Object.keys(saved.repos)) if (!(repo in draft)) repos[repo] = null;
  return { patch: Object.keys(repos).length > 0 ? { repos } : undefined };
}
