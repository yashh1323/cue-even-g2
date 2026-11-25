import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConnectorStatus,
  CueCard,
  CueSnapshot,
  PairingState,
  QueuedWriteAction,
} from '../src/shared/protocol.ts';

export interface ServerConnectorSecrets {
  telegramBotToken: string;
  openrouterApiKey: string;
  openrouterModel: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  notionApiKey: string;
  notionDatabaseId: string;
  googleCalendarIcsUrl: string;
}

export interface PersistedState {
  pairing: PairingState;
  cards: CueCard[];
  ledger: QueuedWriteAction[];
}

export interface StateStore {
  load(): Promise<PersistedState>;
  mutate<T>(fn: (draft: PersistedState) => Promise<T> | T): Promise<T>;
  getSnapshot(connectors: ConnectorStatus): Promise<CueSnapshot>;
}

export function generateCode6(): string {
  return String(randomInt(100000, 999999));
}

export function createInitialSeedState(now = Date.now()): PersistedState {
  const pairCode = '482910';
  return {
    pairing: {
      code6: pairCode,
      pairId: randomBytes(8).toString('hex'),
      expiresAtMs: now + 30 * 60 * 1000,
      paired: false,
      connectors: {
        telegram: 'sandbox',
        ai: 'deterministic',
        notion: 'sandbox',
        calendar: 'sandbox',
      },
    },
    cards: [
      {
        id: 'card-meeting-1',
        kind: 'meeting',
        title: 'Design Sync · 14:30',
        subtitle: 'T-12m · Meet Room B · With Priya Nair',
        contextLine: 'Agenda: Finalize Even G2 BLE audio chunking & SDK v2 review',
        urgencyMinutes: 12,
        sourceLabel: 'Calendar [Sandbox Workspace]',
        briefMode: 'deterministic',
        createdAtMs: now - 120_000,
        actions: [
          {
            id: 'act-meet-late',
            label: 'TG Priya: 5m late',
            kind: 'telegram_reply',
            payload: {
              recipient: 'Priya Nair',
              replyText: 'Running 5m behind — joining Design Sync shortly.',
            },
          },
          {
            id: 'act-meet-onway',
            label: 'TG Priya: Joining now',
            kind: 'telegram_reply',
            payload: {
              recipient: 'Priya Nair',
              replyText: 'Heads up, stepping into Meet Room B now.',
            },
          },
          {
            id: 'act-meet-shift',
            label: 'Shift +15m + TG',
            kind: 'dual_exec',
            payload: {
              recipient: 'Priya Nair',
              replyText: 'Pushed Design Sync +15m (14:45). See you then.',
              calendarEventId: 'evt-design-sync',
              shiftMinutes: 15,
              notionTitle: 'Follow up on SDK v2 notes post-Design Sync',
              notionPriority: 'Normal',
            },
          },
        ],
      },
      {
        id: 'card-tg-1',
        kind: 'telegram',
        title: 'TG · Priya Nair',
        subtitle: 'Just now · Work Direct',
        contextLine: '"Can we move SDK review to 2:40 PM and lock sprint task?"',
        urgencyMinutes: 4,
        sourceLabel: 'Telegram [Sandbox Workspace]',
        briefMode: 'deterministic',
        createdAtMs: now - 45_000,
        actions: [
          {
            id: 'act-tg-dual',
            label: 'Approve 2:40 + Notion',
            kind: 'dual_exec',
            payload: {
              recipient: 'Priya Nair',
              replyText: 'Yes — 2:40 PM works. Logged the SDK review task in Notion.',
              notionTitle: 'Lock SDK review at 2:40 PM with Priya',
              notionPriority: 'High',
            },
          },
          {
            id: 'act-tg-yes',
            label: 'Reply: Yes, 2:40 works',
            kind: 'telegram_reply',
            payload: {
              recipient: 'Priya Nair',
              replyText: '2:40 PM works for me. Sending calendar update now.',
            },
          },
          {
            id: 'act-tg-defer',
            label: 'Reply: Check in 30m',
            kind: 'telegram_reply',
            payload: {
              recipient: 'Priya Nair',
              replyText: 'In a focus block — will confirm the 2:40 slot in 30 mins.',
            },
          },
        ],
      },
      {
        id: 'card-notion-1',
        kind: 'notion',
        title: 'Notion · Release Sprint',
        subtitle: 'Due Today · 3 P1 Items',
        contextLine: 'Next blocker: Package signed .ehpk bundle + update README',
        urgencyMinutes: 45,
        sourceLabel: 'Notion [Sandbox Workspace]',
        briefMode: 'deterministic',
        createdAtMs: now - 240_000,
        actions: [
          {
            id: 'act-notion-ship',
            label: 'Log .ehpk Check Task',
            kind: 'notion_task',
            payload: {
              notionTitle: 'Verify cue-g2.ehpk manifest & simulator E2E',
              notionPriority: 'High',
            },
          },
          {
            id: 'act-notion-ping',
            label: 'TG Team: Ship ETA 18:00',
            kind: 'telegram_reply',
            payload: {
              recipient: 'Product Ops Group',
              replyText: 'Release sprint on track — final .ehpk QA completes by 18:00.',
            },
          },
          {
            id: 'act-notion-pair',
            label: 'Dual: Task + TG Update',
            kind: 'dual_exec',
            payload: {
              recipient: 'Product Ops Group',
              replyText: 'Logged .ehpk QA gate in Notion; targeting 18:00 freeze.',
              notionTitle: '18:00 Release Freeze & Simulator Sign-off',
              notionPriority: 'High',
            },
          },
        ],
      },
      {
        id: 'card-tg-2',
        kind: 'telegram',
        title: 'TG · Arjun (Infra)',
        subtitle: '9m ago · Founders & Dev',
        contextLine: '"Staging webhook 502 cleared; telemetry shows 99.94% ok."',
        urgencyMinutes: 25,
        sourceLabel: 'Telegram [Sandbox Workspace]',
        briefMode: 'deterministic',
        createdAtMs: now - 540_000,
        actions: [
          {
            id: 'act-arjun-ack',
            label: 'Ack: Keep monitoring',
            kind: 'telegram_reply',
            payload: {
              recipient: 'Arjun',
              replyText: 'Thanks — keep an eye on p95 webhook latency through EOD.',
            },
          },
          {
            id: 'act-arjun-notion',
            label: 'Log Postmortem Task',
            kind: 'notion_task',
            payload: {
              notionTitle: 'Review staging webhook 502 root cause with Arjun',
              notionPriority: 'Normal',
            },
          },
        ],
      },
    ],
    ledger: [],
  };
}

export class AtomicFileStore implements StateStore {
  private readonly filePath: string;
  private state: PersistedState | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<PersistedState> {
    if (this.state) {
      return structuredClone(this.state);
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && Array.isArray(parsed.cards) && parsed.pairing) {
        this.state = parsed;
        return structuredClone(this.state);
      }
    } catch {
      // First run or unreadable cache -> initialize fresh seed
    }
    this.state = createInitialSeedState();
    await this.flush(this.state);
    return structuredClone(this.state);
  }

  async mutate<T>(fn: (draft: PersistedState) => Promise<T> | T): Promise<T> {
    const task = this.writeChain.then(async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const result = await fn(draft);
      this.state = draft;
      await this.flush(draft);
      return result;
    });
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  async getSnapshot(connectors: ConnectorStatus): Promise<CueSnapshot> {
    const s = await this.load();
    return {
      serverTimeMs: Date.now(),
      pairing: {
        ...s.pairing,
        connectors,
      },
      cards: s.cards,
      ledger: s.ledger.slice(0, 40),
    };
  }

  private async flush(data: PersistedState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}
