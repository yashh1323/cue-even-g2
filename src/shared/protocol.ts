export type CueCardKind = 'meeting' | 'telegram' | 'notion' | 'brief';

export type CueActionKind =
  | 'telegram_reply'
  | 'notion_task'
  | 'calendar_shift'
  | 'dual_exec';

export type BriefMode = 'ai' | 'deterministic';

export interface CueActionPayload {
  chatId?: string | number;
  recipient?: string;
  replyText?: string;
  notionTitle?: string;
  notionPriority?: 'High' | 'Normal';
  calendarEventId?: string;
  shiftMinutes?: number;
  note?: string;
}

export interface CueDraftAction {
  id: string;
  label: string;
  kind: CueActionKind;
  payload: CueActionPayload;
}

export interface CueCard {
  id: string;
  kind: CueCardKind;
  title: string;
  subtitle: string;
  contextLine: string;
  urgencyMinutes: number;
  sourceLabel: string;
  briefMode: BriefMode;
  createdAtMs: number;
  actions: CueDraftAction[];
}

export type QueuedActionStatus = 'pending_undo' | 'executed' | 'undone' | 'failed';

export interface QueuedWriteAction {
  id: string;
  idempotencyKey: string;
  cardId: string;
  kind: CueActionKind;
  summary: string;
  status: QueuedActionStatus;
  stagedAtMs: number;
  executeAtMs: number;
  completedAtMs?: number;
  receiptText?: string;
  errorText?: string;
  payload: CueActionPayload;
}

export interface ConnectorStatus {
  telegram: 'live' | 'sandbox';
  telegramBotUsername?: string;
  ai: 'live' | 'deterministic';
  aiProvider?: 'openrouter' | 'openai' | 'anthropic' | 'deterministic';
  notion: 'live' | 'sandbox';
  calendar: 'live' | 'sandbox';
}

export interface PairingState {
  code6: string;
  pairId: string;
  expiresAtMs: number;
  paired: boolean;
  pairedAtMs?: number;
  sessionToken?: string;
  telegramChatId?: string;
  telegramUserLabel?: string;
  connectors: ConnectorStatus;
}

export interface VoiceIntentResult {
  transcript: string;
  summary: string;
  proposedAction: CueDraftAction;
  confidence: number;
  mode: BriefMode;
}

export interface CueSnapshot {
  serverTimeMs: number;
  pairing: PairingState;
  cards: CueCard[];
  ledger: QueuedWriteAction[];
}

export type SseEventName =
  | 'snapshot'
  | 'card_updated'
  | 'action_staged'
  | 'action_executed'
  | 'action_undone'
  | 'action_failed'
  | 'paired'
  | 'connectors_updated';

export interface SseEnvelope {
  event: SseEventName;
  data: CueSnapshot;
}

export type G2ScreenMode = 'PAIR' | 'NOW' | 'VOICE' | 'UNDO';
export type G2FilterCategory = 'all' | 'telegram' | 'notion';
