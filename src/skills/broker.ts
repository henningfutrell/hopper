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
import type { Job, JobStatus, NewEvent, OperationProfile } from '../domain/types.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import { askedSkill, catalogText, credentialText, kindsInWords, linkText, mintedLinkText, skillOf, SKILL_NAMES, type LinkForm, type Skill, type SkillCredential } from './catalog.ts';
import { HOLD_TIMEOUT, JEV_APPROVER, type SandboxRequestView } from '../domain/sandbox-approvals.ts';
import { nameWithoutEmail } from '../domain/users.ts';
import { MIN_TRUST_DECLINER } from '../domain/stamp-capabilities.ts';
import { needsOf, SANDBOX_SKILL, TEMPLATE_SKILL, type AskAbout, type TemplateAnswer } from './template-request.ts';
import { askOf, type TemplateAsk } from './template-ask.ts';
import { withActionLines, type TemplateActionsAnswer } from '../vault/template-actions.ts';
import { PLAN_MAX, PURPOSE_MAX, type TemplateView } from '../domain/vault.ts';
import { templateReady } from '../domain/sandboxes-before-start.ts';
import { helpForAgent } from '../help/book.ts';
import { BASTION_SKILL, bastionAsk, type BastionUser } from './bastion-skill.ts'; import { DATABASE_SKILL, databaseAsk, type DatabaseUser } from './database-skill.ts';
import { isServedSkill, repoCopyOf, servedSkill, servedText } from './library.ts';

/** What a job refused for its trust can do (issue #655 part 16): nothing it asks raises its trust. */
const MIN_TRUST_ADVICE = 'Asking again does not change it: an admin sets the minimum trust in Users & access → Access. Find another way.';

/** The skills whose `template` field names the sandbox itself, never the template a credential is asked for. */
const SANDBOX_OWN: readonly string[] = [SANDBOX_SKILL, TEMPLATE_SKILL, BASTION_SKILL, DATABASE_SKILL];

/** The statuses whose jobs may ask: the job's processes are at work on its machine. */
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];

