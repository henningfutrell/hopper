// Renders docs/events.md from the schemas, so the document cannot drift from them.
import { EVENT_SCHEMA_VERSIONS, EVENT_TYPES, type EventType } from '../domain/types.ts';
import { EVENT_EXAMPLES } from './examples.ts';
import { exportJsonSchemas } from './export.ts';
import { LEGACY_EVENT_SCHEMAS } from './legacy.ts';

const WHEN: Record<EventType, string> = {
  'job.queued': 'A job was created from a source item; it waits at the queue gate until accepted (`job.accepted`).',
  'job.prioritized': 'The router\'s advice arrived for a job; once per job, whatever its status then.',
  'job.held': 'A Decision held a job and its hold reason changed.',
  'job.approved': 'A human approved a job the router held (e.g. `ask_human`).',
  'job.claimed': 'A Decision assigned a job to a lane.',
  'job.started': 'The executor began running a claimed job.',
  'job.progressed': 'An executor reported progress; at most one per job per 500 ms.',
  'job.finished': 'A job ended successfully.',
  'job.failed': 'A job ended with an error.',
  'job.cancelled': 'A job was cancelled.',
  'job.requeued': 'A job went back to the queue (restart recovery, or a question answered or closed). `reason` is a free string.',
  'job.reattached': 'The executor watches a job\'s live external work again (the herdr pane and Claude) without sending anything. `reason` `daemon restart`: restart recovery kept a running job running on its lane. `reason` `answered in the pane`: the owner typed the answer into a parked job\'s pane; the job runs again on a lane.',
  'job.reprioritized': 'A source re-sorted a waiting job.',
  'lane.opened': 'A Decision opened a lane.',
  'lane.closed': 'A lane closed (decision reason, `drained`, or `daemon restart`).',
  'decision.made': 'The engine recorded a Decision.',
  'router.mode_changed': 'The router mode was switched.',
  'question.asked': 'A running job paused on a question.',
  'question.escalated': 'A question entered a stage — `target` is an escalation level\'s instance name, or `human` — or the human was re-notified. `reason` says why it climbed: the reply or the failure of the level below, or a risk rule hit.',
  'question.answered': 'An answer was accepted: an escalation level\'s (`by` = the level instance), or the human\'s (`via: "pane"` when they typed it into the job\'s pane: the job already runs again, nothing is typed for them).',
  'question.closed': 'The owner closed an open question without answering (UI Close). The job resumes with `answer`, the fixed close text, typed in; any escalation level call in flight is aborted.',
  'question.dismissed': 'The owner dismissed an open question (UI Dismiss): it needs no action any more. Nothing is typed into the job; a job still waiting on it is cancelled (`job.cancelled`, reason `question dismissed`); any escalation level call in flight is aborted.',
  'question.expired': 'The human stage timed out and the job fails.',
  'update.available': 'A check found a newer target on the update channel than the installed commit (once per target). `ref` is the branch or the release tag; `changes` counts its commits not installed (an operator detail; the UI shows the bullets of WHATS-NEW.md instead).',
  'update.started': 'Applying an update began (UI, or auto-update): the target is built beside the running install. Running jobs keep running.',
  'update.applied': 'The first boot on an applied update: the install now runs `to`. Recovery reattached what was running.',
  'update.failed': 'Applying an update failed (fetch, build, the new build not loading, or the swap) and the install is unchanged — or a boot after an update is not on the applied commit.',
  'plugin.installed': 'A plugin was installed from the plugin store into the plugin dir (UI Install or Update), at the store\'s commit `commit`. A plugin new to this process is loaded at once; one installed again runs its new code after a restart.',
  'plugin.removed': 'A store install was removed from the plugin dir (UI Remove). Nothing in plugins.yaml named it.',
  'job.accepted': 'A job passed the queue gate and may run: `by` `pre-sort` (the gate auto-accepts, or the user took the pre-sort with Accept pre-sort), or `user` (moved into the user order).',
  'job.rejected': 'A waiting job was turned away at the queue gate: it ends `rejected`, is kept, and never runs. `by` `user` (UI Reject) or `pre-sort` (the queue sorter rejected it); `reason` is also the job\'s `error`. Its source is told (on GitHub: the `hopper:rejected` label).',
  'queue.ordered': 'The user ordered the queue: `jobIds`, first to last, run before every job not in it.',
  'queue.gate_changed': 'The queue gate was changed: its mode (`auto-accept` or `review`) or its throttle (`autoAcceptPerHour`, null for none).',
};

type Prop = Record<string, unknown>;

function typeOf(p: Prop): string {
  if (Array.isArray(p.enum)) return p.enum.map((v) => `\`${String(v)}\``).join(' \\| ');
  if (Array.isArray(p.anyOf)) return (p.anyOf as Prop[]).map(typeOf).join(' \\| ');
  if (p.type === 'array') return `${typeOf((p.items ?? {}) as Prop)}[]`;
  if (typeof p.type === 'string') return p.type;
  return 'any';
}

function fieldRows(schema: Prop): string {
  const props = (schema.properties ?? {}) as Record<string, Prop>;
  const required = new Set((schema.required ?? []) as string[]);
  const rows = Object.entries(props).map(([k, p]) => `| \`${k}\` | ${typeOf(p)} | ${required.has(k) ? 'yes' : 'no'} |`);
  return rows.length ? ['| field | type | required |', '|---|---|---|', ...rows].join('\n') : '`data` is `{}`.';
}

export function renderEventsMarkdown(): string {
  const files = exportJsonSchemas();
  const out = [
    '# Events',
    '',
    '<!-- generated by `npm run schemas` from src/events — do not edit -->',
    '',
    'Every event (stored, SSE, `/api/events`, webhook body) is the envelope below. `schemaVersion` is the',
    "version of **that type's** payload schema; the JSON Schema for each is in `docs/schemas/<type>.v<N>.json`.",
    'An additive (optional) field keeps the version; a removed, renamed or retyped field bumps it and adds',
    '`<type>.v<N+1>.json` — the old file stays as documentation of what older consumers received.',
    '',
    'Events stored before phase 3 read as v1 and are not re-validated.',
    '',
    `Stored events are never rewritten. Superseded versions stay readable and documented: ${Object.keys(LEGACY_EVENT_SCHEMAS).map((k) => `\`${k}\``).join(', ')}`,
    '(phase 5 renamed Jev → router: `jev.mode_changed` is now `router.mode_changed`; slice 2 made question',
    'stages instance names: `question.escalated.target` and `question.answered.by` were `opus | fable | human` in v1).',
    '',
    '```json',
    '{ "schemaVersion": 1, "seq": 1, "id": "uuid", "type": "job.queued", "at": "ISO",',
    '  "jobId": "…", "laneId": "…", "machineId": "…", "decisionId": "…", "questionId": "…", "data": { … } }',
    '```',
    '',
    'Schema: `docs/schemas/envelope.v1.json`. Payloads are strict: unknown keys are rejected.',
  ];
  for (const t of EVENT_TYPES) {
    const v = EVENT_SCHEMA_VERSIONS[t];
    out.push('', `## \`${t}\``, '', `Version ${v} (\`docs/schemas/${t}.v${v}.json\`). ${WHEN[t]}`, '',
      fieldRows(files[`${t}.v${v}.json`] as Prop), '', '```json', JSON.stringify(EVENT_EXAMPLES[t], null, 2), '```');
  }
  return `${out.join('\n')}\n`;
}
