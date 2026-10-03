// job-hopper UI: watches the daemon over HTTP + SSE. No framework, no build.
// All data reaches the DOM through el()/textContent, never innerHTML.

const CAP = { events: 500, decisions: 100, deliveries: 100 };
const state = {
  health: null, queue: { waiting: [], running: [], waitingAnswer: [], counts: {} }, machines: [],
  decisions: [], questions: [], drafts: {}, sending: {}, qerrors: {}, events: [], deliveries: [], subscriptions: [], webhookConfig: null, sources: [], authed: false, conn: 'reconnecting', filter: '',
};
const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
  return n;
}
const mono = (t) => el('code', null, t);
const pill = (t, cls) => el('span', { class: 'pill ' + (cls || '') }, t);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');
const pct = (f) => Math.max(0, Math.min(100, f * 100));
const compact = (v) => JSON.stringify(v ?? {});
const family = (type) => 'fam-' + String(type).split('.')[0].replace('jev_mode', 'jev');
const fill = (id, nodes, empty) => {
  const body = $(id).querySelector('.body');
  body.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'empty' }, empty)]));
};
const count = (id, n) => { $(id).querySelector('.count').textContent = n ? `(${n})` : ''; };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.status + ' ' + path);
  return body;
}
// ---- UI session: mutations only through /ui/api/*, POST JSON + x-jobhopper-session ----

const TOKEN_KEY = 'jh_session';
const LOGIN_CMD = 'bash ~/.local/lib/job-hopper/scripts/open-ui.sh';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: stay read-only */ } };
function setAuthed(on) {
  if (state.authed === on) return;
  state.authed = on;
  renderAll();
}
async function mutate(path, body) {
  const token = readToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jobhopper-session': token ?? '' },
    body: JSON.stringify(body ?? {}),
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 403) { clearToken(); setAuthed(false); throw new Error(out.error || 'session rejected'); }
  if (!res.ok) throw new Error(out.error || res.status + ' ' + path);
  return out;
}
async function act(path, body) {
  try { await mutate(path, body); } catch (e) { window.alert(e.message); }
}
async function checkSession() {
  const token = readToken();
  if (!token) return setAuthed(false);
  try {
    const res = await fetch('/ui/api/session', { headers: { 'x-jobhopper-session': token } });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.authenticated) clearToken();
    setAuthed(res.ok && out.authenticated === true);
  } catch { /* daemon unreachable: keep the current mode */ }
}
async function logout() {
  try { await mutate('/ui/api/logout', {}); } catch { /* already gone */ }
  clearToken(); setAuthed(false);
}
function renderBanner() {
  const b = $('banner');
  b.hidden = state.authed;
  b.replaceChildren(...(state.authed ? [] : ['Read-only. To act, run: ', mono(LOGIN_CMD)]));
}

// ---- panels ------------------------------------------------------------------------

