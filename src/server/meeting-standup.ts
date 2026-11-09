import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Meeting, WorkerInfo } from "../shared/protocol.js";

export interface StandupPlanCtx {
  m: Meeting;
  round: number;
  step: number;
  abs: (rel: string) => string;
  note: (r: number, i: number) => string;
  notesOf: (r: number, seats: number[]) => string;
  all: number[];
  last: boolean;
}

/** Role id candidates from a meeting role label (e.g. "Product Manager" -> ["product-manager", ...]). */
export function roleIdCandidates(label: string): string[] {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const map: Record<string, string[]> = {
    "product-manager": ["product-manager", "pm"],
    "project-manager": ["project-manager", "proj-manager"],
    "ui-ux-manager": ["uiux-manager", "ui-ux-manager", "ux-manager"],
    "engineer": ["engineer", "developer"],
  };
  return [...new Set([base, ...(map[base] ?? [])])].filter(Boolean);
}

/** Resolve project-local role skill (DPMS-style .agents/skills/<role>/SKILL.md). Returns {text, source} or undefined. */
export function resolveRoleSkill(projectDir: string, roleLabel: string): { text: string; source: string } | undefined {
  const roots = [path.join(projectDir, ".agents", "skills"), path.join(projectDir, ".opencode", "skills")];
  for (const id of roleIdCandidates(roleLabel)) {
    for (const root of roots) {
      const file = path.join(root, id, "SKILL.md");
      if (existsSync(file)) {
        try {
          const raw = readFileSync(file, "utf8");
          const text = raw.length > 6000 ? raw.slice(0, 6000) + "\n\n[...truncated for meeting context...]" : raw;
          return { text, source: path.relative(projectDir, file) || file };
        } catch { /* ignore */ }
      }
    }
  }
  return undefined;
}

function gitOut(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim() || "unknown"; }
  catch { return "unverified"; }
}

/** Minimal verified snapshot for standup (grounding). Mark unknown/unverified explicitly. */
export function gatherStandupContext(opts: { projectDir: string; cwd: string; workers: WorkerInfo[]; meeting: Meeting }): string {
  const { projectDir, cwd, workers, meeting } = opts;
  const head = gitOut(cwd, ["rev-parse", "--short", "HEAD"]);
  const branch = gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const meetingWorkers = meeting.seats.map(s => {
    const w = s.workerId ? workers.find(x => x.id === s.workerId) : undefined;
    return `- ${s.role} (${s.workerName ?? "unassigned"}): ${w ? `status=${w.status}, desk=${w.deskId}${w.pr?.url ? `, pr=${w.pr.url}` : ""}` : "worker state unverified"}`;
  });
  const roleSkills: string[] = [];
  const roleGuides: string[] = [];
  for (const s of meeting.seats) {
    const r = resolveRoleSkill(projectDir, s.role);
    if (r) { roleSkills.push(`- ${s.role}: project skill loaded (${r.source})`); roleGuides.push(`### ${s.role} (${r.source})\n${r.text}`); }
    else roleSkills.push(`- ${s.role}: no project skill found (fallback role label only)`);
  }
  return [
    `snapshot_at: ${new Date().toISOString()} (verified at generation time; re-check if stale)`,
    `project_dir: ${projectDir}`,
    `meeting_cwd: ${cwd}`,
    `git_branch: ${branch}`,
    `git_head: ${head}`,
    `output_target: ${meeting.output}`,
    `meeting_id: ${meeting.id}`,
    `open_issues/pr/ci/projecthub: unverified in meeting context (query repo tools/ProjectHub/GitHub for evidence before claiming)`,
    `meeting_seats:`,
    ...meetingWorkers,
    `role_skills:`,
    ...roleSkills,
    ...(roleGuides.length ? ["", "role_skill_guides (project-local; follow project rules and explicit authorization boundaries):", ...roleGuides] : []),
  ].join("\n");
}

export function standupHow(head: string): string {
  return `Round 1: each manager reports verified status, in-flight work/blockers, next actions, and decisions needed (mark unverified/unknown explicitly). Round 2: the ${head} synthesizes the standup record with priorities, blockers, decisions, and proposed manager assignments (approval = assign managers only in v1).`;
}

export function planStandup(ctx: StandupPlanCtx) {
  const { m, round, step, note, notesOf, all, last, abs } = ctx;
  if (step > 1) return null;
  const standupCtx = (m as any)._standupContext || "unverified: no context snapshot available";
  if (round === 1) {
    return all.map(i => ({
      seat: i,
      doing: "reporting",
      file: note(1, i),
      ask: `Report as ${m.seats[i].role} for this standup. Use only the verified context below; do not guess. Mark items verified/unverified/unknown.\n\nVerified context:\n${standupCtx}\n\nWrite ${abs(note(1, i))} with bullets: (1) Verified completed, (2) In-flight and blockers (owner/evidence or unverified), (3) Next actions, (4) Decisions/approvals needed. Then end your turn.`,
    }));
  }
  if (last) {
    return [{
      seat: 0,
      doing: "synthesizing the standup",
      file: m.output,
      ask: `Read the managers' reports (${notesOf(1, all)}) and the verified context below. Write ${abs(m.output)} in Markdown with: 日期與範圍, Verified 完成, In-flight 與阻塞 (owner/證據/unverified), 待決策, 今日優先, 擬指派與授權請求 (v1: 僅指派 managers；派工由 managers 在授權內決定，≤5、manager 分支/worktree、PR 回 manager 分支、merge 需明確授權), 證據連結 (未知標註), 未驗證事項. Do not invent facts. That file is the meeting's output.\n\nVerified context:\n${standupCtx}`,
    }];
  }
  return null;
}
