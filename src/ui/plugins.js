// The Plugins panel (design.md "UI and mutation"): per role, the configured instances, each with its
// own options form; command-bearing options are shown, never edited (plugins.yaml only). One Save
// sends one instance's options. Unsaved edits survive re-renders, keyed by role and instance name.

const ROLE_TITLES = {
  router: 'Router', answerer: 'Answerer', assessor: 'Assessor', executor: 'Executors',
  'job-source': 'Job sources', 'machine-source': 'Machine source', 'usage-source': 'Usage sources', notifier: 'Notifiers',
};
/** The restart roles, by their key in GET /api/plugins. */
const RESTART = { executor: 'executors', 'job-source': 'jobSources', 'machine-source': 'machines', 'usage-source': 'usageSources', notifier: 'notifiers' };
const SELECTABLE = ['router', 'answerer', 'assessor'];
const drafts = {}; // `${role}:${name}` → { key: raw input value }
const errors = {}; // `${role}:${name}` or `select:${role}` → message
let busy = false;

/** True while any form holds unsaved edits: a background refresh must not redraw it away. */
export const hasDrafts = () => Object.values(drafts).some((d) => Object.keys(d).length > 0);

/** @param {HTMLElement} body @param {{ report: any, authed: boolean, el: Function, mono: Function, pill: Function, send: (b: object) => Promise<any>, onReport: (r: any) => void, reload: () => Promise<void> }} ui */
export function renderPlugins(body, ui) {
  const { report, el } = ui;
  if (!report) { body.replaceChildren(el('div', { class: 'empty' }, 'loading…')); return; }
  const kids = [configRow(report, ui)];
  for (const role of report.roles) kids.push(roleBlock(role, report, ui));
  for (const e of report.errors) kids.push(el('div', { class: 'cfg err' }, `refused plugin ${e.path}: ${e.error}`));
  for (const w of report.warnings) kids.push(el('div', { class: 'cfg warn-t' }, w));
  body.replaceChildren(...kids);
}

function configRow(report, ui) {
  const { el, mono, pill } = ui;
  const c = report.config;
  return el('div', { class: 'cfg' },
    'plugins.yaml ', mono(c.path), ' ', pill(c.source === 'file' ? 'from file' : 'no file: defaults', c.source === 'file' ? 'ok' : 'neutral'),
    c.loadedAt && el('span', { class: 'muted' }, 'loaded ' + new Date(c.loadedAt).toLocaleTimeString()),
    c.error && el('span', { class: 'err' }, c.error),
    ...c.warnings.map((w) => el('span', { class: 'warn-t' }, w)),
    ui.authed && el('button', { style: 'margin-left:auto', disabled: busy, onclick: () => run(ui, { action: 'rescan' }, 'rescan') }, 'Rescan'));
}

const pluginsOf = (report, role) => report.plugins.filter((p) => p.role === role);
const schemaOf = (report, id) => report.plugins.find((p) => p.id === id)?.options;

function status(report, role, name) {
  if (RESTART[role]) {
    const s = report[RESTART[role]].instances.find((i) => i.instance.name === name);
    return s ? { active: s.active, fallback: false, reason: s.reason, detection: s.detection } : { pending: true };
  }
  const s = report[role];
  return s && s.instance?.name === name ? s : { pending: true };
}

function roleBlock(role, report, ui) {
  const { el, pill } = ui;
  const instances = report.instances.filter((i) => i.role === role);
  const pending = RESTART[role] && report[RESTART[role]].pending;
  return el('div', { class: 'role' },
    el('h3', null, ROLE_TITLES[role] ?? role, ' ', pending && pill('changed — restart pending', 'warn'),
      SELECTABLE.includes(role) && el('span', { class: 'muted' }, role === 'router' ? `(${report.router.selection})` : '')),
    SELECTABLE.includes(role) && ui.authed && selector(role, instances[0], report, ui),
    ...(instances.length ? instances.map((i) => instanceCard(role, i.instance, report, ui)) : [el('div', { class: 'empty' }, role === 'answerer' ? 'none — questions go straight to the owner' : 'none')]),
  );
}

function selector(role, current, report, ui) {
  const { el } = ui;
  const key = 'select:' + role;
  const choices = pluginsOf(report, role);
  const sel = el('select', null,
    ...(role === 'answerer' ? [el('option', { value: '', selected: !current }, 'none')] : []),
    ...choices.map((p) => el('option', {
      value: p.id, selected: current?.instance.plugin === p.id, disabled: p.detection.status !== 'available',
    }, `${p.id}${p.builtin ? '' : ' (custom)'} — ${p.detection.status}`)));
  return el('div', { class: 'cfg' },
    el('span', { class: 'muted' }, 'plugin'), sel,
    el('button', { disabled: busy, onclick: () => run(ui, { action: 'select', role, plugin: sel.value || null, version: report.config.version }, key) }, 'Use'),
    errors[key] && el('span', { class: 'err' }, errors[key]));
}

