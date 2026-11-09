// Telegram 決策（雙通道）：meeting 等流程的核准請求，可在 Telegram 或 Office UI 完成；WS 推送 + 輪詢 fallback。
import type { DecisionResult } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** decision_id → 最新狀態 */
    decisions: Map<string, DecisionResult>;
    /** 依 meeting 找最新決策（correlation_id = meeting:<floorId>:<meetingId> 或 metadata） */
    decisionForMeeting(floorId: string | null | undefined, meetingId: string | null | undefined): DecisionResult | undefined;
  }
  interface Topics {
    decision: true;
  }
}

function matchesMeeting(d: DecisionResult, floorId: string | null | undefined, meetingId: string | null | undefined): boolean {
  if (!floorId || !meetingId) return false;
  if (d.correlation_id === `meeting:${floorId}:${meetingId}`) return true;
  const md: any = d.metadata;
  return !!md && md.floorId === floorId && md.meetingId === meetingId;
}

export const telegramDecisions: Slice = {
  init(s) {
    s.decisions = new Map();
    s.decisionForMeeting = function (floorId, meetingId) {
      let best: DecisionResult | undefined;
      for (const d of this.decisions.values()) {
        if (!matchesMeeting(d, floorId, meetingId)) continue;
        if (!best || d.at >= best.at) best = d;
      }
      return best;
    };
  },
  on: {
    decision(s, m) {
      if (!m.result?.decision_id) return;
      s.decisions.set(m.result.decision_id, m.result);
      return ['decision'];
    },
  },
  enter(s) {
    // floor 切換時保留（同一瀏覽器可能看不同 floor 的決策），不清空
    return [];
  },
};
