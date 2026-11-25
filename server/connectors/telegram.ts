import { randomBytes } from 'node:crypto';
import type { CueCard } from '../../src/shared/protocol.ts';
import type { ServerConnectorSecrets, StateStore } from '../store.ts';
import { withTimeoutAndFallback } from '../resilience.ts';
import { AiService, clampCols } from './ai.ts';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; first_name?: string; username?: string; title?: string };
    from?: { first_name?: string; username?: string };
    text?: string;
  };
}

export class TelegramConnector {
  private readonly secrets: ServerConnectorSecrets;
  private readonly store: StateStore;
  private readonly ai: AiService;
  private readonly onStateChange: () => void;
  private botUsername: string | undefined;
  private polling = false;
  private lastUpdateId = 0;
  private pollAbort: AbortController | null = null;

  constructor(
    secrets: ServerConnectorSecrets,
    store: StateStore,
    ai: AiService,
    onStateChange: () => void
  ) {
    this.secrets = secrets;
    this.store = store;
    this.ai = ai;
    this.onStateChange = onStateChange;
  }

  getBotUsername(): string | undefined {
    return this.botUsername;
  }

  isLive(): boolean {
    return Boolean(this.secrets.telegramBotToken && this.botUsername);
  }

  async start(): Promise<void> {
    this.stop();
    if (!this.secrets.telegramBotToken) {
      this.botUsername = undefined;
      return;
    }

    const meRes = await withTimeoutAndFallback(
      async (signal) => {
        const r = await fetch(`https://api.telegram.org/bot${this.secrets.telegramBotToken}/getMe`, { signal });
        const j = (await r.json()) as { ok: boolean; result?: { username?: string } };
        if (!j.ok || !j.result?.username) throw new Error('Telegram getMe failed');
        return j.result.username;
      },
      6000,
      () => undefined
    );

    this.botUsername = meRes.value;
    if (!this.botUsername) return;

    this.polling = true;
    void this.pollLoop();
  }

  stop(): void {
    this.polling = false;
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.polling && this.secrets.telegramBotToken) {
      this.pollAbort = new AbortController();
      try {
        const url = `https://api.telegram.org/bot${this.secrets.telegramBotToken}/getUpdates?timeout=20&offset=${this.lastUpdateId + 1}`;
        const r = await fetch(url, { signal: this.pollAbort.signal });
        if (!r.ok) {
          await new Promise((res) => setTimeout(res, 2000));
          continue;
        }
        const json = (await r.json()) as { ok: boolean; result?: TelegramUpdate[] };
        if (json.ok && Array.isArray(json.result)) {
          for (const upd of json.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, upd.update_id);
            if (upd.message?.text) {
              await this.handleIncomingMessage(upd.message);
            }
          }
        }
      } catch {
        if (!this.polling) break;
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
  }

  private async handleIncomingMessage(msg: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const text = (msg.text || '').trim();
    const chatId = String(msg.chat.id);
    const sender =
      msg.from?.first_name ||
      msg.from?.username ||
      msg.chat.title ||
      msg.chat.username ||
      `Chat ${chatId}`;

    const pairMatch = text.match(/^\/pair(?:@\w+)?\s+(\d{6})$/i);
    if (pairMatch) {
      const code = pairMatch[1];
      const pairedOk = await this.store.mutate((draft) => {
        if (draft.pairing.code6 !== code || Date.now() > draft.pairing.expiresAtMs) {
          return false;
        }
        draft.pairing.paired = true;
        draft.pairing.pairedAtMs = Date.now();
        draft.pairing.sessionToken = draft.pairing.sessionToken || `cue_${randomBytes(16).toString('hex')}`;
        draft.pairing.telegramChatId = chatId;
        draft.pairing.telegramUserLabel = sender;
        return true;
      });
      await this.sendText(
        chatId,
        pairedOk
          ? `[Cue G2] Paired glasses session (${code}). Reply here anytime or tap smart replies from your G2 lens.`
          : `[Cue G2] Code ${code} did not match or expired. Check your G2 display for the active 6-digit code.`
      );
      this.onStateChange();
      return;
    }

    if (text === '/start') {
      await this.sendText(
        chatId,
        'Cue Chief-of-Staff for Even Realities G2 is online. Send `/pair <6-digit-code>` shown on your glasses to bind this chat.'
      );
      return;
    }

    const drafted = await this.ai.draftTelegramReplies(sender, text);
    const newCard: CueCard = {
      id: `tg-live-${msg.message_id}-${Date.now()}`,
      kind: 'telegram',
      title: `TG · ${clampCols(sender, 22)}`,
      subtitle: 'Live Telegram · Just now',
      contextLine: clampCols(`"${text}"`, 86),
      urgencyMinutes: 2,
      sourceLabel: 'Telegram Bot Live',
      briefMode: drafted.mode,
      createdAtMs: Date.now(),
      actions: drafted.actions.map((a) => ({
        ...a,
        payload: { ...a.payload, chatId, recipient: sender },
      })),
    };

    await this.store.mutate((draft) => {
      draft.cards = [newCard, ...draft.cards.filter((c) => c.id !== newCard.id)].slice(0, 12);
    });
    this.onStateChange();
  }

  async sendText(chatId: string | number, text: string): Promise<{ live: boolean; detail: string }> {
    if (!this.secrets.telegramBotToken || !chatId) {
      return { live: false, detail: `Dispatched to ${chatId || 'sandbox recipient'} [Sandbox Mode]` };
    }

    const res = await withTimeoutAndFallback(
      async (signal) => {
        const resp = await fetch(`https://api.telegram.org/bot${this.secrets.telegramBotToken}/sendMessage`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (!resp.ok) throw new Error(`Telegram sendMessage HTTP ${resp.status}`);
        return { live: true, detail: `Sent via @${this.botUsername || 'Telegram'} to chat ${chatId}` };
      },
      6000,
      () => ({ live: false, detail: 'Telegram API timed out; recorded local audit receipt.' })
    );

    return res.value;
  }
}
