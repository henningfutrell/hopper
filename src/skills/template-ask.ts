// What a job's template request asks for beside its needs (issue #1875, design.md "A template request with secrets, an
// image and egress hosts"): vault secrets by name, one of the hopper's own box images by its short name, and egress hosts
// (`host:port`). A job names an image only from the hopper's list (`REQUEST_IMAGES`), never a reference of its own. Any
// of them makes the request's name its own (the needs alone name it as before), and a request that names a secret or an
// egress host is approved only by a person: no policy or toggle approves it.
// Issue #2146: a request may also name box tools beyond the ones its needs use (`--tools "jq promtool logcli"`): the
// hopper's own pinned software, so a policy approves them as it approves the tools of the needs. Part 3: a request may
// name bastion targets (`--targets "utility/monitoring/svc/grafana:80"`), each a target a bastion of the template may forward
// to; the template request checks that an observe of its needs reaches each.
import { BOX_IMAGE, TEST_IMAGE } from '../sandbox/box-image.ts';
import { toolSet, toolsProblem } from '../domain/sandboxes.ts';
import { egressHostProblem, isSystemSecret, VAULT_SECRET_NAME } from '../domain/vault.ts';
import { parseTargets, targetText, TEMPLATE_TARGETS_MAX } from '../sandbox/bastion.ts';

/** The images a request may name, by their short name (issue #1875); the default is the user's box image. */
export const REQUEST_IMAGES: Readonly<Record<string, string>> = { box: `${BOX_IMAGE}:box-claude`, test: TEST_IMAGE };

/** The most vault secrets, and the most egress hosts, one request names. */
export const ASK_EXTRAS_MAX = 8;

/** A template request as the job sent it: each field as text, needs split by spaces, commas or lines; the others too. */
export interface TemplateAsk { needs?: string; secrets?: string; egress?: string; image?: string; tools?: string; targets?: string }

/**
 * What a request asks beside its needs, read: each list sorted, each item once; `image` absent when it names none;
 * `tools` (issue #2146) absent when it names none, else in the catalog's order; `targets` (part 3) absent when it names none.
 */
export interface AskExtras { secrets: string[]; egress: string[]; image?: string; tools?: string[]; targets?: string[] }

/** The request's fields from a skill request's body (`needs`, `secrets`, `egress`, `image`, `tools`, `targets`). */
export function askOf(field: (name: string) => string | undefined): TemplateAsk {
  const ask: TemplateAsk = {};
  for (const k of ['needs', 'secrets', 'egress', 'image', 'tools', 'targets'] as const) {
    const v = field(k);
    if (v !== undefined) ask[k] = v;
  }
  return ask;
}

const listOf = (said: string | undefined): string[] => [...new Set((said ?? '').split(/[\s,]+/).filter((x) => x !== ''))].sort();

/** The extras the request names; or why they cannot be read. */
export function extrasOf(ask: TemplateAsk): AskExtras | string {
  const secrets = listOf(ask.secrets);
  const egress = listOf(ask.egress?.toLowerCase());
  if (secrets.length > ASK_EXTRAS_MAX || egress.length > ASK_EXTRAS_MAX) return `one request names at most ${ASK_EXTRAS_MAX} vault secrets and ${ASK_EXTRAS_MAX} egress hosts`;
  const bad = secrets.find((s) => !VAULT_SECRET_NAME.test(s) || isSystemSecret(s));
  if (bad !== undefined) return `${JSON.stringify(bad)} is no vault secret's name: name each secret as the vault lists it, --secrets "NAME NAME"`;
  const host = egress.map(egressHostProblem).find((p) => p !== undefined);
  if (host) return `${host}: --egress "host:port host:port"`;
  const image = ask.image?.trim();
  if (image !== undefined && image !== '' && !(image in REQUEST_IMAGES)) {
    return `--image names one of the hopper's box images: ${Object.keys(REQUEST_IMAGES).join(', ')}. A job never names an image reference of its own`;
  }
  const named = listOf(ask.tools?.toLowerCase());
  const unknown = toolsProblem(named);
  if (unknown) return `${unknown}: --tools "jq promtool"`;
  const tools = toolSet(named);
  const words = listOf(ask.targets);
  if (words.length > TEMPLATE_TARGETS_MAX) return `one request names at most ${TEMPLATE_TARGETS_MAX} bastion targets`;
  const targets: string[] = [];
  for (const w of words) {
    const t = parseTargets(w);
    if (typeof t === 'string') return `--targets: ${t}`;
    targets.push(...t.map(targetText));
  }
  return { secrets, egress, ...(image ? { image } : {}), ...(tools.length ? { tools } : {}), ...(targets.length ? { targets: [...new Set(targets)].sort() } : {}) };
}

/** Whether the request asks for anything beside its needs. */
export const hasExtras = (x: AskExtras): boolean => x.secrets.length > 0 || x.egress.length > 0 || x.image !== undefined || (x.tools?.length ?? 0) > 0 || (x.targets?.length ?? 0) > 0;

/** Whether the request asks for something only a person approves: a vault secret or an egress host. */
export const forPerson = (x: AskExtras): boolean => x.secrets.length > 0 || x.egress.length > 0;

/** The lines the extras add to what names the template; none when there are none, so the needs alone name it as before. */
export const extrasKey = (x: AskExtras): string[] => [
  ...x.secrets.map((s) => `secret:${s}`), ...x.egress.map((h) => `egress:${h}`), ...(x.image ? [`image:${x.image}`] : []),
  ...(x.tools ?? []).map((t) => `tool:${t}`), ...(x.targets ?? []).map((t) => `target:${t}`),
];

const sameList = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort(), y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Whether a template gives what the request asks beside its needs, and no more: the same vault secrets, the same egress
 * hosts, and the image asked for (`image` the reference the request resolves to); and each tool it names (issue #2146).
 * A tool gives a box no access, so a template with more tools still gives no more. The same bastion targets (part 3).
 */
export const sameExtras = (t: { secrets: readonly string[]; egress?: readonly string[]; bastionTargets?: readonly string[]; image: string; tools?: readonly string[] }, x: AskExtras, image: string): boolean =>
  sameList(t.secrets, x.secrets) && sameList(t.egress ?? [], x.egress) && sameList(t.bastionTargets ?? [], x.targets ?? []) && t.image === image && (x.tools ?? []).every((tool) => t.tools?.includes(tool as never) === true);

/** The extras in words, for the answer: empty when there are none. */
export const extrasInWords = (x: AskExtras): string[] => [
  ...x.secrets.map((s) => `vault secret ${s}`), ...x.egress.map((h) => `egress to ${h}`), ...(x.image ? [`image ${x.image}`] : []),
  ...(x.tools ?? []).map((t) => `tool ${t}`), ...(x.targets ?? []).map((t) => `bastion target ${t}`),
];
