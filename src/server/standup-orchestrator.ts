// C4: 會議/standup 決策核准後，冪等地「僅指派 managers」（Project Manager / UI/UX Manager）。
// v1 授權：不直接指派實作 workers；manager 在授權內決定（≤5、manager 分支/worktree、PR→manager 分支、永不直接 main、merge 需明確授權）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DecisionResult } from '../shared/protocol.js';
import { resolveRoleSkill } from './meeting-standup.js';

type AssignKey = 'assign_project_manager' | 'assign_uiux_manager';
type RoleSpec = { key: AssignKey; roleLabel: string; nameHint: string; deskPreference: string[] };

const ROLES: RoleSpec[] = [
  { key: 'assign_project_manager', roleLabel: 'Project Manager', nameHint: 'PM', deskPreference: ['desk-1', 'desk-2', 'desk-3', 'desk-4'] },
  { key: 'assign_uiux_manager', roleLabel: 'UI/UX Manager', nameHint: 'UIUX', deskPreference: ['desk-2', 'desk-3', 'desk-4', 'desk-1'] },
];

interface OrchRecord {
  decision_id: string;
  correlation_id?: string;
  floorId: string;
  meetingId?: string;
  state: 'processing' | 'done' | 'skipped' | 'error';
  at: number;
  selected?: string[];
  assignments?: Record<string, { workerId?: string; name?: string; deskId?: string; status: string; error?: string }>;
  note?: string;
}
interface OrchState { version: 1; records: Record<string, OrchRecord> }

export interface StandupOrchestratorCtx {
  floorId: string;
  floorName: string;
  projectDir: string;
  dataDir: string; // floor-scoped .agent-office data dir
  listWorkers(): Array<{ id: string; deskId: string; name: string; status: string }>;
  spawnWorker(deskId: string, prompt: string, by: string): { ok: true; id: string; name: string; deskId: string } | { ok: false; error: string };
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  log?(line: string): void;
}

function statePath(ctx: StandupOrchestratorCtx): string {
  // 優先專案目錄（可被 repo/.agent-office 管理）；fallback 到 floor dataDir
  const dir = path.join(ctx.projectDir, '.agent-office');
  return path.join(existsSync(ctx.projectDir) ? dir : ctx.dataDir, 'standup-orchestration.json');
}
function load(ctx: StandupOrchestratorCtx): OrchState {
  try {
    const p = statePath(ctx);
    if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); if (j?.version === 1 && j.records) return j; }
  } catch { /* ignore */ }
  return { version: 1, records: {} };
}
function save(ctx: StandupOrchestratorCtx, s: OrchState) {
  const p = statePath(ctx);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}

function pickDesk(ctx: StandupOrchestratorCtx, pref: string[], taken: Set<string>): string | undefined {
  for (const d of pref) if (!taken.has(d)) return d;
  // fallback: desk-1..desk-12
  for (let i = 1; i <= 20; i++) { const d = `desk-${i}`; if (!taken.has(d)) return d; }
  return undefined;
}

function guardrails(meta: any): string {
  return [
    '【DPMS/Standup 授權護欄｜必須遵守】',
    '- 本次核准授權範圍：僅指派 managers（Project Manager / UI/UX Manager）。你不可直接指派/建立實作 workers。',
    '- 你（manager）可在授權內決定實作分工：總數 ≤ 5，且須從 manager 分支/worktree 派生；PR 回 manager 分支；永不直接 push/merge 到 main。',
    '- 任何 merge 到 main/master 或共享主線的動作，都必須先取得使用者明確授權；未授權不得執行。',
    '- verified > claimed：結論需附可檢查證據（檔案路徑/指令輸出/commit/PR）；不確定就標示未驗證並詢問/報告。',
    '- secrets/憑證不得寫入 repo 或日誌；遵循 fork-only、ProjectHub/DPMS guardrails。',
    meta?.worktree?.branch ? `- Standup/meeting 工作分支基線：${meta.worktree.branch}${meta.worktree.path ? `（${meta.worktree.path}）` : ''}` : '',
    meta?.outputPath ? `- Standup 輸出（權威範圍請以此為準）：${meta.outputPath}` : '',
  ].filter(Boolean).join('\n');
}

