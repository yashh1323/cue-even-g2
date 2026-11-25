import { randomBytes } from 'node:crypto';
import type { CueDraftAction, QueuedWriteAction, SseEventName } from '../src/shared/protocol.ts';
import type { StateStore } from './store.ts';
import { IdempotencyLedger } from './resilience.ts';
import { TelegramConnector } from './connectors/telegram.ts';
import { WorkspaceConnector } from './connectors/workspace.ts';

export class CommitQueue {
  private readonly store: StateStore;
  private readonly telegram: TelegramConnector;
  private readonly workspace: WorkspaceConnector;
  private readonly idempotency: IdempotencyLedger;
  private readonly emit: (event: SseEventName) => void;
  private readonly undoWindowMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(params: {
    store: StateStore;
    telegram: TelegramConnector;
    workspace: WorkspaceConnector;
    emit: (event: SseEventName) => void;
    undoWindowMs?: number;
  }) {
    this.store = params.store;
    this.telegram = params.telegram;
    this.workspace = params.workspace;
    this.emit = params.emit;
    this.undoWindowMs = params.undoWindowMs ?? 3000;
    this.idempotency = new IdempotencyLedger();
  }

  async stage(cardId: string, action: CueDraftAction, idempotencyKey?: string): Promise<QueuedWriteAction> {
    const key = idempotencyKey || `${cardId}:${action.id}:${Math.floor(Date.now() / 4000)}`;
    const existingId = this.idempotency.getExisting(key);
    if (existingId) {
      const state = await this.store.load();
      const found = state.ledger.find((a) => a.id === existingId);
      if (found) return found;
    }

    const now = Date.now();
    const entry: QueuedWriteAction = {
      id: `act_${randomBytes(6).toString('hex')}`,
      idempotencyKey: key,
      cardId,
      kind: action.kind,
      summary: action.label,
      status: 'pending_undo',
      stagedAtMs: now,
      executeAtMs: now + this.undoWindowMs,
      payload: action.payload,
    };

    this.idempotency.record(key, entry.id);

    await this.store.mutate((draft) => {
      draft.ledger = [entry, ...draft.ledger].slice(0, 60);
    });
    this.emit('action_staged');

    const timer = setTimeout(() => {
      this.timers.delete(entry.id);
      void this.executeAction(entry.id);
    }, this.undoWindowMs);
    this.timers.set(entry.id, timer);

    return entry;
  }

  async undo(actionId: string): Promise<QueuedWriteAction | null> {
    const timer = this.timers.get(actionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(actionId);
    }

    const updated = await this.store.mutate((draft) => {
      const item = draft.ledger.find((l) => l.id === actionId);
      if (!item || item.status !== 'pending_undo') return null;
      item.status = 'undone';
      item.completedAtMs = Date.now();
      item.receiptText = 'Cancelled inside 3s G2 undo window — zero external writes.';
      return structuredClone(item);
    });

    if (updated) {
      this.emit('action_undone');
    }
    return updated;
  }

  async commitNow(actionId: string): Promise<QueuedWriteAction | null> {
    const timer = this.timers.get(actionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(actionId);
    }
    return this.executeAction(actionId);
  }

  private async executeAction(actionId: string): Promise<QueuedWriteAction | null> {
    const current = await this.store.load();
    const target = current.ledger.find((l) => l.id === actionId);
    if (!target || target.status !== 'pending_undo') return null;

    const activeChatId = target.payload.chatId || current.pairing.telegramChatId || '';
    const receiptParts: string[] = [];

    try {
      if (target.kind === 'telegram_reply' || target.kind === 'dual_exec') {
        const msg = target.payload.replyText || target.summary;
        const tgRes = await this.telegram.sendText(
          activeChatId,
          `${msg}\n— sent via Cue (Even G2)`
        );
        receiptParts.push(tgRes.detail);
      }

      if (target.kind === 'notion_task' || target.kind === 'dual_exec') {
        const title = target.payload.notionTitle || target.summary;
        const notionRes = await this.workspace.createNotionTask(title, target.payload.notionPriority ?? 'High');
        receiptParts.push(notionRes.detail);
        if (target.kind === 'notion_task' && activeChatId) {
          await this.telegram.sendText(activeChatId, `[Cue G2 Receipt] ${notionRes.detail}`);
        }
      }

      if (target.kind === 'calendar_shift' || (target.kind === 'dual_exec' && target.payload.shiftMinutes)) {
        const mins = target.payload.shiftMinutes ?? 15;
        receiptParts.push(`Shifted meeting timeline by +${mins}m`);
      }

      const finalEntry = await this.store.mutate((draft) => {
        const item = draft.ledger.find((l) => l.id === actionId);
        if (!item) return null;
        item.status = 'executed';
        item.completedAtMs = Date.now();
        item.receiptText = receiptParts.join(' · ');

        if (target.payload.shiftMinutes && target.payload.calendarEventId) {
          const card = draft.cards.find((c) => c.id === target.cardId);
          if (card) {
            card.urgencyMinutes += target.payload.shiftMinutes;
            card.subtitle = `T-${card.urgencyMinutes}m · Shifted +${target.payload.shiftMinutes}m`;
          }
        }
        return structuredClone(item);
      });

      this.emit('action_executed');
      return finalEntry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failedEntry = await this.store.mutate((draft) => {
        const item = draft.ledger.find((l) => l.id === actionId);
        if (!item) return null;
        item.status = 'failed';
        item.completedAtMs = Date.now();
        item.errorText = msg;
        return structuredClone(item);
      });
      this.emit('action_failed');
      return failedEntry;
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }
}
