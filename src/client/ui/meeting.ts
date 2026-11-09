import './meeting.css';
import { MEETING_PATTERNS, MEETING_PATTERN_IDS, fixedRounds, meetingSpend, meetingStage, outputProblem, slugify } from '../../shared/meetings';
import { fmtTokens, type DecisionResult, type Meeting, type MeetingPattern, type MeetingTurn } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, toast, STATUS_LABEL, type Modal } from './dom';
import { confirmDialog } from './prompt';
import { providerPicker } from './provider';
import { officePrompt } from './prompts';
import { issueVars } from './github/prompts';
import { dictateField } from './dictate';

/** What a meeting called from an issue, a PR or a task starts out with. */
export interface MeetingPreset {
  pattern?: MeetingPattern;
  prompt?: string;
  title?: string;
  pr?: number;
  issue?: number;
}

export interface MeetingActions {
  openTerminal(workerId: string): void;
  /** Push the meeting's branch and open a pull request for it, through the head of the table's worker. */
  openPr(workerId: string): void;
}

/** A meeting about a GitHub issue: the form filled in with it. */
export function issueMeeting(n: number, title: string): MeetingPreset {
  return { issue: n, title: `#${n} ${title}`, prompt: officePrompt('issue.meeting', issueVars({ number: n, title })) };
}

const PART_LABEL: Record<MeetingTurn['state'], string> = { waiting: '⏳ up next', sent: '📨 handed over', working: '💬 on it', done: '✅ written' };

type DecisionInfo = { type?: string; text?: string; description?: string; options?: { key: string; label: string }[]; approve_label?: string; reject_label?: string; submit_label?: string; cancel_label?: string };
type DecisionUi = { selected: Set<string>; forId: string; submitting: boolean; lastState?: string; poll: ReturnType<typeof setInterval> | null };