function buildPrompt(ctx: StandupOrchestratorCtx, role: RoleSpec, result: DecisionResult): string {
  const meta: any = result.metadata || {};
  const skill = resolveRoleSkill(ctx.projectDir, role.roleLabel);
  const parts = [
    `你被指派為「${ctx.floorName}」的 ${role.roleLabel}（由 standup 決策核准觸發，decision=${result.decision_id}）。`,
    guardrails(meta),
    '',
    `【任務】閱讀 standup 輸出並產出可執行的 manager 計畫（範圍、風險、驗收、分工草案 ≤5 實作單位但本次不直接建立），必要時向使用者/PM 流程回報阻塞。`,
    `【會議】${meta.title || ''} (${meta.pattern || ''}) correlation=${result.correlation_id || ''}`,
    result.action ? `【核准】action=${result.action} selected=${(result.selected||[]).join(',')}` : '',
    skill ? `\n【角色技能（project-local，source: ${skill.source}）】\n${skill.text}` : `\n【角色技能】未在專案找到 ${role.roleLabel} SKILL.md（已嘗試 .agents/skills / .opencode/skills）；請依 DPMS/專案規範謹慎行事並標示未驗證。`,
    '\n開始前先確認你能讀取 standup 輸出檔；若路徑不可達或內容不足，回報缺口，不要猜測。',
  ];
  return parts.filter(x => x !== '').join('\n');
}

export function handleStandupDecisionResolved(ctx: StandupOrchestratorCtx, result: DecisionResult): void {
  const meta: any = result.metadata || {};
  if (meta.authScope !== 'assign_managers_only') return;
  if (result.state !== 'resolved') return;
  const selected = Array.isArray(result.selected) ? result.selected : [];
  const approveLike = result.action === 'approve' || result.action === 'submit';
  if (!approveLike) { ctx.toast(`Standup 決策 ${result.decision_id} 已 ${result.state}/${result.action || ''}，未指派 managers`, 'info'); return; }

  const st = load(ctx);
  const existing = st.records[result.decision_id];
  if (existing && (existing.state === 'done' || existing.state === 'processing' || existing.state === 'skipped')) {
    ctx.log?.(`[orchestrator] skip ${result.decision_id} state=${existing.state}`);
    return;
  }

  const rec: OrchRecord = { decision_id: result.decision_id, correlation_id: result.correlation_id, floorId: ctx.floorId, meetingId: meta.meetingId, state: 'processing', at: Date.now(), selected, assignments: {} };
  st.records[result.decision_id] = rec;
  save(ctx, st);

  const targets = ROLES.filter(r => selected.includes(r.key) || result.action === 'approve');
  if (!targets.length) {
    rec.state = 'skipped'; rec.note = 'no manager assignment selected'; save(ctx, st);
    ctx.toast(`Standup 核准完成（${ctx.floorName}）：未選擇指派 manager`, 'info');
    return;
  }

  const taken = new Set(ctx.listWorkers().map(w => w.deskId));
  for (const role of targets) {
    const deskId = pickDesk(ctx, role.deskPreference, taken);
    if (!deskId) { rec.assignments![role.key] = { status: 'error', error: 'no available desk' }; continue; }
    const prompt = buildPrompt(ctx, role, result);
    const out = ctx.spawnWorker(deskId, prompt, `standup:${result.decision_id}`);
    if (out.ok) {
      taken.add(out.deskId);
      rec.assignments![role.key] = { workerId: out.id, name: out.name, deskId: out.deskId, status: 'spawned' };
      ctx.toast(`✅ 已指派 ${role.roleLabel}：${out.name}（${out.deskId}）`, 'info');
    } else {
      rec.assignments![role.key] = { status: 'error', deskId, error: out.error };
      ctx.toast(`⚠️ 指派 ${role.roleLabel} 失敗：${out.error}`, 'warn');
    }
  }
  const errs = Object.values(rec.assignments || {}).filter(a => a.status === 'error');
  rec.state = errs.length === targets.length ? 'error' : 'done';
  rec.at = Date.now();
  save(ctx, st);
  ctx.log?.(`[orchestrator] ${result.decision_id} ${rec.state} ${JSON.stringify(rec.assignments)}`);
}
