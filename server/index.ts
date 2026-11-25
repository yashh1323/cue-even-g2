import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConnectorStatus,
  CueCard,
  CueDraftAction,
  SseEventName,
} from '../src/shared/protocol.ts';
import { CommitQueue } from './CommitQueue.ts';
import { AiService, clampCols } from './connectors/ai.ts';
import { TelegramConnector } from './connectors/telegram.ts';
import { WorkspaceConnector } from './connectors/workspace.ts';
import { TokenBucketRateLimiter } from './resilience.ts';
import {
  AtomicFileStore,
  generateCode6,
  type ServerConnectorSecrets,
} from './store.ts';

function loadDotEnv(envPath: string): void {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env is optional
  }
}

export interface CueServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export function createCueServer(options?: {
  port?: number;
  stateFilePath?: string;
  undoWindowMs?: number;
  disableExternalPolling?: boolean;
}): CueServerHandle {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, '..');
  loadDotEnv(path.join(rootDir, '.env'));

  const secrets: ServerConnectorSecrets = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    notionApiKey: process.env.NOTION_API_KEY || '',
    notionDatabaseId: process.env.NOTION_DATABASE_ID || '',
    googleCalendarIcsUrl: process.env.GOOGLE_CALENDAR_ICS_URL || '',
  };

  const stateFile = options?.stateFilePath || path.join(rootDir, 'data', 'cue-state.json');
  const store = new AtomicFileStore(stateFile);
  const ai = new AiService(secrets);
  const workspace = new WorkspaceConnector(secrets);
  const limiter = new TokenBucketRateLimiter(80, 20);
  const sseClients = new Set<http.ServerResponse>();

  const getConnectors = (): ConnectorStatus => ({
    telegram: telegram.isLive() ? 'live' : 'sandbox',
    telegramBotUsername: telegram.getBotUsername(),
    ...ai.getMode(),
    notion: workspace.hasNotion() ? 'live' : 'sandbox',
    calendar: workspace.hasCalendar() ? 'live' : 'sandbox',
  });

  const broadcast = (event: SseEventName) => {
    void store.getSnapshot(getConnectors()).then((snap) => {
      const payload = `event: ${event}\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const client of sseClients) {
        if (!client.writableEnded) {
          client.write(payload);
        }
      }
    });
  };

  const telegram = new TelegramConnector(secrets, store, ai, () => broadcast('card_updated'));
  const queue = new CommitQueue({
    store,
    telegram,
    workspace,
    emit: broadcast,
    undoWindowMs: options?.undoWindowMs ?? 3000,
  });

  if (!options?.disableExternalPolling && secrets.telegramBotToken) {
    void telegram.start();
  }

  const refreshLiveWorkspaceFeeds = async () => {
    const [calCards, notionCards] = await Promise.all([
      workspace.fetchLiveCalendarCards(),
      workspace.fetchLiveNotionCards(),
    ]);
    if (calCards.length === 0 && notionCards.length === 0) return;
    await store.mutate((draft) => {
      const merged = [...calCards, ...notionCards, ...draft.cards.filter((c) => !c.id.startsWith('gcal-') && !c.id.startsWith('notion-live-'))];
      draft.cards = merged.slice(0, 12);
    });
    broadcast('card_updated');
  };

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(res, req.headers.origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const clientIp = req.socket.remoteAddress || 'local';
    if (!limiter.allow(clientIp)) {
      sendJson(res, 429, { error: 'Rate limit exceeded. Retry shortly.' });
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = reqUrl.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'cue-gateway', connectors: getConnectors() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        const snap = await store.getSnapshot(getConnectors());
        sendJson(res, 200, snap);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        sseClients.add(res);
        const snap = await store.getSnapshot(getConnectors());
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': ping\n\n');
        }, 15_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/pair/init') {
        const pairing = await store.mutate((draft) => {
          draft.pairing.code6 = generateCode6();
          draft.pairing.pairId = randomBytes(8).toString('hex');
          draft.pairing.expiresAtMs = Date.now() + 30 * 60 * 1000;
          draft.pairing.paired = false;
          return structuredClone(draft.pairing);
        });
        broadcast('paired');
        sendJson(res, 200, { pairing: { ...pairing, connectors: getConnectors() } });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/pair/claim') {
        const body = await readJsonBody<{ code6?: string; source?: string }>(req);
        const state = await store.load();
        const code = (body.code6 || state.pairing.code6 || '').trim();
        if (!/^\d{6}$/.test(code) || code !== state.pairing.code6) {
          sendJson(res, 400, { error: 'Invalid or expired 6-digit pairing code.' });
          return;
        }
        const pairing = await store.mutate((draft) => {
          draft.pairing.paired = true;
          draft.pairing.pairedAtMs = Date.now();
          draft.pairing.sessionToken = draft.pairing.sessionToken || `cue_${randomBytes(16).toString('hex')}`;
          draft.pairing.telegramUserLabel = draft.pairing.telegramUserLabel || (body.source || 'Companion Session');
          return structuredClone(draft.pairing);
        });
        broadcast('paired');
        sendJson(res, 200, { ok: true, pairing: { ...pairing, connectors: getConnectors() } });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/actions/stage') {
        const body = await readJsonBody<{ cardId?: string; action?: CueDraftAction; idempotencyKey?: string }>(req);
        if (!body.cardId || !body.action?.id || !body.action?.kind) {
          sendJson(res, 400, { error: 'Missing cardId or valid action payload.' });
          return;
        }
        const staged = await queue.stage(body.cardId, body.action, body.idempotencyKey);
        sendJson(res, 202, { ok: true, action: staged });
        return;
      }

      const undoMatch = pathname.match(/^\/api\/actions\/([^/]+)\/undo$/);
      if (req.method === 'POST' && undoMatch?.[1]) {
        const undone = await queue.undo(undoMatch[1]);
        if (!undone) {
          sendJson(res, 409, { error: 'Action is no longer inside its 3s undo window.' });
          return;
        }
        sendJson(res, 200, { ok: true, action: undone });
        return;
      }

      const commitMatch = pathname.match(/^\/api\/actions\/([^/]+)\/commit-now$/);
      if (req.method === 'POST' && commitMatch?.[1]) {
        const committed = await queue.commitNow(commitMatch[1]);
        if (!committed) {
          sendJson(res, 404, { error: 'Pending action not found.' });
          return;
        }
        sendJson(res, 200, { ok: true, action: committed });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/voice/intent') {
        const body = await readJsonBody<{ transcriptHint?: string; pcmBase64?: string; sampleRate?: number }>(req);
        const intent = await ai.parseVoiceCommand(body);
        sendJson(res, 200, intent);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/config/connectors') {
        const body = await readJsonBody<Partial<ServerConnectorSecrets>>(req);
        if (typeof body.telegramBotToken === 'string') secrets.telegramBotToken = body.telegramBotToken.trim();
        if (typeof body.openrouterApiKey === 'string') secrets.openrouterApiKey = body.openrouterApiKey.trim();
        if (typeof body.openrouterModel === 'string' && body.openrouterModel.trim()) {
          secrets.openrouterModel = body.openrouterModel.trim();
        }
        if (typeof body.openaiApiKey === 'string') secrets.openaiApiKey = body.openaiApiKey.trim();
        if (typeof body.anthropicApiKey === 'string') secrets.anthropicApiKey = body.anthropicApiKey.trim();
        if (typeof body.notionApiKey === 'string') secrets.notionApiKey = body.notionApiKey.trim();
        if (typeof body.notionDatabaseId === 'string') secrets.notionDatabaseId = body.notionDatabaseId.trim();
        if (typeof body.googleCalendarIcsUrl === 'string') secrets.googleCalendarIcsUrl = body.googleCalendarIcsUrl.trim();

        if (!options?.disableExternalPolling && body.telegramBotToken !== undefined) {
          await telegram.start();
        }
        await refreshLiveWorkspaceFeeds();
        broadcast('connectors_updated');
        sendJson(res, 200, { ok: true, connectors: getConnectors() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/simulate/event') {
        const body = await readJsonBody<{ scenario?: 'telegram_urgent' | 'meeting_shift' | 'notion_blocker' }>(req);
        const scenario = body.scenario || 'telegram_urgent';
        const now = Date.now();
        let injected: CueCard;

        if (scenario === 'meeting_shift') {
          injected = {
            id: `sim-meet-${now}`,
            kind: 'meeting',
            title: 'Founder Sync · NOW',
            subtitle: 'T-5m · Meet Room A · Urgent',
            contextLine: 'Calendar alert: Host moved check-in earlier to 14:25',
            urgencyMinutes: 5,
            sourceLabel: 'Calendar Live Push',
            briefMode: 'deterministic',
            createdAtMs: now,
            actions: [
              {
                id: `sim-act-m1-${now}`,
                label: 'TG Host: Joining in 3m',
                kind: 'telegram_reply',
                payload: {
                  recipient: 'Priya Nair',
                  replyText: 'Saw the move to T-5m — stepping into Meet Room A in 3m.',
                },
              },
              {
                id: `sim-act-m2-${now}`,
                label: 'Push +15m + TG Notify',
                kind: 'dual_exec',
                payload: {
                  recipient: 'Priya Nair',
                  replyText: 'Can we shift +15m so I finish the release sign-off?',
                  calendarEventId: `sim-meet-${now}`,
                  shiftMinutes: 15,
                  notionTitle: 'Prepare Founder Sync deck delta',
                  notionPriority: 'High',
                },
              },
            ],
          };
        } else if (scenario === 'notion_blocker') {
          injected = {
            id: `sim-notion-${now}`,
            kind: 'notion',
            title: 'Notion · P0 Escalation',
            subtitle: 'Assigned to You · Just now',
            contextLine: 'Sign off Gray8 waveform rate limit & package cue-g2.ehpk',
            urgencyMinutes: 8,
            sourceLabel: 'Notion Workspace Push',
            briefMode: 'deterministic',
            createdAtMs: now,
            actions: [
              {
                id: `sim-act-n1-${now}`,
                label: 'Claim P0 + TG Ops Ack',
                kind: 'dual_exec',
                payload: {
                  recipient: 'Product Ops Group',
                  replyText: 'Claimed P0 Gray8 check — updating Notion & shipping build.',
                  notionTitle: 'P0: Verify 4Hz Gray8 BLE cap & sign cue-g2.ehpk',
                  notionPriority: 'High',
                },
              },
              {
                id: `sim-act-n2-${now}`,
                label: 'Add Follow-Up Task',
                kind: 'notion_task',
                payload: {
                  notionTitle: 'Publish v1.0.0 .ehpk release notes',
                  notionPriority: 'Normal',
                },
              },
            ],
          };
        } else {
          const sender = 'Meera (Design Lead)';
          const msg = 'Investor demo moved up — can we confirm v2 lens layout and add QA task?';
          const drafted = await ai.draftTelegramReplies(sender, msg);
          injected = {
            id: `sim-tg-${now}`,
            kind: 'telegram',
            title: `TG · ${sender}`,
            subtitle: 'Urgent DM · Just now',
            contextLine: clampCols(`"${msg}"`, 86),
            urgencyMinutes: 2,
            sourceLabel: 'Telegram Incoming Push',
            briefMode: drafted.mode,
            createdAtMs: now,
            actions: drafted.actions,
          };
        }

        await store.mutate((draft) => {
          draft.cards = [injected, ...draft.cards].slice(0, 12);
        });
        broadcast('card_updated');
        sendJson(res, 200, { ok: true, card: injected });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  const listenPort = options?.port ?? Number(process.env.PORT || 8787);
  server.listen(listenPort, '127.0.0.1');

  return {
    server,
    port: listenPort,
    close: async () => {
      telegram.stop();
      queue.dispose();
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function setCorsHeaders(res: http.ServerResponse, origin?: string): void {
  const allowed = origin && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)
    ? origin
    : 'http://127.0.0.1:5173';
  res.setHeader('access-control-allow-origin', allowed);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1024 * 1024) {
      throw new Error('Request payload exceeds 1MB limit.');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const handle = createCueServer();
  console.log(`[cue-gateway] listening on http://127.0.0.1:${handle.port}`);
}
