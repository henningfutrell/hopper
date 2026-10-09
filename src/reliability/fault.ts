// A lane fault (issue #535): a failure that was not the job's fault, but its lane's — the machine offline or not
// dialled in, its link closed, a start or a dialog the agent could not get past, a pane lost. The failure assessor's
// known causes name most of them; the rest are the executors' own start failures. Pure.
import { matchCause } from '../failures/causes.ts';

/** The known causes (issue #509) that are a lane's, not a job's. */
const LANE_CAUSES: ReadonlySet<string> = new Set(['machine-offline', 'link-closed', 'start-race', 'socket-path-too-long', 'disk-full']);

/** The executors' start and pane failures no known cause names. */
const LANE_ERRORS = /at startup|never reached claude|never shared dependencies|is not usable on|^herdr:|is already held by lane/i;

export function isLaneFault(error: string): boolean {
  const cause = matchCause(error, '', []);
  return (cause !== undefined && LANE_CAUSES.has(cause.id)) || LANE_ERRORS.test(error);
}
