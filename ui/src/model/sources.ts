// The Sources view's GitHub section (issues #160, #214, #254, #359, #1377): the GitHub sign-in is the one way the hopper
// reads and writes GitHub, through the hopper's app, and the connected account's source (`github-account`) is that
// connection's sync — the panel shows it, never a card beside it. The summary line says what the sign-in does now, from
// the sign-in itself and its job repositories, never from whether a source status exists: signed in with no repositories,
// it asks to choose them; signed in with an expired token, to sign in again; signed in while the source cannot run, why.
// A further GitHub account (issue #1448) has a source of its own, which names its account (`detail.accountKey`): shown in
// that account's panel, never as a card. The GitLab account's source (issue #1448 part 2) is shown in the GitLab panel. Pure;
// the view renders it.
import type { ConnectedAccountStatus, SourceStatus } from './wire.ts';

export interface SourcesView {
  /** The connected account's source (`github-account`), shown in the GitHub connection panel. */
  account?: SourceStatus;
  /** Each further account's source (issue #1448), by the account's key, shown in its panel. */
  further: Record<string, SourceStatus>;
  /** GitHub is connected and its source reads issues. */
  connected: boolean;
  /** The other connected-account sources (issue #1264): each a card of its own, marked as the duplicate it is. */
  github: SourceStatus[];
  summary: string;
  /** The GitLab account's source (issue #1448 part 2), shown in the GitLab panel. */
  gitlab?: SourceStatus;
  others: SourceStatus[];
  /** The sources that take the same work as an earlier one (issue #1264), each to remove. */
  duplicates: SourceStatus[];
}

const ACCOUNT = 'github-account';
const GITLAB = 'gitlab-account';

const isConnected = (s: SourceStatus | undefined) => s !== undefined && typeof s.detail.paused !== 'string' && s.state !== 'disabled' && s.state !== 'error';

/** Why the connection's source reads no issue, from its status: switched off, cannot run, or paused. Undefined: it reads. */
function sourceTrouble(account: SourceStatus | undefined): string | undefined {
  if (!account) return 'its job source is not in the plugins config: add a github-account job source in Plugins';
  if (account.state === 'error' && account.lastError) return `its job source cannot run: ${account.lastError}`;
  if (typeof account.detail.paused === 'string') return undefined;
  if (account.state === 'disabled') return 'its job source is switched off in Plugins';
  return undefined;
}

/** The summary line, from the GitHub sign-in (`signIn`, undefined until read) and the connection's source. */
function summary(account: SourceStatus | undefined, connected: boolean, signIn: ConnectedAccountStatus | undefined): string {
  if (signIn?.state === 'expired') return 'Your GitHub sign-in expired. Sign in with GitHub again to read issues and work through it.';
  if (signIn?.state === 'unreadable') return `The hopper cannot open the GitHub connection's token: ${signIn.error}.`;
  if (signIn?.state === 'waiting') return 'Waiting for the GitHub sign-in to finish: enter the code shown below at GitHub.';
  if (signIn?.state === 'connected') {
    const who = `Signed in with GitHub as ${signIn.account}`;
    const trouble = sourceTrouble(account);
    if (trouble) return `${who}, but ${trouble}.`;
    if (signIn.jobRepositories.length === 0) return `${who}. Choose the repositories for jobs below: until then no issue is read.`;
    if (connected) return `Issues are read, and jobs work, through your GitHub connection, ${signIn.account}.`;
    return typeof account?.detail.paused === 'string' ? `${who}. No issue is read now: ${account.detail.paused}.` : `${who}.`;
  }
  if (signIn?.state === 'not-connected' || signIn?.state === 'failed') {
    return `Sign in with GitHub, or connect GitHub below, to read issues and work through it.${signIn.state === 'failed' ? ` The last try failed: ${signIn.error}.` : ''}`;
  }
  if (connected) {
    const who = typeof account!.detail.login === 'string' ? `, ${account!.detail.login}` : '';
    return `Issues are read, and jobs work, through your GitHub connection${who}.`;
  }
  if (account?.state === 'error' && account.lastError) return `The GitHub job source cannot run: ${account.lastError}.`;
  if (account) return typeof account.detail.paused === 'string' ? `No issue is read through your GitHub connection: ${account.detail.paused}.` : 'No issue is read through your GitHub connection.';
  return 'Reading the GitHub connection.';
}

/** The key of the further account a source reads (issue #1448); undefined: the first account's. */
const accountKeyOf = (s: SourceStatus): string | undefined => (typeof s.detail.accountKey === 'string' ? s.detail.accountKey : undefined);

export function sourcesView(sources: SourceStatus[], signIn?: ConnectedAccountStatus): SourcesView {
  const firsts = sources.filter((s) => s.kind === ACCOUNT && accountKeyOf(s) === undefined);
  // A second connected-account source (issue #1264) is a card of its own, marked as the duplicate it is.
  const account = firsts.find((s) => !s.duplicateOf) ?? firsts[0];
  const connected = isConnected(account);
  const gitlab = sources.find((s) => s.kind === GITLAB);
  const further = Object.fromEntries(sources.flatMap((s) => { const k = accountKeyOf(s); return s.kind === ACCOUNT && k !== undefined ? [[k, s]] : []; }));
  return {
    ...(account ? { account } : {}), ...(gitlab ? { gitlab } : {}), further, connected, summary: summary(account, connected, signIn),
    github: firsts.filter((s) => s !== account),
    others: sources.filter((s) => s.kind !== ACCOUNT && s !== gitlab),
    duplicates: sources.filter((s) => s.duplicateOf !== undefined),
  };
}

/**
 * Why the GitHub connection ended (issue #441), while it has — its sign-in expired or its stored token
 * cannot be read — for the header to ask to connect again on every screen. Undefined while it lives, or
 * was never connected. Any account's (issue #1448): the first's first, then a further one's.
 */
export function connectionEnded(sources: SourceStatus[]): string | undefined {
  const ended = sources.filter((s) => s.kind === ACCOUNT && s.detail.expired === true && typeof s.detail.paused === 'string')
    .sort((a, b) => Number(accountKeyOf(a) !== undefined) - Number(accountKeyOf(b) !== undefined));
  return ended[0]?.detail.paused as string | undefined;
}