function renderHeader() {
  const h = state.health;
  const mode = h?.jevMode;
  const next = mode === 'active' ? 'shadow' : 'active';
  const counts = Object.entries(state.queue.counts || {}).filter(([, n]) => n > 0);
  $('header').replaceChildren(
    el('span', { class: 'title' }, 'job-hopper'),
    el('span', { class: 'kv' }, 'Jev mode ', el('b', null, mode ?? '?'), ' ',
      mode && state.authed && el('button', { onclick: () => act('/ui/api/jev', { mode: next }).then(refreshHealth) }, 'switch to ' + next)),
    el('span', { class: 'kv' }, 'advisor ', el('b', null, h?.advisor ?? '?')),
    el('span', { class: 'kv' }, 'uptime ', el('b', null, h ? fmtUptime(h.uptimeS) : '?')),
    el('span', { class: 'kv' }, counts.length ? counts.map(([s, n]) => `${s} ${n}`).join(' · ') : 'no jobs'),
    state.authed && el('button', { onclick: logout }, 'logout'),
    el('span', { class: 'pill ' + state.conn, style: 'margin-left:auto' }, el('span', { class: 'dot' }), state.conn === 'live' ? 'live' : 'reconnecting'),
  );
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(s)}s`;
}

function usageBar(r) {
  const f = r.limit > 0 ? r.used / r.limit : 0;
  const cls = f >= 0.95 ? 'hard' : f >= 0.7 ? 'soft' : '';
  return el('div', { class: 'row' },
    mono(r.source + (r.machineId ? ' @' + r.machineId : '')),
    el('div', { class: 'bar ' + cls }, el('i', { style: `width:${pct(f)}%` })),
    el('span', null, `${r.used}/${r.limit} ${r.unit} (${Math.round(f * 100)}%)`),
    r.resetsAt && el('span', { class: 'muted' }, 'resets ' + time(r.resetsAt)));
}
function renderMachines() {
  fill('machines', state.machines.map((m) => el('div', { class: 'machine' },
    el('div', { class: 'row' }, el('b', null, m.label || m.id), mono(m.id),
      pill(m.online ? 'online' : 'offline', m.online ? 'ok' : 'bad'),
      el('span', { class: 'muted' }, `max ${m.maxLanes} lanes · ${m.lanes.length} open · runs ${m.executors.join(', ')}`)),
    m.usage.map(usageBar),
    el('div', { class: 'lanes' }, m.lanes.length ? m.lanes.map((l) => el('span', { class: 'lane ' + l.state, title: l.id },
      l.id.split('/').pop() + ' ' + l.state + (l.jobId ? ' ' + l.jobId : ''))) : el('span', { class: 'muted' }, 'no lanes open')))),
  'no machines');
}

function issueLink(job) {
  const s = job?.source;
  if (!s?.url) return null;
  const text = s.repo && s.number != null ? `${s.repo}#${s.number}` : (s.title || s.key);
  return el('a', { class: 'issue', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.title }, text);
}
function jobLabel(j) {
  return [mono(j.id), issueLink(j), j.spec.goal && el('span', null, j.spec.goal), el('span', { class: 'muted' }, j.spec.executor + (j.spec.submittedBy ? ' · ' + j.spec.submittedBy : ''))];
}
function renderQueue() {
  const effective = new Map();
  for (const s of state.decisions[0]?.start ?? []) effective.set(s.jobId, s.effectivePriority);
  fill('queue', state.queue.waiting.map((j) => el('div', { class: 'row' },
    jobLabel(j), pill(j.status, j.status === 'held' ? 'warn' : ''),
    el('span', null, 'prio ' + j.priority + (effective.has(j.id) ? ' (eff ' + effective.get(j.id) + ')' : '')),
    j.approved && pill('approved', 'ok'),
    j.holdReason && el('span', { class: 'muted' }, j.holdReason),
    j.jevAdvice && el('span', { title: j.jevAdvice.reason }, 'jev: ', el('b', null, j.jevAdvice.action), el('span', { class: 'muted' }, ' ' + j.jevAdvice.source)),
    el('span', { style: 'margin-left:auto' },
      state.authed && !j.approved && el('button', { onclick: () => act(`/ui/api/jobs/${j.id}/approve`).then(refreshLive) }, 'Approve'), ' ',
      state.authed && el('button', { class: 'danger', onclick: () => act(`/ui/api/jobs/${j.id}/cancel`).then(refreshLive) }, 'Cancel')))),
  'nothing waiting');
  const wa = state.queue.waitingAnswer ?? [];
  if (wa.length) {
    const body = $('queue').querySelector('.body');
    if (body.querySelector('.empty')) body.replaceChildren();
    body.append(el('div', { class: 'sec' }, el('h3', null, 'waiting for answer'),
      wa.map((j) => el('div', { class: 'row' }, jobLabel(j), pill('waiting_answer', 'warn'), j.questionId && mono(j.questionId),
        state.authed && el('button', { class: 'danger', onclick: () => act(`/ui/api/jobs/${j.id}/cancel`).then(refreshLive) }, 'Cancel')))));
  }
  count('queue', state.queue.waiting.length + wa.length);
}
function renderRunning() {
  fill('running', state.queue.running.map((j) => el('div', { class: 'row' },
    jobLabel(j), pill(j.status), j.laneId && mono(j.laneId),
    el('div', { class: 'bar prog' }, el('i', { style: `width:${pct(j.progress ?? 0)}%` })),
    el('span', { class: 'muted' }, Math.round(pct(j.progress ?? 0)) + '%' + (j.progressMessage ? ' ' + j.progressMessage : '')),
    state.authed && el('button', { class: 'danger', onclick: () => act(`/ui/api/jobs/${j.id}/cancel`).then(refreshLive) }, 'Cancel'))),
  'nothing running');
  count('running', state.queue.running.length);
}