async function fetchDecision(id: string): Promise<DecisionResult | null> {
  try {
    const r = await fetch(`/api/telegram/decisions?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && !j.error && j.decision_id ? (j as DecisionResult) : null;
  } catch { return null; }
}
async function resolveDecision(id: string, body: { action: string; selected?: string[]; value?: string }): Promise<{ ok: boolean; error?: string; result?: DecisionResult }> {
  try {
    const r = await fetch(`/api/telegram/decisions/${encodeURIComponent(id)}/resolve`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

/**
 * The meeting room's window. With a meeting at the table it shows how it's going (and stops it, or
 * clears the table once it's over); otherwise, or with a preset from an issue or a PR, it's the form
 * that calls one.
 */
export function openMeeting(net: Net, actions: MeetingActions, preset?: MeetingPreset) {
  void net; // dual-channel 決策走 HTTP/WS store；保留參數相容
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {}, '🤝 Meeting room');
  const body = h('div.body.meeting');
  const foot = h('footer');
  const el = h('div.modal.meeting-window', { role: 'dialog', 'aria-label': 'Meeting room' }, h('header', {}, title, close), body, foot);
  let view: 'status' | 'form' = preset || !store.meeting.current ? 'form' : 'status';
  let form: ReturnType<typeof meetingForm> | null = null;
  const dui: DecisionUi = { selected: new Set(), forId: '', submitting: false, poll: null };
  const stopPoll = () => { if (dui.poll) { clearInterval(dui.poll); dui.poll = null; } };
  const render = () => {
    const decision = store.meeting.current ? store.decisionForMeeting(store.floor, store.meeting.current.id) : undefined;
    if (decision && decision.state !== dui.lastState && dui.lastState && decision.state !== 'pending') {
      const who = decision.from?.includes('office') ? 'Office UI' : decision.from ? 'Telegram/外部' : '其他通道';
      toast(`核准已${decision.state === 'resolved' ? '完成' : decision.state === 'cancelled' ? '取消' : '逾時'}（${who}）`, decision.state === 'resolved' ? 'info' : 'warn');
    }
    dui.lastState = decision?.state;
    if (!decision || decision.state !== 'pending') stopPoll();
    else if (!dui.poll) dui.poll = setInterval(async () => {
      const cur = store.meeting.current ? store.decisionForMeeting(store.floor, store.meeting.current.id) : undefined;
      if (!cur || cur.state !== 'pending') { stopPoll(); render(); return; }
      const fresh = await fetchDecision(cur.decision_id);
      if (fresh) { store.decisions.set(fresh.decision_id, fresh); store.emit('decision'); }
    }, 2500);
    if (view === 'status' && store.meeting.current) {
      form = null;
      title.textContent = '🤝 Meeting room';
      renderStatus(store.meeting.current, body, foot, net, actions, () => { view = 'form'; render(); }, decision, dui, render);
      return;
    }
    if (!form) {
      form = meetingForm(net, preset, () => modal.close(), () => { view = 'status'; render(); });
      title.textContent = '🤝 Call a meeting';
      body.replaceChildren(form.body);
      foot.replaceChildren(...form.foot);
    }
    form.refresh();
  };
  const offs = [store.on('meeting', render), store.on('decision', render), store.on('workers', () => view === 'status' && render()), store.on('pulls', () => form?.refresh())];
  const modal: Modal = openModal(el, { doing: '🤝 at the meeting room', onClose: () => { stopPoll(); offs.forEach((off) => off()); } });
  close.addEventListener('click', () => modal.close());
  render();
}

function renderStatus(m: Meeting, body: HTMLElement, foot: HTMLElement, net: Net, actions: MeetingActions, callAnother: () => void, decision?: DecisionResult, dui?: DecisionUi, rerender?: () => void) {
  const p = MEETING_PATTERNS[m.pattern];
  const running = m.status === 'running';
  const pill = h('span.pill', { class: running ? 'working' : m.status === 'done' ? 'done' : 'needs_input' }, running ? 'in a meeting' : m.status);
  const seats = h(
    'ul.meeting-seats',
    {},
    ...m.seats.map((s, i) => {
      const w = s.workerId ? store.workers.get(s.workerId) : undefined;
      const t = m.turns.find((x) => x.seat === i);
      const part = running ? (t ? `${PART_LABEL[t.state]}: ${t.doing}` : '👂 listening') : '';
      return h(
        'li',
        {},
        h('span.dot', { style: `background:${w?.color ?? '#adb5bd'}` }),
        h('b', {}, s.role),
        h('span.muted', {}, `${i === 0 ? 'head of the table · ' : ''}${s.workerName ?? '…'}`),
        w ? h('span.pill', { class: w.status }, STATUS_LABEL[w.status]) : h('span.pill.exited', {}, 'gone home'),
        part ? h('span.meeting-part', { title: t?.file ?? '' }, part) : null,
        s.tokens ? h('span.muted', {}, `${fmtTokens(s.tokens)} tokens`) : null,
        w ? h('button.btn.small', { type: 'button', onclick: () => actions.openTerminal(w.id) }, '🖥️ Terminal') : null,
      );
    }),
  );
  const where = m.worktree ? h('span', {}, '🌿 ', h('code', {}, m.worktree.branch), m.commit ? ` · committed ${m.commit}` : '') : null;
  const review = m.review?.url ? h('a', { href: m.review.url, target: '_blank', rel: 'noopener noreferrer' }, `🔍 The review on PR #${m.pr} ↗`) : m.review?.error ? h('span.bad', {}, `Couldn't post the review: ${m.review.error}`) : null;
  body.replaceChildren(
    ...present(
    decision && dui && rerender ? renderDecisionPanel(decision, dui, rerender) : null,
    h('div.meeting-head', {}, pill, h('b', {}, `${p.icon} ${p.label}`), h('span.meeting-title', { title: m.prompt }, m.title)),
    h('p.meeting-line', {}, running ? `${meetingStage(m)} · called by ${m.calledBy} ${timeAgo(new Date(m.startedAt).toISOString())}` : m.status === 'done' ? `✅ Wrote ${m.output} in ${m.round} round${m.round === 1 ? '' : 's'}` : `⛔ Stopped in round ${m.round}: ${m.reason ?? 'stopped'}`),
    m.tokens ? h('p.meeting-spend', { title: `${m.tokens.toLocaleString()} tokens, cache reads included` }, `💸 ${meetingSpend(m)}${running ? ' so far' : ''}`) : null,
    seats,
    h('div.meeting-out', {}, h('div.meeting-out-head', {}, h('b', {}, '📄 '), h('code', {}, m.output), where, review), h('pre.meeting-preview', {}, m.preview?.trim() ? m.preview : running ? 'Nothing written yet.' : 'Nothing was written.')),
    store.meeting.past.length
      ? h('details.meeting-past', {}, h('summary', {}, `Earlier meetings (${store.meeting.past.length})`), h('ul', {}, ...store.meeting.past.map((r) => h('li', { title: `Called by ${r.calledBy}` }, h('b', {}, r.title), h('div.muted', {}, r.summary)))))
      : null,
    ),
  );
  const head = m.seats[0]?.workerId ? store.workers.get(m.seats[0].workerId) : undefined;
  foot.replaceChildren(
    ...present(
    h('span.grow', {}, running ? 'The workers stay at the table after it ends, so you can read their terminals.' : 'Clearing the room sends the workers home. A committed output stays on its branch.'),
    running ? h('button.btn', { type: 'button', onclick: () => confirmDialog('Stop the meeting?', `The workers stop where they are and stay at the table. ${m.output} is only there if it was written.`, 'Stop it', () => net.send({ t: 'meeting.stop' })) }, '⛔ Stop meeting') : null,
    !running && m.commit && head?.worktree ? h('button.btn', { type: 'button', title: `Push ${m.worktree?.branch} and open a pull request`, onclick: () => actions.openPr(head.id) }, head.pr ? `🔀 PR #${head.pr.number}` : '🔀 Open PR') : null,
    !running ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'meeting.clear' }) }, '🧹 Clear the room') : null,
    !running ? h('button.btn.primary', { type: 'button', onclick: callAnother }, '🤝 Call a meeting…') : null,
    ),
  );
}