function instanceCard(role, inst, report, ui) {
  const { el, mono, pill } = ui;
  const key = `${role}:${inst.name}`;
  const s = status(report, role, inst.name);
  const schema = schemaOf(report, inst.plugin);
  const props = Object.entries(schema?.properties ?? {});
  const current = inst.options ?? {};
  const draft = (drafts[key] ??= {});
  const state = s.pending ? pill('restart pending', 'warn')
    : s.active === null ? pill('cannot run', 'bad')
    : s.fallback ? pill('fallback: ' + s.active, 'warn') : pill('active', 'ok');
  const fields = props.map(([name, p]) => field(name, p, current, draft, ui));
  return el('div', { class: 'inst' },
    el('div', { class: 'row' }, el('b', null, inst.name), mono(inst.plugin), state,
      s.reason && el('span', { class: 'muted wrap' }, s.reason),
      s.detection && s.detection.status !== 'available' && el('span', { class: 'muted wrap' }, `${s.detection.status}: ${s.detection.reason}`)),
    fields.length ? el('div', { class: 'opts' }, ...fields) : el('div', { class: 'muted' }, 'no options'),
    ui.authed && fields.length > 0 && el('div', { class: 'cfg' },
      el('button', { class: 'primary', disabled: busy, onclick: () => save(role, inst, schema, report, ui) }, 'Save ' + inst.name),
      Object.keys(draft).length > 0 && el('button', { disabled: busy, onclick: () => { delete drafts[key]; delete errors[key]; ui.onReport(report); } }, 'Discard'),
      errors[key] && el('span', { class: 'err wrap' }, errors[key])),
  );
}

const shown = (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const isStringList = (p) => p.type === 'array' && p.items?.type === 'string';

function field(name, p, current, draft, ui) {
  const { el, mono } = ui;
  const label = el('label', { title: p.description ?? '' }, name, p.description && el('span', { class: 'muted' }, ' — ' + p.description));
  if (p.commandBearing) {
    const v = name in current ? current[name] : p.default;
    return el('div', { class: 'opt' }, label,
      el('div', null, mono(shown(v) || '—'), ' ', !(name in current) && el('span', { class: 'muted' }, 'default'),
        el('span', { class: 'tag', title: 'names a program, its arguments, a directory or an executed file' }, 'plugins.yaml only')));
  }
  const readOnly = !ui.authed;
  const value = name in draft ? draft[name] : name in current ? current[name] : undefined;
  const set = (v) => { draft[name] = v; };
  let input;
  if (p.type === 'boolean') {
    input = el('input', { type: 'checkbox', checked: (value ?? p.default) === true, disabled: readOnly, onchange: (e) => set(e.target.checked) });
  } else if (Array.isArray(p.enum)) {
    input = el('select', { disabled: readOnly, onchange: (e) => set(e.target.value) },
      el('option', { value: '', selected: value === undefined || value === '' }, p.default !== undefined ? `default (${p.default})` : '—'),
      ...p.enum.map((v) => el('option', { value: v, selected: value === v }, v)));
  } else if (p.type === 'number' || p.type === 'integer') {
    input = el('input', { type: 'number', value: shown(value), placeholder: shown(p.default), disabled: readOnly, oninput: (e) => set(e.target.value) });
  } else if (p.type === 'string') {
    input = el('input', { type: 'text', value: shown(value), placeholder: shown(p.default), disabled: readOnly, oninput: (e) => set(e.target.value) });
  } else {
    const text = isStringList(p) && Array.isArray(value) ? value.join('\n') : shown(value);
    input = el('textarea', { rows: 2, placeholder: isStringList(p) ? 'one per line' : 'JSON', disabled: readOnly, oninput: (e) => set(e.target.value) });
    input.value = text;
  }
  return el('div', { class: 'opt' }, label, input);
}

/** The instance's whole options object: drafts over what is configured, command-bearing as configured. */
function collect(inst, schema, draft) {
  const current = inst.options ?? {};
  const props = schema?.properties ?? {};
  const out = Object.fromEntries(Object.entries(current).filter(([k]) => !(k in props)));
  for (const [k, p] of Object.entries(props)) {
    if (p.commandBearing || !(k in draft)) { if (k in current) out[k] = current[k]; continue; }
    const raw = draft[k];
    if (raw === '' || raw === undefined) continue;
    if (p.type === 'boolean') out[k] = raw === true;
    else if (p.type === 'number' || p.type === 'integer') out[k] = Number(raw);
    else if (p.type === 'string' || Array.isArray(p.enum)) out[k] = raw;
    else if (isStringList(p)) out[k] = String(raw).split('\n').map((l) => l.trim()).filter(Boolean);
    else {
      try { out[k] = JSON.parse(raw); } catch { throw new Error(`${k}: not valid JSON`); }
    }
  }
  return out;
}

async function save(role, inst, schema, report, ui) {
  const key = `${role}:${inst.name}`;
  let options;
  try { options = collect(inst, schema, drafts[key] ?? {}); } catch (e) { errors[key] = e.message; ui.onReport(report); return; }
  await run(ui, { action: 'options', role, name: inst.name, options, version: report.config.version }, key, () => { delete drafts[key]; });
}

/** Send one edit; on success `saved` runs before the panel redraws from the answer. */
async function run(ui, body, key, saved) {
  busy = true;
  delete errors[key];
  try {
    const next = await ui.send(body);
    busy = false;
    saved?.();
    ui.onReport(next);
  } catch (e) {
    busy = false;
    errors[key] = e.message;
    if (/changed since it was read/.test(e.message)) await ui.reload().catch(() => {});
    else ui.onReport(ui.report);
  }
}
