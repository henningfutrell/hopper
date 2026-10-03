// job-hopper UI: watches the daemon over HTTP + SSE. No framework, no build.
// All data reaches the DOM through el()/textContent, never innerHTML.

const CAP = { events: 500, decisions: 100, deliveries: 100 };
const state = {
  health: null, queue: { waiting: [], running: [], counts: {} }, machines: [],
  decisions: [], events: [], deliveries: [], subscriptions: [], conn: 'reconnecting', filter: '',
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
async function act(path, opts) {
  try { await api(path, opts); } catch (e) { window.alert(e.message); }
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
      mode && el('button', { onclick: () => act('/api/jev', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: next }) }).then(refreshHealth) }, 'switch to ' + next)),
    el('span', { class: 'kv' }, 'advisor ', el('b', null, h?.advisor ?? '?')),
    el('span', { class: 'kv' }, 'uptime ', el('b', null, h ? fmtUptime(h.uptimeS) : '?')),
    el('span', { class: 'kv' }, counts.length ? counts.map(([s, n]) => `${s} ${n}`).join(' · ') : 'no jobs'),
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

function jobLabel(j) {
  return [mono(j.id), j.spec.goal && el('span', null, j.spec.goal), el('span', { class: 'muted' }, j.spec.executor + (j.spec.submittedBy ? ' · ' + j.spec.submittedBy : ''))];
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
      !j.approved && el('button', { onclick: () => act(`/api/jobs/${j.id}/approve`, { method: 'POST' }).then(refreshLive) }, 'Approve'), ' ',
      el('button', { class: 'danger', onclick: () => act(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(refreshLive) }, 'Cancel')))),
  'nothing waiting');
  count('queue', state.queue.waiting.length);
}
function renderRunning() {
  fill('running', state.queue.running.map((j) => el('div', { class: 'row' },
    jobLabel(j), pill(j.status), j.laneId && mono(j.laneId),
    el('div', { class: 'bar prog' }, el('i', { style: `width:${pct(j.progress ?? 0)}%` })),
    el('span', { class: 'muted' }, Math.round(pct(j.progress ?? 0)) + '%' + (j.progressMessage ? ' ' + j.progressMessage : '')),
    el('button', { class: 'danger', onclick: () => act(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(refreshLive) }, 'Cancel'))),
  'nothing running');
  count('running', state.queue.running.length);
}

function section(title, nodes) {
  return nodes.length ? el('div', { class: 'sec' }, el('h3', null, title), nodes) : null;
}
function renderDecision(d) {
  const div = d.jev.length > 0;
  return el('details', { class: 'decision' + (div ? ' div' : ''), 'data-id': d.id },
    el('summary', null, mono(d.id), el('span', { class: 'muted' }, time(d.at)), pill(d.trigger), pill(d.jevMode, d.jevMode === 'active' ? 'warn' : ''),
      el('span', null, `${d.start.length} start · ${d.hold.length} hold`), div && pill(d.jev.length + ' jev divergence', 'warn')),
    section('Lane plans', d.lanes.map((p) => el('div', null, mono(p.machineId), ` current ${p.current} → target ${p.target}, open ${p.open}, close ${p.close.length}, drain ${p.drain.length} — `, p.reason))),
    section('Starts', d.start.map((s) => el('div', null, mono(s.jobId), ` → ${s.machineId}/${s.laneId ?? 'new lane'} eff ${s.effectivePriority} — `, s.reason))),
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

function renderEvents() {
  const f = state.filter.trim().toLowerCase();
  const shown = state.events.filter((e) => !f || e.type.includes(f));
  fill('events', shown.map((e) => el('div', { class: 'ev' },
    mono('#' + e.seq), el('span', { class: 'muted' }, time(e.at)), el('b', { class: family(e.type) }, e.type),
    mono(e.jobId ?? e.laneId ?? e.machineId ?? e.decisionId ?? ''), el('span', { class: 'data', title: compact(e.data) }, compact(e.data)))),
  'no events');
  count('events', shown.length);
}

function renderDeliveries() {
  const subs = new Map(state.subscriptions.map((s) => [s.id, s]));
  fill('deliveries', state.deliveries.map((d) => el('div', { class: 'dl' },
    el('span', { title: subs.get(d.subscriptionId)?.url }, mono(subs.get(d.subscriptionId)?.url ?? d.subscriptionId)),
    el('b', { class: family(d.eventType) }, d.eventType),
    pill(d.status, d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'),
    el('span', null, d.attempts + ' attempts'), el('span', null, d.lastStatusCode ?? ''),
    el('span', { class: 'muted' }, d.lastError ?? ''),
    el('span', { class: 'muted' }, d.nextAttemptAt ? 'next ' + time(d.nextAttemptAt) : ''))),
  'no deliveries');
  count('deliveries', state.deliveries.length);
}

const renderAll = () => { renderHeader(); renderMachines(); renderQueue(); renderRunning(); renderDecisions(); renderEvents(); renderDeliveries(); };

// ---- data --------------------------------------------------------------------------

async function refreshHealth() { state.health = await api('/api/health'); renderHeader(); }
async function refreshLive() {
  const [queue, machines] = await Promise.all([api('/api/queue'), api('/api/machines')]);
  state.queue = queue; state.machines = machines.machines;
  renderHeader(); renderMachines(); renderQueue(); renderRunning();
}
let timer = null;
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
  es.onopen = () => { state.conn = 'live'; renderHeader(); refreshLive().catch(() => {}); };
  es.onerror = () => { state.conn = 'reconnecting'; renderHeader(); };
  es.addEventListener('delivery.updated', (m) => upsertDelivery(JSON.parse(m.data)));
  const types = ['job.queued', 'job.prioritized', 'job.held', 'job.approved', 'job.claimed', 'job.started', 'job.progressed', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued', 'lane.opened', 'lane.closed', 'decision.made', 'jev.mode_changed'];
  for (const t of types) es.addEventListener(t, onDomainEvent);
  setInterval(() => refreshHealth().catch(() => {}), 10000);
}

async function init() {
  $('event-filter').addEventListener('input', (ev) => { state.filter = ev.target.value; renderEvents(); });
  renderAll();
  const [health, queue, machines, decisions, events, subs, deliveries] = await Promise.all([
    api('/api/health'), api('/api/queue'), api('/api/machines'), api('/api/decisions?limit=50'),
    api('/api/events?limit=200'), api('/api/webhooks'), api('/api/webhooks/deliveries?limit=100'),
  ]);
  state.health = health; state.queue = queue; state.machines = machines.machines;
  state.decisions = decisions.decisions;
  state.events = events.events.slice().sort((a, b) => b.seq - a.seq);
  state.subscriptions = subs.subscriptions; state.deliveries = deliveries.deliveries;
  renderAll();
  connect(state.events[0]?.seq ?? 0);
}
init().catch((e) => { state.conn = 'reconnecting'; renderHeader(); $('machines').querySelector('.body').replaceChildren(el('div', { class: 'empty' }, 'load failed: ' + e.message)); });
