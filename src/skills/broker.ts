// The skill broker (issue #582, design.md "Skills: what the hopper can set up for a box"): a running job asks the hopper
// what it can set up, or loads one skill. The request is the job's, on its machine — its identity: the job's proxy token
// (issue #563) and, on a box, the template the box joined as. In order: the token (its job at work), the skill (one the
// hopper has), the asset a link needs, the box's template, Access (issue #559, `decideMint`), then the vault secrets the
// template may be given (issue #558). A skill that needs a credential the template does not give opens a credential
// request in the vault (issue #583, "The dynamic vault"): the answer is 202, waiting, until a person gives one or
// declines. Every answer is plain text, and every no says why (`skill.refused`); every outcome but a token that names no
// job, and a wait, is an event on the job's timeline.
import { randomUUID } from 'node:crypto';
import { ASSET_KINDS, ASSET_NAME, type Asset, type AssetKind, type MintDecision, type MintRequest } from '../domain/access.ts';
import { machineOfLane } from '../domain/raised-by.ts';
import type { Job, JobStatus, NewEvent } from '../domain/types.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import { askedSkill, catalogText, credentialText, kindsInWords, linkText, mintedLinkText, skillOf, SKILLS, type LinkForm, type Skill, type SkillCredential } from './catalog.ts';

/** The statuses whose jobs may ask: the job's processes are at work on its machine. */
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer'];

/** One user's side: their jobs, the check of a token, their event log, and what a box of theirs may be given. */
export interface SkillUser {
  id: string;
  holds(parts: ProxyTokenParts): boolean;
  job(jobId: string): Job | undefined;
  record(event: NewEvent): void;
  /** The template `machine` joined as, and the vault secrets it may be given now (metadata, never a value). */
  box(machine: string): { template?: string; secrets: BoxSecret[] };
  /** Whether the vault holds a minting credential for the account or cluster `asset` is in (issue #580): then the link is minted. */
  mintsFor(form: LinkForm, asset: Asset): boolean;
  /** The vault asks a person for a credential the box's template does not give (issue #583): waiting, or declined. */
  need(ask: CredentialNeed, asker: { job: Job; machine: string; template: string }): { waiting: string } | { declined: string };
}

/** A vault secret a box may be given, as its metadata says (issue #583: the skill a person gave it for, the kind, their words). */
export interface BoxSecret { name: string; scope?: string; skill?: string; kind?: string; note?: string }

/** What a skill load asks the vault for (src/vault/requests.ts CredentialAsk). */
export interface CredentialNeed { skill: string; title: string; known: boolean; kinds: { id: string; title: string }[]; setup: string; why?: string }

export interface SkillAnswer {
  status: number;
  text: string;
  /** Whose request it was, when its token named a job at work: the user, the job, the request's id. */
  asker?: { userId: string; jobId: string; requestId: string };
}

export interface SkillBroker {
  /** One request: `authorization` as the job sent it; `body` its fields (`name`, `asset`), none for the catalog. Never throws. */
  handle(authorization: string | undefined, body: unknown): Promise<SkillAnswer>;
  /**
   * A request asked again by the hopper (issue #613: a watch answered again when what it waits on may have changed), as
   * the job asked it, under its own id. Undefined when the job is no job of the user's at work: nothing is asked.
   */
  again(userId: string, jobId: string, requestId: string, body: Record<string, string>): Promise<SkillAnswer | undefined>;
}

export interface SkillBrokerOptions {
  user(id: string): SkillUser | undefined;
  /** Access's decision point (issue #559): recorded there, so it feeds the permission matrix. */
  decide(request: MintRequest): Promise<MintDecision>;
  log(line: string): void;
  newId?: () => string;
}

