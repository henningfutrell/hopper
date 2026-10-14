// An ssh target's herdr (issue #741): the herdr client the hopper calls there and the herdr server of its session, as
// `herdr status server` and `herdr status client` print them. A client whose protocol the server does not take fails
// every job start there (`client protocol 17 is older than server protocol 22`), while the session still answers
// `status: running`; so the probe reads both versions and names a **herdr problem**. Pure.
import type { HerdrSide, HerdrVersions } from '../domain/types.ts';

/** `key: value` lines, as herdr's status commands print them. */
function fields(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return m;
}

function side(f: Map<string, string>): HerdrSide {
  const protocol = Number(f.get('protocol'));
  const version = f.get('version');
  return { ...(version ? { version } : {}), ...(Number.isInteger(protocol) && f.has('protocol') ? { protocol } : {}) };
}

const FIX = 'install the server\'s herdr there';

const named = (what: string, s: HerdrSide & { binary?: string }): string => {
  const said = [s.protocol !== undefined ? `protocol ${s.protocol}` : undefined, s.binary].filter((x) => x !== undefined).join(', ');
  return `its herdr ${what}${s.version ? ` ${s.version}` : ''}${said ? ` (${said})` : ''}`;
};

/** The herdr problem of a client the server does not take. */
const problem = (client: HerdrSide & { binary?: string }, server: HerdrSide): string =>
  `${named('client', client)} is not compatible with ${named('server', server)}: ${FIX}`;

/**
 * What `status server` and, when it answered, `status client` say: whether the session runs, both versions, and
 * a herdr problem when the server says the client is not compatible, or (an older herdr that does not say) the
 * client's protocol is older than the server's.
 */
export function readHerdrStatus(server: string, client?: string): { running: boolean; versions: HerdrVersions; herdrProblem?: string } {
  const s = fields(server);
  const running = s.get('status') === 'running';
  if (!running) return { running, versions: {} };
  const c = client === undefined ? undefined : fields(client);
  const serverSide = side(s);
  const clientSide = c ? { ...side(c), ...(c.get('binary') ? { binary: c.get('binary')! } : {}) } : undefined;
  const versions: HerdrVersions = { ...(clientSide && Object.keys(clientSide).length ? { client: clientSide } : {}), ...(Object.keys(serverSide).length ? { server: serverSide } : {}) };
  const compatible = s.get('compatible');
  const older = clientSide?.protocol !== undefined && serverSide.protocol !== undefined && clientSide.protocol < serverSide.protocol;
  const bad = compatible !== undefined ? compatible === 'no' : older;
  return { running, versions, ...(bad ? { herdrProblem: problem(clientSide ?? {}, serverSide) } : {}) };
}

const MISMATCH = /client protocol (\d+) is older than server protocol (\d+)/;

/** The herdr problem herdr's own protocol error names (a herdr call failed with it), or undefined for any other error. */
export function herdrMismatch(message: string): string | undefined {
  const m = MISMATCH.exec(message);
  return m ? problem({ protocol: Number(m[1]) }, { protocol: Number(m[2]) }) : undefined;
}