// ---- questions ---------------------------------------------------------------------

const mark = (ok) => el('span', { class: ok ? 'ok-t' : 'bad-t' }, ok ? '✓' : '✗');
function duration(a) {
  if (!a.finishedAt) return '';
  const s = Math.max(0, (new Date(a.finishedAt) - new Date(a.startedAt)) / 1000);
  return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's';
}
function countdown(iso) {
  const s = Math.floor((new Date(iso) - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return 'in ' + (h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`);
}
function attemptRow(a) {
  return el('div', { class: 'attempt' },
    pill(a.tier, 'tier-' + a.tier), a.model && mono(a.model),
    pill(a.outcome, a.outcome === 'accepted' ? 'ok' : 'warn'),
    a.confident != null && el('span', null, 'confident ', mark(a.confident)),
    a.risky != null && el('span', null, 'risky ', mark(a.risky)),
    (a.riskRules ?? []).map((r) => pill(r, 'bad')),
    a.finishedAt && el('span', { class: 'muted' }, duration(a)),
    a.answer && el('pre', { class: 'ans' }, a.answer),
    a.reason && el('span', { class: 'muted' }, a.reason),
    a.error && el('span', { class: 'err' }, a.error));
}
async function sendAnswer(q) {
  const text = (state.drafts[q.id] ?? '').trim();
  if (!text || state.sending[q.id] || !state.authed) return;
  state.sending[q.id] = true; delete state.qerrors[q.id]; renderQuestions();
  try {
    await mutate(`/ui/api/questions/${encodeURIComponent(q.id)}/answer`, { answer: text });
    delete state.drafts[q.id];
  } catch (e) { state.qerrors[q.id] = e.message; }
  delete state.sending[q.id];
  await refreshQuestions().catch(() => {});
  refreshSoon();
}
function questionCard(q, job) {
  const sending = !!state.sending[q.id];
  const box = el('textarea', { rows: 3, placeholder: 'Answer to type into the job (Ctrl/Cmd+Enter to send)', disabled: sending,
    'data-qid': q.id, oninput: (ev) => { state.drafts[q.id] = ev.target.value; },
    onkeydown: (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sendAnswer(q); } } });
  box.value = state.drafts[q.id] ?? '';
  const lines = q.recentOutput.split('\n');
  const tail = lines.slice(-40).join('\n');
  return el('div', { class: 'question', 'data-qid': q.id },
    el('div', { class: 'row' }, mono(q.jobId), issueLink(job), job?.spec.goal && el('b', null, job.spec.goal), mono(q.id),
      pill(q.tier, 'tier-' + q.tier), pill('detected: ' + q.detectedBy),
      el('span', { class: 'muted' }, 'asked ' + time(q.createdAt)),
      q.tier === 'human' && el('span', null, `notified ${q.notifyCount}×`),
      q.tier === 'human' && q.expiresAt && el('span', { class: 'warn-t', title: q.expiresAt }, 'expires ', el('span', { class: 'cd', 'data-exp': q.expiresAt }, countdown(q.expiresAt)))),
    el('pre', { class: 'qtext' }, q.text),
    el('details', { class: 'sec', 'data-key': 'out-' + q.id },
      el('summary', { class: 'muted' }, `recent output (${Math.min(lines.length, 40)} of ${lines.length} lines)`), el('pre', null, tail)),
    q.attempts.length ? el('div', { class: 'sec' }, el('h3', null, 'escalation trail'), q.attempts.map(attemptRow)) : null,
    state.authed ? el('div', { class: 'answerbox' }, box,
      el('button', { class: 'primary', disabled: sending, onclick: () => sendAnswer(q) }, sending ? 'Sending…' : 'Send answer'),
      state.qerrors[q.id] && el('span', { class: 'err' }, state.qerrors[q.id])) : null);
}
function renderQuestions() {
  const panel = $('questions');
  const active = document.activeElement;
  const focus = active?.matches?.('#questions textarea') ? { id: active.dataset.qid, s: active.selectionStart, e: active.selectionEnd } : null;
  const openOut = new Set([...panel.querySelectorAll('details[open]')].map((n) => n.dataset.key));
  const jobs = new Map([...(state.queue.waitingAnswer ?? []), ...state.queue.running, ...state.queue.waiting].map((j) => [j.id, j]));
  const open = state.questions;
  panel.classList.toggle('attention', open.length > 0);
  count('questions', open.length);
  const body = panel.querySelector('.body');
  if (!open.length) { body.replaceChildren(el('div', { class: 'empty' }, 'no open questions')); return; }
  body.replaceChildren(...open.map((q) => {
    const c = questionCard(q, jobs.get(q.jobId));
    for (const d of c.querySelectorAll('details')) if (openOut.has(d.dataset.key)) d.open = true;
    return c;
  }));
  if (focus) {
    const t = body.querySelector(`textarea[data-qid="${CSS.escape(focus.id)}"]`);
    if (t && !t.disabled) { t.focus(); t.setSelectionRange(focus.s, focus.e); }
  }
}
setInterval(() => {
  for (const n of document.querySelectorAll('#questions .cd, #sources .cd')) n.textContent = countdown(n.dataset.exp);
}, 1000);

function section(title, nodes) {
  return nodes.length ? el('div', { class: 'sec' }, el('h3', null, title), nodes) : null;
}
function renderDecision(d) {
  const div = d.jev.length > 0;
  const jobs = new Map([...(state.queue.waitingAnswer ?? []), ...state.queue.running, ...state.queue.waiting].map((j) => [j.id, j]));
  return el('details', { class: 'decision' + (div ? ' div' : ''), 'data-id': d.id },
    el('summary', null, mono(d.id), el('span', { class: 'muted' }, time(d.at)), pill(d.trigger), pill(d.jevMode, d.jevMode === 'active' ? 'warn' : ''),
      el('span', null, `${d.start.length} start · ${d.hold.length} hold`), div && pill(d.jev.length + ' jev divergence', 'warn')),
    section('Lane plans', d.lanes.map((p) => el('div', null, mono(p.machineId), ` current ${p.current} → target ${p.target}, open ${p.open}, close ${p.close.length}, drain ${p.drain.length} — `, p.reason))),
    section('Starts', d.start.map((s) => el('div', null, mono(s.jobId), ' ', issueLink(jobs.get(s.jobId)), ` → ${s.machineId}/${s.laneId ?? 'new lane'} eff ${s.effectivePriority} — `, s.reason))),
    section('Holds', d.hold.map((h) => el('div', null, mono(h.jobId), ' — ', h.reason))),
    section('Jev divergences', d.jev.map((j) => el('div', { class: 'diverge' }, mono(j.jobId), ` ${j.advice}: native ${j.native}, with Jev ${j.withJev} — `, j.note))),
    section('Reasons', d.reasons.map((r) => el('div', null, '· ' + r))),
    el('details', { class: 'sec' }, el('summary', { class: 'muted' }, 'raw inputs'), el('pre', null, JSON.stringify(d.inputs, null, 2))));
}
function renderDecisions() {
  const open = new Set([...document.querySelectorAll('#decisions details.decision[open]')].map((n) => n.dataset.id));
  fill('decisions', state.decisions.map((d) => {
    const n = renderDecision(d);
    if (open.has(d.id)) n.open = true;
    return n;
  }), 'no decisions yet');
  count('decisions', state.decisions.length);
}

// ---- sources -----------------------------------------------------------------------

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}
const SOURCE_PILL = { ok: 'ok', error: 'bad', disabled: '', starting: 'warn' };
const list = (v) => (Array.isArray(v) ? v.join(', ') : String(v));
function sourceDetail(d) {
  const rows = [];
  for (const k of ['owners', 'repos', 'authors', 'label']) {
    if (d[k] != null && list(d[k]) !== '') rows.push(el('span', { class: 'muted' }, `${k}: ${list(d[k])}`));
  }
  for (const k of ['projectErrors', 'permanentErrors']) {
    const v = d[k];
    const empty = v == null || (typeof v === 'object' && Object.keys(v).length === 0);
    if (!empty) rows.push(el('span', { class: 'err' }, `${k}: ${typeof v === 'object' ? compact(v) : v}`));
  }
  return rows;
}
function sourceRow(s) {
  return el('div', { class: 'src', 'data-name': s.name },
    el('div', { class: 'row' }, el('b', null, s.name), mono(s.kind), pill(s.state, SOURCE_PILL[s.state] ?? ''),
      el('span', { class: 'muted' }, 'last sync ', el('span', { title: s.lastSyncAt }, ago(s.lastSyncAt))),
      s.nextSyncAt && el('span', { class: 'muted' }, 'next ', el('span', { class: 'cd', 'data-exp': s.nextSyncAt }, countdown(s.nextSyncAt))),
      el('span', null, `${s.itemsSeen} seen · ${s.jobsCreated} created · ${s.activeJobs} active`)),
    s.lastError && el('div', { class: 'err wrap' }, s.lastError),
    el('div', { class: 'row detail' }, sourceDetail(s.detail ?? {})));
}
function renderSources() {
  fill('sources', state.sources.map(sourceRow), 'no sources');
  count('sources', state.sources.length);
}
function upsertSource(s) {
  const i = state.sources.findIndex((x) => x.name === s.name);
  if (i >= 0) state.sources[i] = s; else state.sources.push(s);
  renderSources();
}

function renderEvents() {
  const f = state.filter.trim().toLowerCase();
  const shown = state.events.filter((e) => !f || e.type.includes(f));
  fill('events', shown.map((e) => el('div', { class: 'ev' },
    mono('#' + e.seq), el('span', { class: 'muted' }, time(e.at)), el('span', null, el('b', { class: family(e.type) }, e.type), e.schemaVersion != null && el('span', { class: 'muted sv' }, ' v' + e.schemaVersion)),
    mono(e.jobId ?? e.laneId ?? e.machineId ?? e.decisionId ?? ''), el('span', { class: 'data', title: compact(e.data) }, compact(e.data)))),
  'no events');
  count('events', shown.length);
}

function webhookConfigRow() {
  const c = state.webhookConfig;
  if (!c) return null;
  return el('div', { class: 'cfg' },
    el('span', null, 'config ', mono(c.path ?? '?')),
    c.loadedAt && el('span', { class: 'muted' }, 'loaded ' + time(c.loadedAt)),
    c.error && el('span', { class: 'err' }, 'error: ' + c.error),
    (c.warnings ?? []).map((w) => el('span', { class: 'warn-t' }, 'warning: ' + w)),
    state.subscriptions.map((s) => pill(s.name ?? s.id, s.active === false ? 'warn' : 'ok')));
}
function renderDeliveries() {
  const subs = new Map(state.subscriptions.map((s) => [s.id, s]));
  fill('deliveries', state.deliveries.map((d) => el('div', { class: 'dl' },
    el('span', { title: subs.get(d.subscriptionId)?.url }, mono(subs.get(d.subscriptionId)?.name ?? subs.get(d.subscriptionId)?.url ?? d.subscriptionId)),
    el('b', { class: family(d.eventType) }, d.eventType),
    pill(d.status, d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'),
    el('span', null, d.attempts + ' attempts'), el('span', null, d.lastStatusCode ?? ''),
    el('span', { class: 'muted' }, d.lastError ?? ''),
    el('span', { class: 'muted' }, d.nextAttemptAt ? 'next ' + time(d.nextAttemptAt) : ''))),
  'no deliveries');
  const cfg = webhookConfigRow();
  if (cfg) $('deliveries').querySelector('.body').prepend(cfg);
  count('deliveries', state.deliveries.length);
}

const renderAll = () => { renderBanner(); renderHeader(); renderMachines(); renderQueue(); renderRunning(); renderQuestions(); renderSources(); renderDecisions(); renderEvents(); renderDeliveries(); };

// ---- data --------------------------------------------------------------------------

async function refreshHealth() { state.health = await api('/api/health'); renderHeader(); }
async function refreshQuestions() {
  state.questions = (await api('/api/questions?status=open')).questions;
  renderQuestions();
}
async function refreshLive() {
  const [queue, machines] = await Promise.all([api('/api/queue'), api('/api/machines')]);
  state.queue = queue; state.machines = machines.machines;
  renderHeader(); renderMachines(); renderQueue(); renderRunning(); renderQuestions();
}
let timer = null;
let qtimer = null;
const refreshQuestionsSoon = () => { clearTimeout(qtimer); qtimer = setTimeout(() => refreshQuestions().catch(() => {}), 150); };
const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(() => refreshLive().catch(() => {}), 150); };
const prepend = (list, item, cap) => { list.unshift(item); if (list.length > cap) list.length = cap; };

function upsertDelivery(d) {
  const i = state.deliveries.findIndex((x) => x.id === d.id);
  if (i >= 0) state.deliveries[i] = d; else prepend(state.deliveries, d, CAP.deliveries);
  renderDeliveries();
}

function onDomainEvent(msg) {
  const e = JSON.parse(msg.data);
  if (state.events.some((x) => x.seq === e.seq)) return;
  prepend(state.events, e, CAP.events);
  renderEvents();
  refreshSoon();
  if (e.type.startsWith('question.')) refreshQuestionsSoon();
  if (e.type === 'jev.mode_changed') refreshHealth().catch(() => {});
  if (e.type === 'decision.made') {
    const id = e.decisionId ?? e.data.decisionId;
    api('/api/decisions/' + encodeURIComponent(id)).then((d) => {
      if (state.decisions.some((x) => x.id === d.id)) return;
      prepend(state.decisions, d, CAP.decisions);
      renderDecisions(); renderQueue();
    }).catch(() => {});
  }
}

function connect(afterSeq) {
  let last = afterSeq;
  const es = new EventSource('/api/events/stream?after=' + last);
  es.onopen = () => { state.conn = 'live'; renderHeader(); refreshLive().catch(() => {}); refreshQuestions().catch(() => {}); };
  es.onerror = () => { state.conn = 'reconnecting'; renderHeader(); };
  es.addEventListener('delivery.updated', (m) => upsertDelivery(JSON.parse(m.data)));
  es.addEventListener('source.updated', (m) => upsertSource(JSON.parse(m.data)));
  const types = ['job.queued', 'job.prioritized', 'job.reprioritized', 'job.held', 'job.approved', 'job.claimed', 'job.started', 'job.progressed', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued', 'lane.opened', 'lane.closed', 'decision.made', 'jev.mode_changed', 'question.asked', 'question.escalated', 'question.answered', 'question.expired'];
  for (const t of types) es.addEventListener(t, onDomainEvent);
  setInterval(() => refreshHealth().catch(() => {}), 10000);
  setInterval(renderSources, 15000);
}

async function init() {
  $('event-filter').addEventListener('input', (ev) => { state.filter = ev.target.value; renderEvents(); });
  renderAll();
  await checkSession();
  const [health, queue, machines, decisions, events, subs, deliveries, questions, sources] = await Promise.all([
    api('/api/health'), api('/api/queue'), api('/api/machines'), api('/api/decisions?limit=50'),
    api('/api/events?limit=200'), api('/api/webhooks'), api('/api/webhooks/deliveries?limit=100'), api('/api/questions?status=open'), api('/api/sources'),
  ]);
  state.health = health; state.queue = queue; state.machines = machines.machines;
  state.decisions = decisions.decisions; state.questions = questions.questions;
  state.events = events.events.slice().sort((a, b) => b.seq - a.seq);
  state.subscriptions = subs.subscriptions; state.webhookConfig = subs.config ?? null; state.sources = sources.sources; state.deliveries = deliveries.deliveries;
  renderAll();
  connect(state.events[0]?.seq ?? 0);
}
init().catch((e) => { state.conn = 'reconnecting'; renderHeader(); $('machines').querySelector('.body').replaceChildren(el('div', { class: 'empty' }, 'load failed: ' + e.message)); });