const BEARER = /^Bearer\s+(\S+)$/i;
/** A skill's name a job may ask by, for one the hopper does not have (issue #583). */
const SKILL_NAME = /^[a-z][a-z0-9-]{0,39}$/;
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
      return { ...await answer(user, job, body, requestId), asker: { userId: user.id, jobId: job.id, requestId } };
    },

    async again(userId, jobId, requestId, body) {
      const user = o.user(userId);
      const job = user?.job(jobId);
      if (!user || !job || !AT_WORK.includes(job.status)) return undefined;
      return answer(user, job, body, requestId);
    },
  };

  /** The answer to a request of `job`, a job of `user` at work. */
  async function answer(user: SkillUser, job: Job, body: unknown, requestId: string): Promise<SkillAnswer> {
    const machine = machineOfLane(job.laneId) ?? job.resumeOn;
    const name = field(body, 'name');
    const said = field(body, 'asset');
    const why = field(body, 'why');
    const own = field(body, 'credential');
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
    const known = skillOf(name);
    // A service the hopper has no skill for: asked in the job's words, or one a person already gave a credential for.
    const givenFor = box.secrets.find((s) => s.skill === name);
    const words = own ?? (givenFor ? givenFor.note ?? 'the credential a person gave' : undefined);
    const skill = known ?? (words && SKILL_NAME.test(name) ? askedSkill(name, words.slice(0, 200)) : undefined);
    if (!skill) {
      return no(404, `the hopper has no skill ${name}. It has: ${SKILLS.map((s) => s.name).join(', ')}. For another service, say what credential it takes: sh "$HOPPER_SKILL" ${SKILL_NAME.test(name) ? name : 'NAME'} --credential "<what it takes>". Else find another way.`);
    }
    const loaded = (text: string, decision?: MintDecision): SkillAnswer => {
      record('skill.loaded', decision ? { decision: decision.id } : {});
      return { status: 200, text: `${text}\n` };
    };
    if (skill.link) return link(skill, skill.link);
    if (!skill.credential) return loaded(skill.text);
    const given = box.secrets.filter((s) => s.skill === skill.name);
    return given.length > 0 ? loaded(`${skill.text}\n\n${given.map((s) => credentialText(skill.credential!, s)).join('\n')}`) : ask(skill, skill.credential);

    /** No credential for the skill on this box (issue #583): the vault asks a person; the job waits, or is told they declined. */
    function ask(s: Skill, c: SkillCredential, decision?: MintDecision): SkillAnswer {
      if (!box.template || machine === undefined) {
        return no(403, `${machine ?? 'this machine'} is no box of a template: the vault gives a credential only to a box of a template, so the hopper asks nobody for one here. Find another way, or run on a box of a template.`, decision);
      }
      const r = user.need({
        skill: s.name, title: s.name, known: known !== undefined, kinds: c.kinds.map((k) => ({ id: k.id, title: k.title })), setup: c.setup, ...(why ? { why } : {}),
      }, { job, machine, template: box.template });
      if ('declined' in r) return no(403, r.declined, decision);
      return { status: 202, text: `waiting: ${r.waiting} Add --wait to have the hopper tell you when it is ready.\n` };
    }

    async function link(s: Skill, l: NonNullable<Skill['link']>): Promise<SkillAnswer> {
      const how = `sh "$HOPPER_SKILL" ${s.name} ${l.example}`;
      if (!said) return no(400, `${s.name} sets up a link to ${kindsInWords(l.kinds)}: name it, as ${how}`);
      const asset = assetOf(said);
      if (!asset || !l.kinds.includes(asset.kind)) return no(400, `${s.name} sets up a link to ${kindsInWords(l.kinds)}, not ${said}: name it, as ${how}`);
      if (!box.template) {
        return no(403, `${machine ?? 'this machine'} is no box of a template: Access checks a box by the template it joined as, so the hopper sets up no link here. Find another way, or run on a box of a template.`);
      }
      const decision = await o.decide({ requester: { kind: 'job', userId: user.id, jobId: job.id }, operation: l.operation, asset });
      if (!decision.allowed) return no(403, `Access denied it: ${decision.reason}. A person approves it in Settings → Access; until then, find another way.`, decision);
      if (user.mintsFor(l.form, asset)) return loaded(`${s.text}\n\nAccess allowed it: ${decision.reason}.\n${mintedLinkText(l.form, l.operation, said)}`, decision);
      // The secrets given for this skill (issue #583); else, as before it, every secret of the template given for none.
      const tagged = box.secrets.filter((x) => x.skill === s.name);
      const secrets = tagged.length > 0 ? tagged : box.secrets.filter((x) => x.skill === undefined);
      if (secrets.length === 0) {
        if (s.credential) return ask(s, s.credential, decision);
        return no(403, `Access allows it, but template ${box.template} may be given no vault secret: a person adds one to the template in Settings → Vault and approves it.`, decision);
      }
      const notes = tagged.filter((x) => x.note).map((x) => `${x.name}: the user says: ${x.note}`).join('\n');
      return loaded(`${s.text}\n\nAccess allowed it: ${decision.reason}.\n${linkText(l.form, secrets)}${notes ? `\n${notes}` : ''}`, decision);
    }
  }
}
