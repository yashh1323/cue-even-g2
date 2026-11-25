import type { CueCard } from '../../src/shared/protocol.ts';
import type { ServerConnectorSecrets } from '../store.ts';
import { withTimeoutAndFallback } from '../resilience.ts';
import { clampCols } from './ai.ts';

export class WorkspaceConnector {
  private readonly secrets: ServerConnectorSecrets;

  constructor(secrets: ServerConnectorSecrets) {
    this.secrets = secrets;
  }

  hasNotion(): boolean {
    return Boolean(this.secrets.notionApiKey && this.secrets.notionDatabaseId);
  }

  hasCalendar(): boolean {
    return Boolean(this.secrets.googleCalendarIcsUrl);
  }

  async createNotionTask(title: string, priority: 'High' | 'Normal' = 'High'): Promise<{ live: boolean; detail: string }> {
    if (!this.hasNotion()) {
      return { live: false, detail: `Created Notion task "${title}" (${priority}) [Sandbox Workspace]` };
    }

    const res = await withTimeoutAndFallback(
      async (signal) => {
        const resp = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${this.secrets.notionApiKey}`,
            'notion-version': '2022-06-28',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            parent: { database_id: this.secrets.notionDatabaseId },
            properties: {
              Name: { title: [{ text: { content: title } }] },
            },
          }),
        });
        if (!resp.ok) throw new Error(`Notion HTTP ${resp.status}`);
        return { live: true, detail: `Created Notion page "${title}" in workspace DB` };
      },
      6500,
      () => ({ live: false, detail: `Notion API unreachable; logged task "${title}" locally.` })
    );

    return res.value;
  }

  async fetchLiveCalendarCards(): Promise<CueCard[]> {
    if (!this.hasCalendar()) return [];
    const res = await withTimeoutAndFallback(
      async (signal) => {
        const r = await fetch(this.secrets.googleCalendarIcsUrl, { signal });
        if (!r.ok) throw new Error(`ICS HTTP ${r.status}`);
        const text = await r.text();
        return parseIcsUpcoming(text);
      },
      6500,
      () => []
    );
    return res.value;
  }

  async fetchLiveNotionCards(): Promise<CueCard[]> {
    if (!this.hasNotion()) return [];
    const res = await withTimeoutAndFallback(
      async (signal) => {
        const r = await fetch(`https://api.notion.com/v1/databases/${this.secrets.notionDatabaseId}/query`, {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${this.secrets.notionApiKey}`,
            'notion-version': '2022-06-28',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ page_size: 3 }),
        });
        if (!r.ok) throw new Error(`Notion query HTTP ${r.status}`);
        const data = (await r.json()) as {
          results?: Array<{ id: string; properties?: Record<string, any> }>;
        };
        const out: CueCard[] = [];
        for (const page of data.results || []) {
          const titleProp = Object.values(page.properties || {}).find((p: any) => p?.type === 'title') as any;
          const titleText = titleProp?.title?.[0]?.plain_text || 'Notion Task';
          out.push({
            id: `notion-live-${page.id}`,
            kind: 'notion',
            title: `Notion · ${clampCols(titleText, 24)}`,
            subtitle: 'Live Notion DB',
            contextLine: titleText,
            urgencyMinutes: 35,
            sourceLabel: 'Notion Live API',
            briefMode: 'deterministic',
            createdAtMs: Date.now(),
            actions: [
              {
                id: `act-nl-${page.id.slice(0, 6)}`,
                label: 'TG Team: Task active',
                kind: 'telegram_reply',
                payload: {
                  recipient: 'Product Ops Group',
                  replyText: `Working on Notion item: ${titleText}`,
                },
              },
            ],
          });
        }
        return out;
      },
      6500,
      () => []
    );
    return res.value;
  }
}

export function parseIcsUpcoming(icsText: string, nowMs = Date.now()): CueCard[] {
  const events = icsText.split(/BEGIN:VEVENT/i).slice(1);
  const cards: CueCard[] = [];

  for (const raw of events) {
    const body = raw.split(/END:VEVENT/i)[0] || '';
    const summaryMatch = body.match(/^SUMMARY(?:;[^:]*)?:(.*)$/im);
    const dtStartMatch = body.match(/^DTSTART(?:;[^:]*)?:(.*)$/im);
    const locMatch = body.match(/^LOCATION(?:;[^:]*)?:(.*)$/im);
    if (!summaryMatch?.[1] || !dtStartMatch?.[1]) continue;

    const dt = parseIcsDate(dtStartMatch[1].trim());
    if (!dt) continue;
    const diffMin = Math.round((dt.getTime() - nowMs) / 60000);
    if (diffMin < -10 || diffMin > 720) continue;

    const summary = summaryMatch[1].trim().replace(/\\,/g, ',');
    const loc = (locMatch?.[1] || 'Calendar').trim().replace(/\\,/g, ',');
    const hhmm = dt.toTimeString().slice(0, 5);

    cards.push({
      id: `gcal-${dt.getTime()}`,
      kind: 'meeting',
      title: `${clampCols(summary, 22)} · ${hhmm}`,
      subtitle: `T-${Math.max(0, diffMin)}m · ${clampCols(loc, 22)}`,
      contextLine: `Live Google Calendar event in ${Math.max(0, diffMin)}m`,
      urgencyMinutes: Math.max(0, diffMin),
      sourceLabel: 'Google Calendar Live',
      briefMode: 'deterministic',
      createdAtMs: nowMs,
      actions: [
        {
          id: `gcal-late-${dt.getTime()}`,
          label: 'TG Host: 5m late',
          kind: 'telegram_reply',
          payload: {
            recipient: 'Meeting Host',
            replyText: `Running 5m behind for ${summary} (${hhmm}).`,
          },
        },
        {
          id: `gcal-note-${dt.getTime()}`,
          label: 'Log Prep Task in Notion',
          kind: 'notion_task',
          payload: {
            notionTitle: `Prep brief for ${summary}`,
            notionPriority: 'High',
          },
        },
      ],
    });
  }

  return cards.sort((a, b) => a.urgencyMinutes - b.urgencyMinutes).slice(0, 3);
}

function parseIcsDate(raw: string): Date | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : ''}`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