/** One user's side: their jobs, the check of a token, their event log, and what a box of theirs may be given. */
export interface SkillUser extends Pick<BastionUser, 'bastions'>, Pick<DatabaseUser, 'databases'> {
  id: string;
  holds(parts: ProxyTokenParts): boolean;
  job(jobId: string): Job | undefined;
  record(event: NewEvent): void;
  /** The template `machine` joined as, and the vault secrets it may be given now (metadata, never a value). */
  box(machine: string): { template?: string; secrets: BoxSecret[] };
  /**
   * Issue #2356: the template of the job's approved sandbox runs, named by a job off a box, and the vault secrets it may be
   * given now; undefined when the job has no approved sandbox runs of it. Its box steps get what it gives.
   */
  runsOf?(job: Job, template: string): { template: string; secrets: BoxSecret[] } | undefined;
  /** Whether the vault holds a minting credential for the account or cluster `asset` is in (issue #580): then the link is minted. */
  mintsFor(form: LinkForm, asset: Asset): boolean;
  /** The vault asks a person for a credential the box's template does not give (issue #583): waiting, or declined. */
  need(ask: CredentialNeed, asker: { job: Job; machine: string; template: string }): { waiting: string } | { declined: string };
  /** A template request (issue #716): the hopper makes the template the job's needs say (and, issue #1875, its secrets, image and egress hosts), or says why not. */
  requestTemplate(ask: TemplateAsk, job: Job, about?: AskAbout): Promise<TemplateAnswer>;
  /** The user's template of that name, as the vault shows it (issue #1471: a sandbox ask may name one); undefined: none. */
  template(name: string): TemplateView | undefined;
  /** A sandbox request (issue #991): the job's ask for a box of the template, and where it is now; `about`: why, and its plan (issue #1001). */
  sandbox(template: string, job: Job, about?: AskAbout): SandboxRequestView;
  /**
   * The job's ask waits on the template for a person (issue #1001): their approval then covers the job's run. Its run card
   * (issue #2197); answers the job's run of the template when a person declined that card.
   */
  sandboxWaits?(template: string, job: Job, about?: AskAbout): SandboxRequestView | undefined;
  /** Why needs are outside the job's trust stamp (issue #655 part 16): asked before a template is made for them. Absent: inside. */
  outsideStamp?(profiles: readonly OperationProfile[], job: Job): string | undefined;
  /** The action check (issue #2206, part 2) of the AWS actions a template request's change names (`--actions`). Absent: this hopper checks none. */
  actionCheck?(needs: readonly OperationProfile[], said: readonly string[], job: Job, why?: string): Promise<TemplateActionsAnswer>;
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
    const onBox: { template?: string; secrets: BoxSecret[] } = machine === undefined ? { secrets: [] } : user.box(machine);
    // Issue #2356: a job off a box names the template of its approved sandbox runs for a credential its box steps use.
    const named = field(body, 'template');
    const runs = !onBox.template && named !== undefined && !SANDBOX_OWN.includes(name ?? '') ? user.runsOf?.(job, named) : undefined;
    const box = runs ?? onBox;
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
    // Issue #1001: a sandbox ask says why the job needs it, and for a change what the box will do: the person who
    // approves it reads both on its card.
    const told = name === TEMPLATE_SKILL || name === SANDBOX_SKILL ? aboutOf(name, why, field(body, 'plan'), field(body, 'needs')) : undefined;
    if (typeof told === 'string') return no(400, told);
    const about: AskAbout | undefined = told;
    // Issue #655 part 16: needs above the job's trust are refused by policy, before a template is made for them.
    const needs = name === TEMPLATE_SKILL || name === SANDBOX_SKILL ? needsOf(field(body, 'needs')) : undefined;
    const outside = needs === undefined || typeof needs === 'string' ? undefined : user.outsideStamp?.(needs, job);
    if (outside) return no(403, `${MIN_TRUST_DECLINER} refuses these needs: ${outside}. ${MIN_TRUST_ADVICE}`);
    // Issue #2206, part 2: the AWS actions the change names, checked before the template is made.
    const actions = field(body, 'actions')?.split(/\s+/) ?? [];
    if (actions.length > 0 && name === SANDBOX_SKILL) return no(400, `--actions is for ${TEMPLATE_SKILL} and need steps: a box step's change is not narrowed to granted actions, so run the change as a need step`);
    const acts = actions.length > 0 && Array.isArray(needs) ? await user.actionCheck?.(needs, actions, job, why) : undefined;
    if (acts && 'no' in acts) return no(acts.no.status, acts.no.reason);
    if (name === TEMPLATE_SKILL) {
      const t = await user.requestTemplate(askOf((k) => field(body, k)), job, about);
      if ('reason' in t) return no(t.status, t.reason);
      const text = acts ? withActionLines(t.text, acts) : t.text;
      if (t.status === 202 || acts?.waits) {
        // Issue #2197: the ask is a run card; a person who declined it declined the job's run of the template.
        const declined = t.status === 202 ? user.sandboxWaits?.(t.template, job, about) : undefined;
        if (declined) return no(403, declinedText(t.template, declined));
        return { status: 202, text: `${text} Add --wait to have the hopper tell you when it is ready.\n` };
      }
      record('skill.loaded');
      return { status: 200, text: `${text}\n` };
    }
    if (name === SANDBOX_SKILL) return sandbox();
    // Issue #2146: the job's bastion, after the same approvals as its sandbox runs.
    if (name === BASTION_SKILL) {
      return bastionAsk(user, job, { asset: said, template: field(body, 'template'), targets: field(body, 'targets'), why, secrets: field(body, 'secrets'), path: field(body, 'path'), data: field(body, 'data') }, {
        no, loaded: (text) => { record('skill.loaded'); return { status: 200, text }; }, waiting: (text) => ({ status: 202, text }), waitingText, declinedText,
      });
    }
    // Issue #2231: a database read, after a person approved the template's read on the database and the job's runs of it.
    if (name === DATABASE_SKILL) {
      return databaseAsk(user, job, { asset: said, template: field(body, 'template'), database: field(body, 'database'), sql: field(body, 'sql'), why }, {
        no, loaded: (text) => { record('skill.loaded'); return { status: 200, text }; }, waiting: (text) => ({ status: 202, text }), waitingText, declinedText,
      });
    }
    if (name === 'help') {
      const h = helpForAgent(said);
      if ('no' in h) return no(404, h.no);
      record('skill.loaded');
      return { status: 200, text: `${h.text}\n` };
    }
    // Issue #1909: a built-in library skill, its version on the job's timeline, so the job record says which one it got;
    // or the repository's own copy the job follows, its folder, tree and commit. An alias (issue #2145) records the skill it names.
    if (isServedSkill(name)) {
      const b = servedSkill(name);
      const copy = repoCopyOf({ repoCopy: field(body, 'repoCopy'), tree: field(body, 'tree'), commit: field(body, 'commit'), changed: field(body, 'changed') });
      if (copy && 'no' in copy) return no(400, copy.no);
      if (copy) {
        record('skill.loaded', { skill: b.name, version: b.version, repoCopy: copy });
        return { status: 200, text: `recorded: this job follows the repository's own copy at ${copy.path} (tree ${copy.tree.slice(0, 12)}, commit ${copy.commit.slice(0, 12)}${copy.changed ? ', with changes' : ''}). Its rules win where it differs from the hopper's ${b.name} ${b.version}.\n` };
      }
      const t = servedText(b, said);
      if ('no' in t) return no(404, t.no);
      record('skill.loaded', { skill: b.name, version: b.version });
      return { status: 200, text: `${t.text}\n` };
    }
    const known = skillOf(name);
    // A service the hopper has no skill for: asked in the job's words, or one a person already gave a credential for.
    const givenFor = box.secrets.find((s) => s.skill === name);
    const words = own ?? (givenFor ? givenFor.note ?? 'the credential a person gave' : undefined);
    const skill = known ?? (words && SKILL_NAME.test(name) ? askedSkill(name, words.slice(0, 200)) : undefined);
    if (!skill) {
      return no(404, `the hopper has no skill ${name}. It has: ${SKILL_NAMES.join(', ')}. For another service, say what credential it takes: sh "$HOPPER_SKILL" ${SKILL_NAME.test(name) ? name : 'NAME'} --credential "<what it takes>". Else find another way.`);
    }
    const loaded = (text: string, decision?: MintDecision): SkillAnswer => {
      record('skill.loaded', decision ? { decision: decision.id } : {});
      return { status: 200, text: `${text}\n` };
    };
    if (skill.link) return link(skill, skill.link);
    if (!skill.credential) return loaded(skill.text);
    const given = box.secrets.filter((s) => s.skill === skill.name);
    const inSteps = runs ? `\nThis job runs on no box: read it in a box step of template ${runs.template}, as sh "$HOPPER_STEP" box ${runs.template} --command '<the command>'.` : '';
    return given.length > 0 ? loaded(`${skill.text}\n\n${given.map((s) => credentialText(skill.credential!, s)).join('\n')}${inSteps}`) : ask(skill, skill.credential);

