import { G2Controller } from './g2/controller.ts';
import { renderCompanionApp, type CompanionUiHandlers, type CompanionViewState } from './companion/render.ts';
import type { CueSnapshot } from './shared/protocol.ts';

const rootEl = document.getElementById('app');
if (!rootEl) {
  throw new Error('Missing #app mount root');
}

const g2 = new G2Controller();
let latestView: CompanionViewState | null = null;
let uiLoading = true;
let uiError = '';
let saveStatus: 'idle' | 'saving' | 'saved' | 'error' = 'idle';
let saveMessage = '';
let sse: EventSource | null = null;

async function postJson(url: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as { error?: string };
      uiError = err.error || `HTTP ${r.status}`;
      renderNow();
      return false;
    }
    uiError = '';
    return true;
  } catch (err) {
    uiError = err instanceof Error ? err.message : String(err);
    renderNow();
    return false;
  }
}

async function fetchInitialSnapshot(): Promise<void> {
  uiLoading = true;
  renderNow();
  try {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const snap = (await r.json()) as CueSnapshot;
    uiLoading = false;
    uiError = '';
    g2.applySnapshot(snap);
  } catch (err) {
    uiLoading = false;
    uiError = err instanceof Error ? err.message : 'Unable to reach local gateway (:8787)';
    renderNow();
  }
}

function connectSse(): void {
  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  const events = [
    'snapshot',
    'card_updated',
    'action_staged',
    'action_executed',
    'action_undone',
    'action_failed',
    'paired',
    'connectors_updated',
  ];
  for (const name of events) {
    sse.addEventListener(name, (ev) => {
      try {
        const snap = JSON.parse((ev as MessageEvent<string>).data) as CueSnapshot;
        uiLoading = false;
        uiError = '';
        g2.applySnapshot(snap);
      } catch {
        // Ignore malformed frame
      }
    });
  }
  sse.onerror = () => {
    uiError = 'Live SSE stream reconnecting…';
    renderNow();
  };
}

const handlers: CompanionUiHandlers = {
  onPairSubmit: (code6) => {
    void postJson('/api/pair/claim', { code6, source: 'Web Companion' }).then(() => fetchInitialSnapshot());
  },
  onPairRegenerate: () => {
    void postJson('/api/pair/init', {}).then(() => fetchInitialSnapshot());
  },
  onSimulateEvent: (scenario) => {
    void postJson('/api/simulate/event', { scenario });
  },
  onUndoAction: (actionId) => {
    void postJson(`/api/actions/${actionId}/undo`, {});
  },
  onCommitNow: (actionId) => {
    void postJson(`/api/actions/${actionId}/commit-now`, {});
  },
  onTap: (idx) => {
    void g2.simulateTap(idx);
  },
  onDoubleTap: () => {
    void g2.simulateDoubleTap();
  },
  onScroll: (dir) => {
    void g2.simulateScroll(dir);
  },
  onVoiceRun: (transcriptHint) => {
    void g2.simulateHoldStart().then(() =>
      setTimeout(() => {
        void g2.simulateHoldRelease(transcriptHint);
      }, 600)
    );
  },
  onMenuSelect: (menuId) => {
    void g2.triggerMenu(menuId);
  },
  onSaveConnectors: async (payload) => {
    saveStatus = 'saving';
    saveMessage = 'Applying server-side configuration…';
    renderNow();
    const ok = await postJson('/api/config/connectors', payload);
    saveStatus = ok ? 'saved' : 'error';
    saveMessage = ok ? 'Connectors updated cleanly.' : uiError || 'Failed to update connectors';
    await fetchInitialSnapshot();
  },
  onRetrySync: () => {
    connectSse();
    void fetchInitialSnapshot();
  },
};

function renderNow(): void {
  if (!latestView || !rootEl) return;
  renderCompanionApp(
    rootEl,
    {
      ...latestView,
      loading: uiLoading,
      errorText: uiError,
      saveStatus,
      saveMessage,
    },
    handlers
  );
}

g2.subscribe((mirrorState) => {
  latestView = {
    ...mirrorState,
    loading: uiLoading,
    errorText: uiError,
    saveStatus,
    saveMessage,
  };
  renderNow();
});

void g2.init().then(() => {
  connectSse();
  void fetchInitialSnapshot();
});
