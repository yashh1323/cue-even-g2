import type { BriefMode, CueActionKind, CueDraftAction, VoiceIntentResult } from '../../src/shared/protocol.ts';
import type { ServerConnectorSecrets } from '../store.ts';
import { withTimeoutAndFallback } from '../resilience.ts';

export function clampCols(text: string, maxCols = 42): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxCols) return clean;
  return `${clean.slice(0, maxCols - 1).trimEnd()}…`;
}

export function deterministicBrief(rawText: string): { line1: string; line2: string } {
  const clean = rawText.replace(/\s+/g, ' ').trim();
  if (clean.length <= 42) {
    return { line1: clean, line2: '' };
  }
  const splitIdx = clean.lastIndexOf(' ', 42);
  const cut = splitIdx > 18 ? splitIdx : 42;
  const line1 = clean.slice(0, cut).trim();
  const line2 = clampCols(clean.slice(cut).trim(), 42);
  return { line1, line2 };
}

export function deterministicQuickReplies(sender: string, text: string): CueDraftAction[] {
  const lower = text.toLowerCase();
  const shortSender = sender.split(' ')[0] || 'Contact';

  if (/\b(\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i.test(text) || /move|reschedule|shift|later/i.test(lower)) {
    const timeMatch = text.match(/\b(\d{1,2}(:\d{2})?\s*(?:am|pm)?)\b/i);
    const slot = timeMatch?.[1] ?? 'new time';
    return [
      {
        id: `tg-ok-${Date.now()}`,
        label: clampCols(`OK ${slot} + Log Notion`, 28),
        kind: 'dual_exec',
        payload: {
          recipient: sender,
          replyText: `${slot} works for me — locked on schedule & Notion.`,
          notionTitle: `Confirmed ${slot} sync with ${shortSender}`,
          notionPriority: 'High',
        },
      },
      {
        id: `tg-yes-${Date.now()}`,
        label: clampCols(`Reply: ${slot} works`, 28),
        kind: 'telegram_reply',
        payload: {
          recipient: sender,
          replyText: `Sounds good, ${slot} works for me.`,
        },
      },
      {
        id: `tg-hold-${Date.now()}`,
        label: 'Reply: Need 15m',
        kind: 'telegram_reply',
        payload: {
          recipient: sender,
          replyText: 'In a meeting — can we push this 15 minutes?',
        },
      },
    ];
  }

  return [
    {
      id: `tg-ack-${Date.now()}`,
      label: clampCols(`Ack to ${shortSender}`, 28),
      kind: 'telegram_reply',
      payload: {
        recipient: sender,
        replyText: 'Got it — reviewing this now and will follow up shortly.',
      },
    },
    {
      id: `tg-task-${Date.now()}`,
      label: 'Log Notion Task + Ack',
      kind: 'dual_exec',
      payload: {
        recipient: sender,
        replyText: 'Noted and added to my Notion action queue.',
        notionTitle: clampCols(`Reply ${shortSender}: ${text}`, 72),
        notionPriority: 'Normal',
      },
    },
    {
      id: `tg-call-${Date.now()}`,
      label: 'Reply: Call in 10m',
      kind: 'telegram_reply',
      payload: {
        recipient: sender,
        replyText: 'Stepping out briefly — can hop on a quick call in 10 minutes.',
      },
    },
  ];
}

export function deterministicVoiceParse(transcript: string): VoiceIntentResult {
  const clean = transcript.replace(/\s+/g, ' ').trim() || 'Tell Priya 2:40 works and add Notion task lock SDK v2';
  const lower = clean.toLowerCase();

  const wantsTelegram = /tell|reply|message|tg|telegram|ping|send/i.test(lower);
  const wantsNotion = /notion|task|todo|log|track|note|remind/i.test(lower);
  const wantsShift = /shift|delay|move|push|later/i.test(lower);

  const recipientMatch = clean.match(/(?:[Tt]ell|[Rr]eply|[Pp]ing|[Mm]essage)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
  const recipient = recipientMatch?.[1] ?? 'Priya Nair';

  let replyText = clean;
  if (recipientMatch) {
    const afterName = clean.slice((recipientMatch.index ?? 0) + recipientMatch[0].length).trim();
    const beforeAnd = afterName.split(/\band\s+(?:add|create|log|open)\b/i)[0]?.trim();
    if (beforeAnd && beforeAnd.length > 2) {
      replyText = beforeAnd.charAt(0).toUpperCase() + beforeAnd.slice(1);
    }
  }

  const notionMatch = clean.match(/(?:notion task|add task|task|log)\s+(.+)$/i);
  const notionTitle = notionMatch?.[1] ? clampCols(notionMatch[1], 72) : clampCols(clean, 72);

  let kind: CueActionKind = 'telegram_reply';
  let label = clampCols(`TG ${recipient.split(' ')[0]}: Send`, 28);
  if (wantsTelegram && wantsNotion) {
    kind = 'dual_exec';
    label = clampCols(`Send TG + Notion Task`, 28);
  } else if (wantsNotion && !wantsTelegram) {
    kind = 'notion_task';
    label = clampCols(`Add Notion: ${notionTitle}`, 28);
  } else if (wantsShift) {
    kind = 'calendar_shift';
    label = 'Shift Meeting +15m';
  }

  return {
    transcript: clean,
    summary: clampCols(`${kind === 'dual_exec' ? 'Dual' : kind === 'notion_task' ? 'Notion' : 'TG'} -> ${notionTitle}`, 42),
    confidence: 0.91,
    mode: 'deterministic',
    proposedAction: {
      id: `voice-${Date.now()}`,
      label,
      kind,
      payload: {
        recipient,
        replyText,
        notionTitle,
        notionPriority: 'High',
        shiftMinutes: wantsShift ? 15 : undefined,
      },
    },
  };
}

export class AiService {
  private readonly secrets: ServerConnectorSecrets;

  constructor(secrets: ServerConnectorSecrets) {
    this.secrets = secrets;
  }

  getMode(): { ai: 'live' | 'deterministic'; aiProvider: 'openrouter' | 'openai' | 'anthropic' | 'deterministic' } {
    if (this.secrets.openrouterApiKey) return { ai: 'live', aiProvider: 'openrouter' };
    if (this.secrets.openaiApiKey) return { ai: 'live', aiProvider: 'openai' };
    if (this.secrets.anthropicApiKey) return { ai: 'live', aiProvider: 'anthropic' };
    return { ai: 'deterministic', aiProvider: 'deterministic' };
  }

  async draftTelegramReplies(sender: string, messageText: string): Promise<{ actions: CueDraftAction[]; mode: BriefMode }> {
    const modeInfo = this.getMode();
    if (modeInfo.ai === 'deterministic') {
      return { actions: deterministicQuickReplies(sender, messageText), mode: 'deterministic' };
    }

    const res = await withTimeoutAndFallback<CueDraftAction[]>(
      async (signal) => {
        const prompt = `Incoming Telegram message from ${sender}: "${messageText}".
Return strict JSON with 3 quick replies for smart glasses (labels <= 26 chars, replyText <= 90 chars):
{"replies":[{"label":"...","replyText":"...","addNotionTask":false,"notionTitle":""}]}`;
        const raw = await this.callJsonLlm(prompt, signal);
        const parsed = JSON.parse(raw) as {
          replies?: Array<{ label: string; replyText: string; addNotionTask?: boolean; notionTitle?: string }>;
        };
        if (!Array.isArray(parsed.replies) || parsed.replies.length === 0) {
          throw new Error('Empty LLM reply array');
        }
        return parsed.replies.slice(0, 3).map((r, i) => ({
          id: `tg-ai-${Date.now()}-${i}`,
          label: clampCols(r.label, 28),
          kind: (r.addNotionTask ? 'dual_exec' : 'telegram_reply') as CueActionKind,
          payload: {
            recipient: sender,
            replyText: r.replyText,
            notionTitle: r.notionTitle || undefined,
            notionPriority: 'Normal' as const,
          },
        }));
      },
      6500,
      () => deterministicQuickReplies(sender, messageText)
    );

    return {
      actions: res.value,
      mode: res.usedFallback ? 'deterministic' : 'ai',
    };
  }

  async parseVoiceCommand(params: {
    transcriptHint?: string;
    pcmBase64?: string;
    sampleRate?: number;
  }): Promise<VoiceIntentResult> {
    let transcript = (params.transcriptHint || '').trim();

    if (!transcript && params.pcmBase64 && this.secrets.openaiApiKey) {
      const sttRes = await withTimeoutAndFallback(
        async (signal) => this.transcribePcmWithWhisper(params.pcmBase64!, params.sampleRate ?? 16000, signal),
        7000,
        () => ''
      );
      if (sttRes.value) transcript = sttRes.value;
    }

    if (!transcript) {
      transcript = 'Tell Priya 2:40 works and add Notion task lock SDK v2';
    }

    const modeInfo = this.getMode();
    if (modeInfo.ai === 'deterministic') {
      return deterministicVoiceParse(transcript);
    }

    const res = await withTimeoutAndFallback<VoiceIntentResult>(
      async (signal) => {
        const prompt = `Parse this spoken smart-glasses command into one confirmed action:
"${transcript}"
Return strict JSON:
{"summary":"<=40 chars","label":"<=26 chars","kind":"telegram_reply|notion_task|calendar_shift|dual_exec","recipient":"name","replyText":"message","notionTitle":"task title","shiftMinutes":0}`;
        const raw = await this.callJsonLlm(prompt, signal);
        const p = JSON.parse(raw) as {
          summary: string;
          label: string;
          kind: CueActionKind;
          recipient?: string;
          replyText?: string;
          notionTitle?: string;
          shiftMinutes?: number;
        };
        return {
          transcript,
          summary: clampCols(p.summary || transcript, 42),
          confidence: 0.96,
          mode: 'ai' as const,
          proposedAction: {
            id: `voice-ai-${Date.now()}`,
            label: clampCols(p.label || 'Confirm Action', 28),
            kind: p.kind || 'dual_exec',
            payload: {
              recipient: p.recipient || 'Priya Nair',
              replyText: p.replyText || transcript,
              notionTitle: p.notionTitle || clampCols(transcript, 72),
              notionPriority: 'High' as const,
              shiftMinutes: p.shiftMinutes || undefined,
            },
          },
        };
      },
      6500,
      () => deterministicVoiceParse(transcript)
    );

    return res.value;
  }

  private async callJsonLlm(userPrompt: string, signal: AbortSignal): Promise<string> {
    if (this.secrets.openrouterApiKey || this.secrets.openaiApiKey) {
      const isOpenRouter = Boolean(this.secrets.openrouterApiKey);
      const url = isOpenRouter
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
      const key = isOpenRouter ? this.secrets.openrouterApiKey : this.secrets.openaiApiKey;
      const model = isOpenRouter ? (this.secrets.openrouterModel || 'openai/gpt-4o-mini') : 'gpt-4o-mini';

      const resp = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are Cue, a concise assistant for 576x288 monochrome smart glasses. Output strict JSON only.' },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new Error('Missing completion content');
      return text;
    }

    if (this.secrets.anthropicApiKey) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.secrets.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          max_tokens: 350,
          system: 'You are Cue for smart glasses. Respond with valid JSON only, no markdown fences.',
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!resp.ok) throw new Error(`Anthropic HTTP ${resp.status}`);
      const json = (await resp.json()) as { content?: Array<{ text?: string }> };
      const text = json.content?.[0]?.text;
      if (!text) throw new Error('Missing Anthropic text');
      return text;
    }

    throw new Error('No AI provider configured');
  }

  private async transcribePcmWithWhisper(pcmBase64: string, sampleRate: number, signal: AbortSignal): Promise<string> {
    const pcm = Buffer.from(pcmBase64, 'base64');
    if (pcm.length < 64) return '';
    const wav = buildWavFromPcm16(pcm, sampleRate);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'command.wav');
    form.append('model', 'whisper-1');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${this.secrets.openaiApiKey}` },
      body: form,
    });
    if (!resp.ok) throw new Error(`Whisper HTTP ${resp.status}`);
    const data = (await resp.json()) as { text?: string };
    return (data.text || '').trim();
  }
}

export function buildWavFromPcm16(pcm: Buffer, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