    /** No credential for the skill on this box (issue #583): the vault asks a person; the job waits, or is told they declined. */
    function ask(s: Skill, c: SkillCredential, decision?: MintDecision): SkillAnswer {
      if (!onBox.template && named !== undefined && !runs) {
        return no(403, `this job has no approved sandbox runs of template ${named}. Ask for them first: sh "$HOPPER_SKILL" sandbox --template ${named} --why "<why the job needs it>" --wait. Then ask for the credential again.`, decision);
      }
      if (!box.template || machine === undefined) {
        return no(403, `${machine ?? 'this machine'} is no box of a template: the vault gives a credential only to a box of a template, so the hopper asks nobody for one here. Name the template of this job's approved sandbox runs with --template NAME: its box steps get the credential. Else find another way.`, decision);
      }
      const r = user.need({
        skill: s.name, title: s.name, known: known !== undefined, kinds: c.kinds.map((k) => ({ id: k.id, title: k.title })), setup: c.setup, ...(why ? { why } : {}),
      }, { job, machine, template: box.template });
      if ('declined' in r) return no(403, r.declined, decision);
      return { status: 202, text: `waiting: ${r.waiting} Add --wait to have the hopper tell you when it is ready.\n` };
    }

    /**
     * Issue #991: the template the needs make, then the approval of its sandbox runs. Each wait is a 202 the job's --wait
     * ends; the approval is a 200 that says how the job runs each step (issue #1349): in a sandbox of its own, burned after it.
     */
    async function sandbox(): Promise<SkillAnswer> {
      const named = field(body, 'template');
      if (named !== undefined) return namedSandbox(named);
      const t = await user.requestTemplate(askOf((k) => field(body, k)), job, about);
      if ('reason' in t) return no(t.status, t.reason);
      const later = ' Add --wait to have the hopper tell you when the sandbox runs are approved.\n';
      if (t.status === 202) {
        const declined = user.sandboxWaits?.(t.template, job, about);
        if (declined) return no(403, declinedText(t.template, declined));
        return { status: 202, text: `${t.text} Then the sandbox runs of it wait for approval.${later}` };
      }
      const r = user.sandbox(t.template, job, about);
      if (r.state === 'waiting') return { status: 202, text: `${waitingText(t.template, r)}${later}` };
      if (r.state === 'declined') return no(403, declinedText(t.template, r));
      return approved(t.template, r);
    }

