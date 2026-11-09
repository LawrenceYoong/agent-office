// Telegram 決策/核准（wire）：meeting 完成等流程發起，owner 可在 Telegram 或 Office UI 完成；結果可輪詢或由伺服器推送。

export type DecisionState = 'pending' | 'resolved' | 'cancelled' | 'expired';

export interface DecisionResult {
  type: 'telegram.decision';
  decision_id: string;
  agent_id: string;
  correlation_id?: string;
  metadata?: unknown;
  state: DecisionState;
  action?: string;
  value?: string;
  selected?: string[];
  raw?: string;
  from?: string;
  at: number;
  message_id?: number;
  chat_id?: string | number;
}

export type TelegramServerMsg =
  /** 決策狀態更新（resolved/cancelled/expired/pending）；UI 可據此自動關閉或同步。 */
  | { t: 'decision'; result: DecisionResult };

export type TelegramClientMsg = never;