const present = (...xs: (Node | null | undefined | false)[]): Node[] => xs.filter((x): x is Node => x instanceof Node);

function renderDecisionPanel(d: DecisionResult, dui: DecisionUi, rerender: () => void): HTMLElement {
  const info = ((d.metadata as any)?.request || {}) as DecisionInfo;
  const opts = Array.isArray(info.options) ? info.options : [];
  const type = info.type || 'multi';
  const panel = h('section.meeting-decision', { style: 'margin:0 0 12px;padding:12px;border:1px solid rgba(148,163,184,.35);border-radius:10px;background:rgba(15,23,42,.18)' });
  panel.append(h('div', { style: 'font-weight:600;margin-bottom:4px' }, `📣 ${info.text || '核准請求'}`));
  if (info.description) panel.append(h('div.muted', { style: 'margin-bottom:8px;white-space:pre-wrap' }, info.description));
  panel.append(h('div.muted', { style: 'font-size:12px;margin-bottom:8px' }, `decision: ${d.decision_id} · ${d.state}${d.from ? ` · 來源:${d.from}` : ''}`));

  if (d.state !== 'pending') {
    const who = d.from?.includes('office') ? 'Office UI' : d.from ? 'Telegram/外部' : '—';
    panel.append(h('div', {}, `結果：${d.action || d.state}${d.selected?.length ? `（${d.selected.join(', ')}）` : d.value ? `（${d.value}）` : ''} · ${who}`));
    panel.append(h('div.muted', { style: 'font-size:12px;margin-top:4px' }, '已由任一通道完成；此提示面板自動同步。✕/Esc 僅關閉視窗。'));
    return panel;
  }

  if (dui.forId !== d.decision_id) { dui.forId = d.decision_id; dui.selected = new Set(); }
  const realKeys = opts.map(o => o.key).filter(k => k !== '__all__');
  const submit = async (action: string, value?: string) => {
    if (dui.submitting) return;
    dui.submitting = true; rerender();
    const body: any = { action };
    if (action === 'submit') body.selected = [...dui.selected].filter(k => k !== '__all__');
    if (value) body.value = value;
    const res = await resolveDecision(d.decision_id, body);
    dui.submitting = false;
    if (!res.ok && res.error && !/目前狀態/.test(res.error)) toast(res.error, 'warn');
    if (res.result) { store.decisions.set(res.result.decision_id, res.result); store.emit('decision'); }
    else { const fresh = await fetchDecision(d.decision_id); if (fresh) { store.decisions.set(fresh.decision_id, fresh); store.emit('decision'); } }
    rerender();
  };

  if (type === 'multi') {
    const list = h('div', { style: 'display:flex;flex-direction:column;gap:6px;margin:8px 0' });
    for (const o of opts) {
      const checked = o.key === '__all__' ? realKeys.length > 0 && realKeys.every(k => dui.selected.has(k)) : dui.selected.has(o.key);
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = checked; cb.disabled = dui.submitting;
      cb.addEventListener('change', () => {
        if (o.key === '__all__') { if (cb.checked) realKeys.forEach(k => dui.selected.add(k)); else realKeys.forEach(k => dui.selected.delete(k)); }
        else { if (cb.checked) dui.selected.add(o.key); else dui.selected.delete(o.key); }
        rerender();
      });
      list.append(h('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer' }, cb, h('span', {}, o.label)));
    }
    panel.append(list);
  } else if (type === 'pick') {
    const list = h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin:8px 0' });
    for (const o of opts) list.append(h('button.btn', { type: 'button', disabled: dui.submitting, onclick: () => submit('pick', o.key) }, o.label));
    panel.append(list);
  }

  const row = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center' });
  if (type === 'approve') {
    row.append(h('button.btn', { type: 'button', disabled: dui.submitting, onclick: () => submit('approve') }, info.approve_label || '批准'));
    row.append(h('button.btn.ghost', { type: 'button', disabled: dui.submitting, onclick: () => submit('reject') }, info.reject_label || '駁回'));
  } else if (type === 'multi') {
    row.append(h('button.btn', { type: 'button', disabled: dui.submitting, onclick: () => submit('submit') }, info.submit_label || '送出'));
    row.append(h('button.btn.ghost', { type: 'button', disabled: dui.submitting, onclick: () => submit('cancel') }, info.cancel_label || '取消'));
  } else {
    row.append(h('button.btn.ghost', { type: 'button', disabled: dui.submitting, onclick: () => submit('cancel') }, info.cancel_label || '取消'));
  }
  row.append(h('span.muted', { style: 'font-size:12px' }, dui.submitting ? '送出中…' : '可在 Telegram 或此處核准；✕/Esc 僅關閉視窗，不變更決策。'));
  panel.append(row);
  return panel;
}