    /** Who the job's waiting sandbox runs of `template` wait for: a person, or Jev's check first (issue #655 part 13). */
    function waitingText(template: string, r: SandboxRequestView): string {
      if (r.jev?.state === 'checking') return `waiting: Jev checks the sandbox runs of template ${template}; it approves them, or asks a person to approve them on Access requests.`;
      const held = r.jev?.state === 'held' ? ` Jev held them for a person${r.jev.reason ? `: ${r.jev.reason}` : ''}.` : '';
      return `waiting: the sandbox runs of template ${template} wait for a person to approve them on Access requests.${held}`;
    }

    /** Why the job's sandbox runs of `template` are declined: a person or Jev said no (issue #655 part 13), or none answered in time (part 9). */
    function declinedText(template: string, r: SandboxRequestView): string {
      if (r.declinedBy === HOLD_TIMEOUT) return `the hopper declined the sandbox runs of template ${template}: ${r.reason ?? 'no person answered in time'}. Find another way.`;
      if (r.declinedBy === MIN_TRUST_DECLINER) return `${MIN_TRUST_DECLINER} declined the sandbox runs of template ${template}: ${r.reason ?? 'the job\'s trust is below it'}. ${MIN_TRUST_ADVICE}`;
      if (r.declinedBy === JEV_APPROVER) return `Jev declined the sandbox runs of template ${template}: ${r.reason ?? 'no reason given'}. Find another way.`;
      return `a person declined the sandbox runs of template ${template}: ${r.reason ?? 'no reason given'}. Find another way.`;
    }

    /** The approval of the job's sandbox runs of `template`: how it runs each step (issue #1349). */
    function approved(template: string, r: SandboxRequestView): SkillAnswer {
      record('skill.loaded');
      return {
        status: 200,
        text: `${SANDBOX_SKILL}: the sandbox runs of template ${template} are approved for this job, by ${nameWithoutEmail(r.approvedBy ?? 'a person')}. A sandbox never runs this job and never joins the hopper as a machine. Run each command that needs these assets as a box step: the hopper makes a new sandbox of template ${template} for the step, mints short-lived credentials for it there, gives back the output, exit code and outputs, and destroys the sandbox when the step ends. Nothing is kept between steps.\n  sh "$HOPPER_STEP" box ${template} --command '<the command>'\nLoad the box-step skill (sh "$HOPPER_SKILL" box-step) for the inputs, the outputs, --plan-id and the credentials in the sandbox.\n`,
      };
    }

