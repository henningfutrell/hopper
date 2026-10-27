// A job's egress allowlist (issue #2849, design.md "A job's egress allowlist"). Pure. The hosts a running job may connect
// out to through the hopper (`GET /job/egress`, src/http/job-egress.ts): the hopper's default hosts — the model
// providers, GitHub and the package registries —, unless the user turned them off, then the user's own hosts, then the
// hosts of the job's repository. An entry is `host:port` or `*.domain:port`; the hopper itself is never on it: a job
// reaches the hopper at HOPPER_URL, not through its egress.

/** The user's job egress setting: kept in the database (a settings key), set through the UI session. */
export interface JobEgressSettings {
  /** Whether the hopper's default hosts are on the allowlist. */
  defaults: boolean;
  /** Hosts every job of the user may reach. */
  hosts: string[];
  /** Hosts the jobs of one repository may reach, by `owner/name` in lowercase. */
  repos: Record<string, string[]>;
  /**
   * Whether a job's agent runs behind `hopper-egress` (part 2): its connections then go out through the hopper, to the
   * allowlist's hosts only. Read at each job's start. Off when never set.
   */
  route: boolean;
}

/** The setting of a user who never set one: the defaults only. */
export const NO_JOB_EGRESS: JobEgressSettings = { defaults: true, hosts: [], repos: {}, route: false };

/** The hopper's default hosts: the model providers, GitHub and the package registries a job's tools fetch from. */
export const JOB_EGRESS_DEFAULTS: readonly string[] = [
  // The model providers and their agent CLIs.
  'api.anthropic.com:443', '*.anthropic.com:443', 'claude.ai:443', 'api.openai.com:443', 'chatgpt.com:443',
  // GitHub, its content and its container registry.
  'github.com:443', '*.github.com:443', '*.githubusercontent.com:443', 'ghcr.io:443',
  // The package registries.
  'registry.npmjs.org:443', 'registry.yarnpkg.com:443', 'pypi.org:443', 'files.pythonhosted.org:443',
  'proxy.golang.org:443', 'sum.golang.org:443', 'crates.io:443', 'index.crates.io:443', 'static.crates.io:443',
  'repo.maven.apache.org:443', 'repo1.maven.org:443', 'plugins.gradle.org:443', 'services.gradle.org:443', 'rubygems.org:443',
  'registry-1.docker.io:443', 'auth.docker.io:443', 'production.cloudflare.docker.com:443',
];

/** A DNS label: letters, digits and `-`, not at either end. */
const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** `host:port`, or `*.domain:port` with at least two labels after the wildcard; the port is checked apart. */
const ENTRY = new RegExp(`^(\\*\\.${LABEL}(\\.${LABEL})+|${LABEL}(\\.${LABEL})*):([1-9][0-9]{0,4})$`);

/** Why `entry` is no job egress entry; undefined when it is one. Read in lowercase. */
export function jobEgressHostProblem(entry: string): string | undefined {
  const m = ENTRY.exec(entry.toLowerCase());
  if (!m || Number(m[m.length - 1]) > 65535 || entry.length > 260) {
    return `egress host ${JSON.stringify(entry)} is not host:port: a DNS name or an address, or *.domain for the names under a domain, no scheme, and a port from 1 to 65535`;
  }
  return undefined;
}

/** The setting as kept: entries and repositories in lowercase, each list without repeats. */
export function normalJobEgress(s: JobEgressSettings): JobEgressSettings {
  const lower = (l: readonly string[]): string[] => [...new Set(l.map((h) => h.toLowerCase()))];
  const repos = Object.fromEntries(Object.entries(s.repos).map(([r, l]): [string, string[]] => [r.toLowerCase(), lower(l)]).filter(([, l]) => l.length > 0));
  return { defaults: s.defaults, hosts: lower(s.hosts), repos, route: s.route };
}

/** The allowlist of a job of `repo` (`owner/name`; none for a job with no repository). */
export function jobEgressList(s: JobEgressSettings, repo: string | undefined): string[] {
  const own = repo ? s.repos[repo.toLowerCase()] ?? [] : [];
  return [...new Set([...(s.defaults ? JOB_EGRESS_DEFAULTS : []), ...s.hosts, ...own])];
}

/** Whether `list` allows a connection to `host` on `port`: an exact host, or a name under a wildcard's domain. */
export function jobEgressAllows(list: readonly string[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some((entry) => {
    const at = entry.lastIndexOf(':');
    if (Number(entry.slice(at + 1)) !== port) return false;
    const name = entry.slice(0, at);
    return name.startsWith('*.') ? h.endsWith(name.slice(1)) : h === name;
  });
}