/** The form that calls a meeting: the pattern, what it's about, who sits down, the output, the round limit. */
function meetingForm(net: Net, preset: MeetingPreset | undefined, done: () => void, back: () => void) {
  let pattern: MeetingPattern = preset?.pattern ?? 'debate';
  let roles: string[] = [];
  let outputTouched = false;
  const patterns = h('div.meeting-patterns', { role: 'radiogroup', 'aria-label': 'Pattern' });
  const about = h('textarea', { rows: 4, placeholder: 'The question to settle, or the task to do: e.g. “Should the dog use A* or a navmesh?”', 'aria-label': 'What the meeting is about' }) as HTMLTextAreaElement;
  about.value = preset?.prompt ?? '';
  const titleIn = h('input', { type: 'text', placeholder: 'Title (optional): the first line otherwise', maxlength: 100, 'aria-label': 'Title' }) as HTMLInputElement;
  titleIn.value = preset?.title ?? '';
  const outputIn = h('input', { type: 'text', 'aria-label': 'Output file', spellcheck: 'false' }) as HTMLInputElement;
  const outputNote = h('small.muted');
  const prSel = h('select.provider-select', { 'aria-label': 'Pull request' }) as HTMLSelectElement;
  const prRow = h('div.meeting-field', {}, h('label', {}, 'Pull request'), prSel);
  const partsIn = h('textarea', { rows: 3, placeholder: 'src/server/\nsrc/client/\nsrc/shared/', 'aria-label': 'Parts', spellcheck: 'false' }) as HTMLTextAreaElement;
  const partsRow = h('div.meeting-field', {}, h('label', {}, 'Parts, one per line'), partsIn, h('small.muted', {}, 'Handed out to the mappers in turn: files, folders, modules or issues.'));
  const count = h('b');
  const minus = h('button.btn.small', { type: 'button', 'aria-label': 'Fewer workers' }, '−');
  const plus = h('button.btn.small', { type: 'button', 'aria-label': 'More workers' }, '+');
  const roleList = h('div.meeting-roles');
  const roundsSel = h('select.provider-select.meeting-rounds', { 'aria-label': 'Round limit' }) as HTMLSelectElement;
  // A pattern that always runs the same rounds says so, where a locked control would look broken.
  const roundsFixed = h('span.meeting-fixed');
  const roundsNote = h('small.muted');
  const provider = providerPicker(store.project, 'meeting-provider', 'Workers');
  const busy = h('p.meeting-busy');
  const submit = h('button.btn.primary', { type: 'submit' }, '🤝 Start the meeting');
  const cancel = h('button.btn', { type: 'button', onclick: store.meeting.current ? back : done }, store.meeting.current ? '← Back' : 'Cancel');

  const def = () => MEETING_PATTERNS[pattern];
  const slug = () => slugify(titleIn.value.trim() || about.value.trim().split('\n')[0] || 'meeting', 32);
  const pr = () => Number(prSel.value) || undefined;
  const syncOutput = () => {
    if (!outputTouched) outputIn.value = def().output(slug(), pr());
    const problem = outputProblem(outputIn.value.trim());
    outputNote.textContent = problem ? `⚠️ ${problem}` : pattern === 'review' ? 'It ends when this file is written; the office then posts it on the PR as one review.' : store.project?.branch ? 'It ends when this file is written; the office commits it on the meeting’s own branch.' : 'It ends when this file is written.';
    outputNote.classList.toggle('bad', !!problem);
  };
  const renderRoles = () => {
    const d = def();
    count.textContent = String(roles.length);
    minus.toggleAttribute('disabled', roles.length <= d.seats.min);
    plus.toggleAttribute('disabled', roles.length >= d.seats.max);
    roleList.replaceChildren(
      ...roles.map((r, i) => {
        const input = h('input', { type: 'text', value: r, maxlength: 40, 'aria-label': `Role ${i + 1}` }) as HTMLInputElement;
        input.addEventListener('input', () => (roles[i] = input.value));
        return h('div.meeting-role', {}, h('span.muted', {}, i === 0 ? '👑' : `${i + 1}`), input);
      }),
    );
  };
  const pickPattern = (p: MeetingPattern) => {
    pattern = p;
    const d = def();
    roles = d.roles.slice(0, d.seats.default);
    for (const b of patterns.children) b.classList.toggle('on', (b as HTMLElement).dataset.pattern === p);
    for (const b of patterns.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.pattern === p));
    const fixed = fixedRounds(d);
    const limits = Array.from({ length: d.rounds.max - d.rounds.min + 1 }, (_, i) => d.rounds.min + i);
    roundsSel.replaceChildren(...limits.map((n) => h('option', { value: String(n) }, `${n} round${n === 1 ? '' : 's'}`)));
    roundsSel.value = String(d.rounds.default);
    roundsSel.classList.toggle('hidden', !!fixed);
    roundsFixed.classList.toggle('hidden', !fixed);
    roundsFixed.textContent = fixed ? `🔒 ${fixed.line}` : '';
    roundsFixed.title = fixed?.why ?? '';
    roundsNote.textContent = fixed ? fixed.stages : `${d.rounds.min} to ${d.rounds.max}. ${d.roundsNote ?? ''}`.trim();
    prRow.classList.toggle('hidden', d.needs !== 'pr');
    partsRow.classList.toggle('hidden', d.needs !== 'parts');
    renderRoles();
    syncOutput();
  };
  for (const id of MEETING_PATTERN_IDS) {
    const d = MEETING_PATTERNS[id];
    patterns.append(h('button.meeting-pattern', { type: 'button', role: 'radio', 'data-pattern': id, onclick: () => pickPattern(id) }, h('b', {}, `${d.icon} ${d.label}`), h('small', {}, d.blurb)));
  }
  minus.addEventListener('click', () => {
    if (roles.length > def().seats.min) roles.pop();
    renderRoles();
  });
  plus.addEventListener('click', () => {
    if (roles.length < def().seats.max) roles.push(def().roles[roles.length] ?? `Worker ${roles.length + 1}`);
    renderRoles();
  });
  outputIn.addEventListener('input', () => {
    outputTouched = true;
    syncOutput();
  });
  titleIn.addEventListener('input', syncOutput);
  about.addEventListener('input', syncOutput);
  prSel.addEventListener('change', syncOutput);

  const bodyEl = h(
    'form.meeting-form',
    {},
    patterns,
    h('div.meeting-field', {}, h('label', {}, 'What’s it about?'), dictateField(about)),
    h('div.meeting-field', {}, titleIn),
    prRow,
    partsRow,
    h('div.meeting-field', {}, h('label', {}, 'Output file'), outputIn, outputNote),
    h('div.meeting-field', {}, h('label.meeting-count', {}, 'Workers at the table', minus, count, plus), roleList),
    h('div.meeting-field', {}, h('label', {}, 'Round limit'), roundsSel, roundsFixed, roundsNote),
    provider.element,
    busy,
  ) as HTMLFormElement;
  bodyEl.noValidate = true;

  const send = () => {
    if (store.meeting.current?.status === 'running') return;
    const prompt = about.value.trim();
    if (!prompt) return about.focus();
    if (def().needs === 'pr' && !pr()) return prSel.focus();
    const parts = partsIn.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (def().needs === 'parts' && parts.length < roles.length - 1) {
      toast(`List at least ${roles.length - 1} parts, one per line, or seat fewer workers`, 'warn');
      return partsIn.focus();
    }
    const output = outputIn.value.trim();
    if (outputProblem(output)) return outputIn.focus();
    if (!provider.valid()) return;
    net.send({
      t: 'meeting.start',
      pattern,
      prompt,
      title: titleIn.value.trim() || undefined,
      output,
      roles: roles.map((r) => r.trim()),
      parts: def().needs === 'parts' ? parts : undefined,
      pr: def().needs === 'pr' ? pr() : undefined,
      issue: preset?.issue,
      rounds: Number(roundsSel.value) || undefined,
      provider: provider.value(),
      model: provider.model(),
      effort: provider.effort(),
    });
    toast(`🤝 Calling the ${def().label} meeting: the workers are heading for the meeting room`);
    done();
  };
  bodyEl.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  submit.addEventListener('click', (e) => {
    e.preventDefault();
    send();
  });

  /** Keeps what depends on the board and the room up to date: the open PRs, and whether the room is free. */
  const refresh = () => {
    const open = store.pulls.items.filter((p) => p.state === 'OPEN');
    const want = prSel.value || (preset?.pr ? String(preset.pr) : '');
    const opts: (readonly [string, string])[] = open.map((p) => [String(p.number), `#${p.number} ${p.title}`] as const);
    if (preset?.pr && !open.some((p) => p.number === preset.pr)) opts.unshift([String(preset.pr), `#${preset.pr}`]);
    const key = JSON.stringify(opts);
    if (prSel.dataset.key !== key) {
      prSel.dataset.key = key;
      prSel.replaceChildren(h('option', { value: '' }, open.length || preset?.pr ? 'Pick a pull request…' : 'No open pull requests'), ...opts.map(([v, label]) => h('option', { value: v }, label.length > 70 ? `${label.slice(0, 69)}…` : label)));
      prSel.value = want;
      syncOutput();
    }
    const m = store.meeting.current;
    const taken = m?.status === 'running';
    busy.textContent = taken ? `The room is busy with “${m.title}” until it ends or someone stops it.` : m ? `Starting this sends the last meeting’s workers home.` : '';
    submit.toggleAttribute('disabled', taken);
  };
  pickPattern(pattern);
  if (preset?.pr) prSel.value = String(preset.pr);
  refresh();
  setTimeout(() => (preset?.prompt ? titleIn : about).focus(), 0);
  return { body: bodyEl, foot: [h('span.grow', {}, 'Few rounds and a file at the end: that’s what keeps meetings cheap.'), cancel, submit], refresh };
}