    /**
     * Issue #1471: the sandbox runs of a template the user has, named (`--template NAME`), as a brief often names one. The
     * template stays as it is: a person approves the runs, and the template too when it waits for them.
     */
    function namedSandbox(name: string): SkillAnswer {
      if (field(body, 'needs') !== undefined) return no(400, 'give --template NAME or --needs, not both');
      const t = user.template(name);
      if (!t) return no(404, `there is no template ${name}. Name a template the user has, or say what the work needs with --needs.`);
      if (!about?.plan && t.profiles.some((p) => p.operation !== 'read')) {
        return no(400, `template ${name} changes assets: say what the box will do with --plan "<the commands or the plan; for each change, what it changes (resource names) and whether it can be undone>"`);
      }
      const r = user.sandbox(name, job, about);
      const later = ' Add --wait to have the hopper tell you when the sandbox runs are approved.\n';
      if (r.state === 'waiting') return { status: 202, text: `${waitingText(name, r)}${later}` };
      if (r.state === 'declined') return no(403, declinedText(name, r));
      if (!templateReady(t, job.id)) {
        user.sandboxWaits?.(name, job, about);
        return { status: 202, text: `waiting: the sandbox runs of template ${name} are approved, but the template waits for a person or for its read-only check on Access requests.${later}` };
      }
      return approved(name, r);
    }

    async function link(s: Skill, l: NonNullable<Skill['link']>): Promise<SkillAnswer> {
      const how = `sh "$HOPPER_SKILL" ${s.name} ${l.example}`;
      if (!said) return no(400, `${s.name} sets up a link to ${kindsInWords(l.kinds)}: name it, as ${how}`);
      const asset = assetOf(said);
      if (!asset || !l.kinds.includes(asset.kind)) return no(400, `${s.name} sets up a link to ${kindsInWords(l.kinds)}, not ${said}: name it, as ${how}`);
      if (!onBox.template) {
        return no(403, `${machine ?? 'this machine'} is no box of a template: Access checks a box by the template it joined as, so the hopper sets up no link here. Find another way, or run on a box of a template.`);
      }
      const decision = await o.decide({ requester: { kind: 'job', userId: user.id, jobId: job.id }, operation: l.operation, asset });
      if (!decision.allowed) return no(403, `Access denied it: ${decision.reason}. A person approves it in Users & access → Access; until then, find another way.`, decision);
      if (user.mintsFor(l.form, asset)) return loaded(`${s.text}\n\nAccess allowed it: ${decision.reason}.\n${mintedLinkText(l.form, l.operation, said)}`, decision);
      // The secrets given for this skill (issue #583); else, as before it, every secret of the template given for none.
      const tagged = box.secrets.filter((x) => x.skill === s.name);
      const secrets = tagged.length > 0 ? tagged : box.secrets.filter((x) => x.skill === undefined);
      if (secrets.length === 0) {
        if (s.credential) return ask(s, s.credential, decision);
        return no(403, `Access allows it, but template ${box.template} may be given no vault secret: a person adds one to the template in Vault and approves it.`, decision);
      }
      const notes = tagged.filter((x) => x.note).map((x) => `${x.name}: the user says: ${x.note}`).join('\n');
      return loaded(`${s.text}\n\nAccess allowed it: ${decision.reason}.\n${linkText(l.form, secrets)}${notes ? `\n${notes}` : ''}`, decision);
    }
  }
}

/**
 * Why a sandbox ask says, and its plan (issue #1001); or why it cannot be taken. `why` is required; `plan` too when a
 * need changes an asset. Needs that cannot be read are left to the template request, which says why.
 */
function aboutOf(skill: string, why: string | undefined, plan: string | undefined, needs: string | undefined): AskAbout | string {
  const purpose = why?.trim() ?? '', steps = plan?.trim() ?? '';
  if (!purpose) return `say why the job needs this sandbox, in one or two sentences, for the person who approves it: sh "$HOPPER_SKILL" ${skill} --why "Create the cluster role for X in namespace identity" --needs "…"`;
  if (purpose.length > PURPOSE_MAX) return `--why is at most ${PURPOSE_MAX} characters: one or two sentences`;
  if (steps.length > PLAN_MAX) return `--plan is at most ${PLAN_MAX} characters`;
  const read = needsOf(needs);
  if (!steps && typeof read !== 'string' && read.some((p) => p.operation !== 'read')) {
    return `a need changes an asset: say what the box will do with --plan "<the commands or the plan; for each change, what it changes (resource names) and whether it can be undone>"`;
  }
  return { purpose, ...(steps ? { plan: steps } : {}) };
}
