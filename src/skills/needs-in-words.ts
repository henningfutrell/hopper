// Needs in words (issue #708, design.md "Needs in words"): a person writes what a box must do in plain words —
// "kubectl get pods in namespace web on cluster lab" — and the hopper reads the needs of a template request from them.
// The reader is a fixed set of words, not a model: the same words always give the same needs, and nothing a person
// writes can talk it into more. It names each asset the words name (a kind word, then the name), and for each asset
// the operations the words say: a read for a read word, apply, sync, or write only where a word says that change, and
// observe for a port-forward (issue #2146). A
// change word just after "not" or "never" says no change. Words it cannot read are refused with what to write; the
// preview shows the needs it read before anything is made, and a change still waits for a person. Pure.
import { ASSET_NAME, OPERATIONS, type AssetKind, type Operation, type OperationProfile } from '../domain/access.ts';

/** The words for each operation; a word's -s, -es, -d, -ed and -ing forms count too. */
const OPERATION_WORDS: Record<Operation, string[]> = {
  read: ['read', 'get', 'list', 'ls', 'describe', 'show', 'view', 'plan', 'log', 'logs', 'inspect', 'check', 'diff', 'status', 'look', 'see',
    'watch', 'top', 'output', 'validate', 'query', 'find', 'browse', 'explain', 'audit', 'report', 'monitor', 'count', 'compare', 'scan', 'review'],
  write: ['write', 'create', 'delete', 'destroy', 'remove', 'rm', 'update', 'change', 'edit', 'patch', 'scale', 'restart', 'install', 'upgrade',
    'uninstall', 'rollback', 'roll', 'put', 'modify', 'push', 'import', 'set', 'rotate', 'terminate', 'stop', 'start', 'drain', 'cordon',
    'uncordon', 'label', 'annotate', 'exec', 'kill', 'reboot', 'migrate', 'provision', 'taint', 'untaint', 'rename', 'move', 'fix', 'add'],
  sync: ['sync'],
  apply: ['apply', 'deploy'],
  // Issue #2146: `port-forward` counts by its part `forward`.
  observe: ['observe', 'portforward', 'forward'],
};
const NOT = new Set(['not', 'never', 'no', 'without', 'nor', "don't", 'dont', 'cannot', "can't", "doesn't", "mustn't"]);
/** The words a kind word names its asset with. */
const KIND_WORDS: Record<string, AssetKind> = { cluster: 'cluster', namespace: 'namespace', workspace: 'terraform-workspace', account: 'aws-account', role: 'aws-role' };
const ARGO = new Set(['argocd', 'argo', 'cd']);
const APP = new Set(['app', 'application']);
/** Words between a kind word and its name. */
const NAMING = new Set(['named', 'called', 'name', 'id', 'is']);
/** Words that are never a name: a kind word with one of these after it names no asset. */
const NO_NAME = new Set(['on', 'in', 'of', 'at', 'the', 'a', 'an', 'and', 'or', 'to', 'for', 'with', 'but', 'that', 'this', 'it', 'its', 'their', 'all', 'every', 'any', 'from', 'by']);

const forms = (w: string): string[] => [w, `${w}s`, `${w}es`, `${w}d`, `${w}ed`, `${w}ing`, ...(w.endsWith('e') ? [`${w.slice(0, -1)}ing`] : [])];
const OPERATION_OF = new Map<string, Operation>(OPERATIONS.flatMap((op) => OPERATION_WORDS[op].flatMap((w) => forms(w).map((f) => [f, op] as const))));

interface Mention { kind: AssetKind; name: string; used?: boolean }

const clean = (token: string): string => token.replace(/^["'`([{<]+|["'`)\]}>.,;:!?]+$/g, '');
const say = (m: Mention): string => `${m.kind === 'terraform-workspace' ? 'workspace' : m.kind === 'aws-account' ? 'account' : m.kind === 'aws-role' ? 'role' : m.kind === 'argocd-app' ? 'Argo CD app' : m.kind} ${m.name}`;

/** The assets the words name, in order; or why one cannot be read. */
function mentionsOf(tokens: string[]): Mention[] | string {
  const found: Mention[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!.toLowerCase();
    const kind = KIND_WORDS[w] ?? (APP.has(w) && tokens.slice(Math.max(0, i - 2), i).some((t) => ARGO.has(t.toLowerCase())) ? 'argocd-app' : undefined);
    if (!kind) continue;
    let j = i + 1;
    while (j < tokens.length && NAMING.has(tokens[j]!.toLowerCase())) j++;
    const name = tokens[j];
    const said = kind === 'argocd-app' ? 'Argo CD app' : w;
    if (name === undefined || NO_NAME.has(name.toLowerCase()) || OPERATION_OF.has(name.toLowerCase())) return `${said}: say its name (${said} NAME)`;
    if (!ASSET_NAME.test(name)) return `${said} ${name}: an asset name is letters, digits and . _ / + = , -`;
    found.push({ kind, name });
    i = j;
  }
  return found;
}

/** A namespace in its cluster, a role in its account: the one the words name, which is then no need of its own. */
function placed(found: Mention[]): Mention[] | string {
  const pairs: [AssetKind, AssetKind, string][] = [['namespace', 'cluster', 'cluster'], ['aws-role', 'aws-account', 'account']];
  for (const [inner, outer, word] of pairs) {
    const outers = found.filter((m) => m.kind === outer);
    for (const m of found.filter((x) => x.kind === inner && !x.name.includes('/'))) {
      if (outers.length !== 1) return `${say(m)}: say its ${word} (${say(m)} in ${word} NAME), or write it as NAME/${m.name}`;
      m.name = `${outers[0]!.name}/${m.name}`;
      outers[0]!.used = true;
    }
  }
  return found.filter((m) => !m.used);
}

/**
 * The operations the words say, in the order of OPERATIONS; each part of a command such as `get-caller-identity` or
 * `describe-instances` counts. A change word just after "not" or "never" says none.
 */
function operationsOf(tokens: string[]): Operation[] {
  const said = new Set<Operation>();
  tokens.forEach((t, i) => {
    const not = tokens.slice(Math.max(0, i - 2), i).some((x) => NOT.has(x.toLowerCase()));
    for (const part of t.toLowerCase().split(/[-_]/)) {
      const op = OPERATION_OF.get(part);
      if (op && !(op !== 'read' && not)) said.add(op);
    }
  });
  return OPERATIONS.filter((op) => said.has(op));
}

/** The needs one line of plain words says, each asset with each operation the words say; or why they cannot be read. */
export function needsFromWords(line: string): OperationProfile[] | string {
  const tokens = line.split(/[\s,;]+/).map(clean).filter((t) => t !== '');
  const found = mentionsOf(tokens);
  if (typeof found === 'string') return found;
  const assets = placed(found);
  if (typeof assets === 'string') return assets;
  if (assets.length === 0) return `"${line}" names no asset: say which (cluster NAME, namespace NAME in cluster NAME, workspace NAME, account ID, role NAME in account ID, Argo CD app NAME)`;
  const ops = operationsOf(tokens);
  if (ops.length === 0) return `say what the box does on ${assets.map(say).join(', ')}: read it (get, list, plan, …) or change it (apply, sync, delete, …)`;
  return assets.flatMap((a) => ops.map((operation) => ({ operation, asset: { kind: a.kind, name: a.name } })));
}
