import type { CueSnapshot } from '../shared/protocol.ts';
import type { Gray8Bitmap } from '../g2/bitmaps.ts';
import { MENU_IDS, type G2BuiltPage, type G2ViewModel } from '../g2/layout.ts';

export interface CompanionUiHandlers {
  onPairSubmit: (code6: string) => void;
  onPairRegenerate: () => void;
  onSimulateEvent: (scenario: 'telegram_urgent' | 'meeting_shift' | 'notion_blocker') => void;
  onUndoAction: (actionId: string) => void;
  onCommitNow: (actionId: string) => void;
  onTap: (idx?: number) => void;
  onDoubleTap: () => void;
  onScroll: (dir: 'up' | 'down') => void;
  onVoiceRun: (transcriptHint: string) => void;
  onMenuSelect: (menuId: number) => void;
  onSaveConnectors: (payload: Record<string, string>) => Promise<void>;
  onRetrySync: () => void;
}

export interface CompanionViewState {
  loading: boolean;
  errorText: string;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveMessage: string;
  bridgeConnected: boolean;
  built: G2BuiltPage;
  vm: G2ViewModel;
  snapshot: CueSnapshot | null;
  lastEventLabel: string;
}

function drawGray8ToCanvas(canvas: HTMLCanvasElement, bitmap: Gray8Bitmap): void {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(bitmap.width, bitmap.height);
  for (let i = 0; i < bitmap.data.length; i++) {
    const g = bitmap.data[i] ?? 0;
    const p = i * 4;
    img.data[p] = Math.round(g * 0.18);
    img.data[p + 1] = g;
    img.data[p + 2] = Math.round(g * 0.36);
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderCompanionApp(
  root: HTMLElement,
  state: CompanionViewState,
  handlers: CompanionUiHandlers
): void {
  const activeDetails = root.querySelector<HTMLDetailsElement>('.connectors-disclosure')?.open ?? false;
  const focusedId = (document.activeElement as HTMLElement | null)?.id || '';

  const p = state.snapshot?.pairing;
  const connectors = p?.connectors;
  const bridgeBadge = state.bridgeConnected ? 'G2 Bridge Active' : 'Companion Console';
  const pairBadge = p?.paired
    ? `Paired (${p.code6})`
    : `Waiting pair code ${p?.code6 ?? '482910'}`;

  const pendingAction = state.snapshot?.ledger.find((a) => a.status === 'pending_undo') ?? null;
  const pendingRemSec = pendingAction
    ? Math.max(0, (pendingAction.executeAtMs - Date.now()) / 1000).toFixed(1)
    : '0.0';

  const topUndoBanner = pendingAction
    ? `<div class="banner banner--ok" role="status">
         <span>Staged: <strong>${escapeHtml(pendingAction.summary)}</strong> (dispatching in ${pendingRemSec}s)</span>
         <span>
           <button type="button" class="btn btn--danger btn--sm" data-undo-id="${escapeHtml(pendingAction.id)}">Undo action</button>
           <button type="button" class="btn btn--line btn--sm" data-commit-id="${escapeHtml(pendingAction.id)}">Commit now</button>
         </span>
       </div>`
    : '';

  const errorBanner = state.errorText
    ? `<div class="banner banner--error" role="alert">
         <span>Gateway connection issue: ${escapeHtml(state.errorText)}</span>
         <button type="button" class="btn btn--line btn--sm" id="btn-retry-sync">Retry sync</button>
       </div>`
    : '';

  const rowsHtml = state.loading
    ? `<tr><td colspan="4"><div class="skeleton-row"></div></td></tr>`
    : (state.snapshot?.ledger.length ?? 0) === 0
      ? `<tr>
           <td colspan="4">
             <span class="section-meta">No staged or executed writes yet. Tap any G2 card action or run a simulated Telegram event to inspect the 3s undo guard.</span>
           </td>
         </tr>`
      : (state.snapshot?.ledger ?? [])
          .slice(0, 8)
          .map((row) => {
            const ts = new Date(row.stagedAtMs).toTimeString().slice(0, 8);
            const tagClass =
              row.status === 'pending_undo'
                ? 'status-tag--pending'
                : row.status === 'executed'
                  ? 'status-tag--executed'
                  : row.status === 'failed'
                    ? 'status-tag--failed'
                    : 'status-tag--undone';
            const statusText =
              row.status === 'pending_undo'
                ? `3s undo (${Math.max(0, (row.executeAtMs - Date.now()) / 1000).toFixed(1)}s)`
                : row.status;
            const actionCell =
              row.status === 'pending_undo'
                ? `<button type="button" class="btn btn--danger btn--sm" data-undo-id="${escapeHtml(row.id)}">Undo action</button>`
                : `<span class="section-meta">${escapeHtml(row.receiptText || row.errorText || 'Recorded')}</span>`;
            return `<tr>
              <td class="num">${escapeHtml(ts)}</td>
              <td>${escapeHtml(row.kind.replace('_', ' '))}</td>
              <td>${escapeHtml(row.summary)}</td>
              <td><span class="status-tag ${tagClass}">${escapeHtml(statusText)}</span></td>
              <td>${actionCell}</td>
            </tr>`;
          })
          .join('');

  const listItemsHtml = state.built.listItems
    .map(
      (label, i) =>
        `<li class="lens-list-item ${i === state.vm.selectedActionIndex ? 'is-selected' : ''}" data-lens-idx="${i}">
           <span>${i === state.vm.selectedActionIndex ? '> ' : '  '}${escapeHtml(label)}</span>
         </li>`
    )
    .join('');

  const topBitmapMode = state.vm.mode === 'NOW' || state.vm.mode === 'UNDO';

  root.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand-group">
          <h1 class="brand-mark">
            <span class="brand-signal" aria-hidden="true"></span>
            Cue
          </h1>
          <span class="topbar-status">Hands-free Even G2 workspace & Telegram assistant</span>
        </div>
        <div class="topbar-actions">
          <span class="pill ${state.bridgeConnected ? 'pill--live' : ''}">${escapeHtml(bridgeBadge)}</span>
          <span class="pill ${p?.paired ? 'pill--live' : ''}">${escapeHtml(pairBadge)}</span>
          <button type="button" class="btn btn--sm" id="btn-top-pair">
            ${p?.paired ? 'Open pair view' : 'Pair glasses'}
          </button>
        </div>
      </div>
    </header>

    <main class="workspace">
      <section class="panel" aria-label="Waveguide optical mirror">
        <div class="section-head">
          <h2 class="section-title">Even G2 optical mirror (576 x 288)</h2>
          <span class="section-meta">${escapeHtml(state.lastEventLabel)}</span>
        </div>

        <div class="ticks">
          <div class="lens-frame" aria-live="polite">
            <div class="lens-top-row">
              <div class="lens-header-txt">${escapeHtml(state.built.headerText)}</div>
              ${topBitmapMode ? '<canvas id="lens-bitmap-canvas" class="lens-bitmap" aria-label="G2 monochrome bitmap"></canvas>' : ''}
            </div>

            <div class="lens-body-split">
              <div class="lens-body-txt">${escapeHtml(state.built.bodyText)}</div>
              ${!topBitmapMode ? '<canvas id="lens-bitmap-canvas" class="lens-bitmap" aria-label="G2 monochrome bitmap"></canvas>' : ''}
            </div>

            <ul class="lens-list" role="listbox" aria-label="G2 container list">
              ${listItemsHtml}
            </ul>

            <div class="lens-footer-txt">${escapeHtml(state.built.footerText)}</div>
          </div>
        </div>

        <div class="controls-grid" aria-label="Hardware gesture deck">
          <button type="button" class="btn btn--sm" id="btn-g2-tap">Tap action</button>
          <button type="button" class="btn btn--line btn--sm" id="btn-g2-scroll-up">Scroll prev</button>
          <button type="button" class="btn btn--line btn--sm" id="btn-g2-scroll-down">Scroll next</button>
          <button type="button" class="btn btn--line btn--sm" id="btn-g2-dbl">Double tap</button>
          <button type="button" class="btn btn--line btn--sm" id="btn-g2-voice">Run voice cmd</button>
        </div>

        <div class="controls-grid" aria-label="G2 OS menu switcher">
          <button type="button" class="btn btn--line btn--sm" data-menu-id="${MENU_IDS.NOW}">Now brief</button>
          <button type="button" class="btn btn--line btn--sm" data-menu-id="${MENU_IDS.TELEGRAM}">Telegram inbox</button>
          <button type="button" class="btn btn--line btn--sm" data-menu-id="${MENU_IDS.NOTION}">Notion tasks</button>
          <button type="button" class="btn btn--line btn--sm" data-menu-id="${MENU_IDS.VOICE}">Voice screen</button>
          <button type="button" class="btn btn--line btn--sm" data-menu-id="${MENU_IDS.PAIR}">Pair QR screen</button>
        </div>

        <div class="telemetry-strip">
          <div class="stat-cell">
            <div class="stat-label">Telegram channel</div>
            <div class="stat-value">${escapeHtml(connectors?.telegram === 'live' ? `@${connectors.telegramBotUsername || 'bot'}` : 'Sandbox feed')}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">AI brief engine</div>
            <div class="stat-value">${escapeHtml(connectors?.aiProvider ?? 'deterministic')}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-label">Queued actions</div>
            <div class="stat-value">${state.snapshot?.ledger.length ?? 0} total</div>
          </div>
        </div>
      </section>

      <section class="panel" aria-label="Pairing and write ledger">
        <div class="section-head">
          <h2 class="section-title">Pairing, triggers & 3s undo ledger</h2>
          <span class="section-meta">Zero API keys stored in browser</span>
        </div>

        ${errorBanner}
        ${topUndoBanner}

        <form id="pair-form" class="row-form">
          <label class="visually-hidden" for="input-pair-code">Six-digit pairing code</label>
          <input
            id="input-pair-code"
            class="field-input field-input--code"
            type="text"
            inputmode="numeric"
            maxlength="6"
            pattern="\\d{6}"
            value="${escapeHtml(p?.code6 ?? '482910')}"
            aria-label="Six-digit pairing code"
          />
          <button type="submit" class="btn btn--sm" id="btn-pair-claim">Confirm pair code</button>
          <button type="button" class="btn btn--line btn--sm" id="btn-pair-regen">New code</button>
        </form>

        <div class="row-form">
          <input
            id="input-voice-hint"
            class="field-input field-input--wide"
            type="text"
            value="Tell Priya 2:40 works and add Notion task lock SDK v2"
            aria-label="Spoken voice command simulation"
          />
          <button type="button" class="btn btn--line btn--sm" id="btn-run-voice-text">Parse dual intent</button>
        </div>

        <div class="controls-grid" aria-label="Incoming workspace triggers">
          <button type="button" class="btn btn--line btn--sm" data-sim="telegram_urgent">Push Telegram DM</button>
          <button type="button" class="btn btn--line btn--sm" data-sim="meeting_shift">Shift meeting T-5m</button>
          <button type="button" class="btn btn--line btn--sm" data-sim="notion_blocker">Push Notion P0</button>
        </div>

        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Target</th>
                <th>Action summary</th>
                <th>Status</th>
                <th>Receipt / Guard</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>

        <details class="connectors-disclosure" ${activeDetails ? 'open' : ''}>
          <summary class="connectors-summary">
            <span>Server-side live connectors (Telegram Bot, OpenRouter, Notion, Calendar ICS)</span>
            <span class="section-meta">${connectors?.telegram === 'live' || connectors?.notion === 'live' ? 'Live key active' : 'Optional live setup'}</span>
          </summary>
          <form id="connectors-form" class="connectors-grid">
            <label class="field-label">
              <span>Telegram bot token (@BotFather)</span>
              <input name="telegramBotToken" type="password" class="field-input" placeholder="Bot token from @BotFather" autocomplete="off" />
            </label>
            <label class="field-label">
              <span>OpenRouter API key</span>
              <input name="openrouterApiKey" type="password" class="field-input" placeholder="OpenRouter API key" autocomplete="off" />
            </label>
            <label class="field-label">
              <span>Notion internal secret</span>
              <input name="notionApiKey" type="password" class="field-input" placeholder="Notion integration secret" autocomplete="off" />
            </label>
            <label class="field-label">
              <span>Notion database ID</span>
              <input name="notionDatabaseId" type="text" class="field-input" placeholder="32-char UUID" autocomplete="off" />
            </label>
            <label class="field-label">
              <span>Google Calendar ICS URL</span>
              <input name="googleCalendarIcsUrl" type="url" class="field-input" placeholder="https://calendar.google.com/..." autocomplete="off" />
            </label>
            <div class="row-form">
              <button type="submit" class="btn btn--sm" ${state.saveStatus === 'saving' ? 'disabled' : ''}>
                ${state.saveStatus === 'saving' ? 'Saving tokens…' : 'Save connectors'}
              </button>
              ${state.saveMessage ? `<span class="section-meta">${escapeHtml(state.saveMessage)}</span>` : ''}
            </div>
          </form>
        </details>
      </section>
    </main>

    <footer class="footer-bar">
      <span>Cue for Even Realities G2 (package dev.yashh.cue)</span>
      <span>Built during Heads Up Hackathon · AI Assistants & Work + Two-Way Telegram</span>
    </footer>
  `;

  const bitmapCanvas = root.querySelector<HTMLCanvasElement>('#lens-bitmap-canvas');
  if (bitmapCanvas) {
    drawGray8ToCanvas(bitmapCanvas, state.built.bitmap);
  }

  root.querySelector('#btn-top-pair')?.addEventListener('click', () => handlers.onMenuSelect(MENU_IDS.PAIR));
  root.querySelector('#btn-retry-sync')?.addEventListener('click', () => handlers.onRetrySync());
  root.querySelector('#btn-g2-tap')?.addEventListener('click', () => handlers.onTap());
  root.querySelector('#btn-g2-scroll-up')?.addEventListener('click', () => handlers.onScroll('up'));
  root.querySelector('#btn-g2-scroll-down')?.addEventListener('click', () => handlers.onScroll('down'));
  root.querySelector('#btn-g2-dbl')?.addEventListener('click', () => handlers.onDoubleTap());
  root.querySelector('#btn-g2-voice')?.addEventListener('click', () => {
    const val = root.querySelector<HTMLInputElement>('#input-voice-hint')?.value || '';
    handlers.onVoiceRun(val);
  });
  root.querySelector('#btn-run-voice-text')?.addEventListener('click', () => {
    const val = root.querySelector<HTMLInputElement>('#input-voice-hint')?.value || '';
    handlers.onVoiceRun(val);
  });

  for (const li of root.querySelectorAll<HTMLElement>('[data-lens-idx]')) {
    li.addEventListener('click', () => {
      const idx = Number(li.dataset.lensIdx || '0');
      handlers.onTap(idx);
    });
  }

  for (const btn of root.querySelectorAll<HTMLElement>('[data-menu-id]')) {
    btn.addEventListener('click', () => handlers.onMenuSelect(Number(btn.dataset.menuId || '1')));
  }

  for (const btn of root.querySelectorAll<HTMLElement>('[data-sim]')) {
    btn.addEventListener('click', () => {
      const sc = btn.dataset.sim as 'telegram_urgent' | 'meeting_shift' | 'notion_blocker';
      handlers.onSimulateEvent(sc);
    });
  }

  for (const btn of root.querySelectorAll<HTMLElement>('[data-undo-id]')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.undoId) handlers.onUndoAction(btn.dataset.undoId);
    });
  }

  for (const btn of root.querySelectorAll<HTMLElement>('[data-commit-id]')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.commitId) handlers.onCommitNow(btn.dataset.commitId);
    });
  }

  root.querySelector('#pair-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = root.querySelector<HTMLInputElement>('#input-pair-code')?.value || '';
    handlers.onPairSubmit(val);
  });
  root.querySelector('#btn-pair-regen')?.addEventListener('click', () => handlers.onPairRegenerate());

  root.querySelector('#connectors-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const out: Record<string, string> = {};
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    void handlers.onSaveConnectors(out);
  });

  if (focusedId) {
    const restore = root.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`);
    if (restore && restore !== document.activeElement) {
      restore.focus();
    }
  }
}
