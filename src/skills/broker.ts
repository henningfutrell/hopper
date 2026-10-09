// The skill broker (issue #582, design.md "Skills: what the hopper can set up for a box"): a running job asks the hopper
// what it can set up, or loads one skill. The request is the job's, on its machine — its identity: the job's proxy token
// (issue #563) and, on a box, the template the box joined as. In order: the token (its job at work), the skill (one the
// hopper has), the asset a link needs, the box's template, Access (issue #559, `decideMint`), then the vault secrets the
// template may be given (issue #558). Every answer is plain text, and every no says why (`skill.refused`); every
// outcome but a token that names no job is an event on the job's timeline.
import { randomUUID } from 'node:crypto';
import { ASSET_KINDS, ASSET_NAME, type Asset, type AssetKind, type MintDecision, type MintRequest } from '../domain/access.ts';
import { machineOfLane } from '../domain/raised-by.ts';
import type { Job, JobStatus, NewEvent } from '../domain/types.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import { catalogText, kindsInWords, linkText, mintedLinkText, skillOf, SKILLS, type LinkForm, type Skill } from './catalog.ts';

/** The statuses whose jobs may ask: the job's processes are at work on its machine. */
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer'];

/** One user's side: their jobs, the check of a token, their event log, and what a box of theirs may be given. */
export interface SkillUser {
  id: string;
  holds(parts: ProxyTokenParts): boolean;
  job(jobId: string): Job | undefined;
  record(event: NewEvent): void;
  /** The template `machine` joined as, and the vault secrets it may be given now (metadata, never a value). */
  box(machine: string): { template?: string; secrets: { name: string; scope?: string }[] };
  /** Whether the vault holds a minting credential for the account or cluster `asset` is in (issue #580): then the link is minted. */
  mintsFor(form: LinkForm, asset: Asset): boolean;
}

export interface SkillAnswer { status: number; text: string }

export interface SkillBroker {
  /** One request: `authorization` as the job sent it; `body` its fields (`name`, `asset`), none for the catalog. Never throws. */
  handle(authorization: string | undefined, body: unknown): Promise<SkillAnswer>;
}

export interface SkillBrokerOptions {
  user(id: string): SkillUser | undefined;
  /** Access's decision point (issue #559): recorded there, so it feeds the permission matrix. */
  decide(request: MintRequest): Promise<MintDecision>;
  log(line: string): void;
  newId?: () => string;
}

const BEARER = /^Bearer\s+(\S+)$/i;
const field = (body: unknown, key: string): string | undefined => {
  const v = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

/** `cluster/prod` as an asset; undefined when it names no kind the model has, or a name it cannot hold. */
function assetOf(said: string): Asset | undefined {
  const i = said.indexOf('/');
  const kind = said.slice(0, i);
  const name = said.slice(i + 1);
  return i > 0 && (ASSET_KINDS as readonly string[]).includes(kind) && ASSET_NAME.test(name) ? { kind: kind as AssetKind, name } : undefined;
}

export function createSkillBroker(o: SkillBrokerOptions): SkillBroker {
  const newId = o.newId ?? (() => randomUUID());
  return {
    async handle(authorization, body) {
      const parts = parseProxyToken(BEARER.exec(authorization ?? '')?.[1] ?? '');
      const user = parts ? o.user(parts.userId) : undefined;
      const job = parts && user?.holds(parts) ? user.job(parts.jobId) : undefined;
      if (!parts || !user || !job) {
        o.log('hopper: skills: refused a request whose token is no job\'s');
        return { status: 401, text: 'no: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE.\n' };
      }
      if (!AT_WORK.includes(job.status)) return { status: 401, text: `no: job ${job.id} is ${job.status}, not at work: only a running job asks the hopper.\n` };

      const requestId = newId();
      const machine = machineOfLane(job.laneId) ?? job.resumeOn;
      const name = field(body, 'name');
      const said = field(body, 'asset');
      const box = machine === undefined ? { secrets: [] } : user.box(machine);
      const at = { requestId, ...(machine ? { machine } : {}), ...(box.template ? { template: box.template } : {}), ...(name ? { skill: name } : {}), ...(said ? { asset: said } : {}) };
      const record = (type: 'skill.listed' | 'skill.loaded' | 'skill.refused', data: Record<string, unknown> = {}): void => {
        user.record({ type, jobId: job.id, data: { ...at, ...data } });
      };
      const no = (status: number, reason: string, decision?: MintDecision): SkillAnswer => {
        record('skill.refused', { reason, ...(decision ? { decision: decision.id } : {}) });
        return { status, text: `no: ${reason}\n` };
      };

      if (!name) {
        record('skill.listed');
        return { status: 200, text: catalogText() };
      }
      const skill = skillOf(name);
      if (!skill) return no(404, `the hopper has no skill ${name}. It has: ${SKILLS.map((s) => s.name).join(', ')}. Find another way.`);
      const loaded = (text: string, decision?: MintDecision): SkillAnswer => {
        record('skill.loaded', decision ? { decision: decision.id } : {});
        return { status: 200, text: `${text}\n` };
      };
      if (!skill.link) return loaded(skill.text);
      return link(skill, skill.link);

      async function link(s: Skill, l: NonNullable<Skill['link']>): Promise<SkillAnswer> {
        const how = `sh "$HOPPER_SKILL" ${s.name} ${l.example}`;
        if (!said) return no(400, `${s.name} sets up a link to ${kindsInWords(l.kinds)}: name it, as ${how}`);
        const asset = assetOf(said);
        if (!asset || !l.kinds.includes(asset.kind)) return no(400, `${s.name} sets up a link to ${kindsInWords(l.kinds)}, not ${said}: name it, as ${how}`);
        if (!box.template) {
          return no(403, `${machine ?? 'this machine'} is no box of a template: Access checks a box by the template it joined as, so the hopper sets up no link here. Find another way, or run on a box of a template.`);
        }
        const decision = await o.decide({ requester: { kind: 'job', userId: user!.id, jobId: job!.id }, operation: l.operation, asset });
        if (!decision.allowed) return no(403, `Access denied it: ${decision.reason}. A person approves it in Settings → Access; until then, find another way.`, decision);
        if (user!.mintsFor(l.form, asset)) return loaded(`${s.text}\n\nAccess allowed it: ${decision.reason}.\n${mintedLinkText(l.form, l.operation, said)}`, decision);
        if (box.secrets.length === 0) {
          return no(403, `Access allows it, but template ${box.template} may be given no vault secret: a person adds one to the template in Settings → Vault and approves it.`, decision);
        }
        return loaded(`${s.text}\n\nAccess allowed it: ${decision.reason}.\n${linkText(l.form, box.secrets)}`, decision);
      }
    },
  };
}
