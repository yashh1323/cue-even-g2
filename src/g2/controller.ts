import {
  AudioInputSource,
  ImageRawDataUpdate,
  OsEventTypeList,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type {
  CueCard,
  CueDraftAction,
  CueSnapshot,
  G2FilterCategory,
  G2ScreenMode,
  QueuedWriteAction,
  VoiceIntentResult,
} from '../shared/protocol.ts';
import { renderVoiceWaveform } from './bitmaps.ts';
import {
  buildG2Page,
  CONTAINER_IDS,
  filterCards,
  MENU_IDS,
  toRebuildContainer,
  toStartUpContainer,
  toUndoCountdownUpgrade,
  type G2BuiltPage,
  type G2ViewModel,
} from './layout.ts';

export type MirrorListener = (state: {
  bridgeConnected: boolean;
  built: G2BuiltPage;
  vm: G2ViewModel;
  snapshot: CueSnapshot | null;
  lastEventLabel: string;
}) => void;

export class G2Controller {
  private bridge: EvenAppBridge | null = null;
  private bridgeConnected = false;
  private startupDone = false;
  private snapshot: CueSnapshot | null = null;
  private mode: G2ScreenMode = 'NOW';
  private filter: G2FilterCategory = 'all';
  private cardIndex = 0;
  private selectedActionIndex = 0;
  private pendingUndo: QueuedWriteAction | null = null;
  private voiceIntent: VoiceIntentResult | null = null;
  private pcmSamples: Uint8Array = new Uint8Array(0);
  private voiceTick = 0;
  private statusBanner = '';
  private lastEventLabel = 'Initializing…';
  private lastBitmapPushMs = 0;
  private undoTickTimer: ReturnType<typeof setInterval> | null = null;
  private voicePulseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<MirrorListener>();

  subscribe(fn: MirrorListener): () => void {
    this.listeners.add(fn);
    this.emitMirror();
    return () => this.listeners.delete(fn);
  }

  getViewModel(): G2ViewModel {
    const p = this.snapshot?.pairing;
    const c = p?.connectors;
    const connectorsSummary = c
      ? `TG:${c.telegram === 'live' ? 'LIVE' : 'SBX'} AI:${c.ai === 'live' ? 'LIVE' : 'DET'}`
      : 'CONNECTING';
    return {
      mode: this.mode,
      filter: this.filter,
      code6: p?.code6 ?? '482910',
      paired: p?.paired ?? false,
      connectorsSummary,
      cards: this.snapshot?.cards ?? [],
      cardIndex: this.cardIndex,
      selectedActionIndex: this.selectedActionIndex,
      pendingUndo: this.pendingUndo,
      voiceIntent: this.voiceIntent,
      pcmSamples: this.pcmSamples,
      voiceTick: this.voiceTick,
      statusBanner: this.statusBanner || undefined,
    };
  }

  async init(): Promise<void> {
    this.bridge = await this.connectBridgeWithTimeout(1400);
    if (this.bridge) {
      this.bridgeConnected = true;
      this.lastEventLabel = 'EvenAppBridge connected';
      this.bridge.onEvenHubEvent((ev) => this.handleBridgeEvent(ev));
      try {
        const savedMode = await this.bridge.getLocalStorage('cue_filter');
        if (savedMode === 'telegram' || savedMode === 'notion' || savedMode === 'all') {
          this.filter = savedMode;
        }
      } catch {
        // Ignore bridge localStorage error in early init
      }
    } else {
      this.lastEventLabel = 'Browser Companion Mode (simulator bridge not present)';
    }

    await this.renderCurrentPage();
  }

  applySnapshot(snap: CueSnapshot): void {
    const prevPaired = this.snapshot?.pairing.paired;
    this.snapshot = snap;
    this.pendingUndo = snap.ledger.find((l) => l.status === 'pending_undo') ?? null;

    if (this.pendingUndo && this.mode !== 'UNDO') {
      this.mode = 'UNDO';
      this.startUndoTicker();
    } else if (!this.pendingUndo && this.mode === 'UNDO') {
      this.stopUndoTicker();
      this.mode = 'NOW';
      const latest = snap.ledger[0];
      if (latest?.status === 'executed') {
        this.statusBanner = `Executed: ${latest.summary}`;
      } else if (latest?.status === 'undone') {
        this.statusBanner = 'Cancelled inside 3s undo window';
      }
    }

    if (prevPaired === false && snap.pairing.paired && this.mode === 'PAIR') {
      this.mode = 'NOW';
      this.statusBanner = `Paired (${snap.pairing.code6})`;
    } else if (prevPaired === true && !snap.pairing.paired) {
      this.mode = 'PAIR';
      this.statusBanner = 'Awaiting pair code';
    }

    void this.renderCurrentPage();
  }

  setMode(mode: G2ScreenMode): void {
    this.mode = mode;
    if (mode !== 'UNDO') this.stopUndoTicker();
    if (mode !== 'VOICE') this.stopVoicePulse();
    this.lastEventLabel = `Mode -> ${mode}`;
    void this.renderCurrentPage();
  }

  setFilter(filter: G2FilterCategory): void {
    this.filter = filter;
    this.cardIndex = 0;
    this.selectedActionIndex = 0;
    this.mode = 'NOW';
    if (this.bridge) {
      void this.bridge.setLocalStorage('cue_filter', filter).catch(() => undefined);
    }
    this.lastEventLabel = `Filter -> ${filter}`;
    void this.renderCurrentPage();
  }

  async simulateTap(selectedIndex?: number): Promise<void> {
    if (typeof selectedIndex === 'number') {
      this.selectedActionIndex = selectedIndex;
    }
    await this.handleClick(this.selectedActionIndex);
  }

  async simulateScroll(direction: 'up' | 'down'): Promise<void> {
    const filtered = filterCards(this.snapshot?.cards ?? [], this.filter);
    if (filtered.length === 0) return;
    if (this.mode === 'NOW') {
      this.cardIndex =
        direction === 'down'
          ? (this.cardIndex + 1) % filtered.length
          : (this.cardIndex - 1 + filtered.length) % filtered.length;
      this.selectedActionIndex = 0;
      this.lastEventLabel = `Scroll ${direction} -> Card ${this.cardIndex + 1}/${filtered.length}`;
      await this.renderCurrentPage();
    }
  }

  async simulateDoubleTap(): Promise<void> {
    await this.handleDoubleClick();
  }

  async simulateHoldStart(): Promise<void> {
    await this.startVoiceCapture();
  }

  async simulateHoldRelease(transcriptHint?: string): Promise<void> {
    await this.finishVoiceCapture(transcriptHint);
  }

  async triggerMenu(menuId: number): Promise<void> {
    switch (menuId) {
      case MENU_IDS.NOW:
        this.setFilter('all');
        break;
      case MENU_IDS.TELEGRAM:
        this.setFilter('telegram');
        break;
      case MENU_IDS.NOTION:
        this.setFilter('notion');
        break;
      case MENU_IDS.VOICE:
        await this.startVoiceCapture();
        break;
      case MENU_IDS.PAIR:
        this.setMode('PAIR');
        break;
    }
  }

  private async connectBridgeWithTimeout(timeoutMs: number): Promise<EvenAppBridge | null> {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { EvenAppBridge?: unknown; flutter_inappwebview?: unknown };
    if (!w.EvenAppBridge && !w.flutter_inappwebview) {
      // Wait briefly in case host injects flutter_inappwebview right after load
      const quickCheck = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(Boolean(w.EvenAppBridge || w.flutter_inappwebview));
        }, 450);
        window.addEventListener(
          'evenAppBridgeReady',
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true }
        );
      });
      if (!quickCheck) return null;
    }

    try {
      return await Promise.race([
        waitForEvenAppBridge(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
    } catch {
      return null;
    }
  }

  private handleBridgeEvent(ev: EvenHubEvent): void {
    if (ev.menuItemClickEvent?.itemID) {
      this.lastEventLabel = `OS Menu item #${ev.menuItemClickEvent.itemID}`;
      void this.triggerMenu(ev.menuItemClickEvent.itemID);
      return;
    }

    if (ev.audioEvent) {
      this.pcmSamples = ev.audioEvent.audioPcm;
      const now = Date.now();
      if (this.mode === 'VOICE' && now - this.lastBitmapPushMs >= 250) {
        this.lastBitmapPushMs = now;
        this.voiceTick++;
        const wave = renderVoiceWaveform(this.pcmSamples, this.voiceTick);
        if (this.bridge) {
          void this.bridge.updateImageRawData(
            new ImageRawDataUpdate({
              containerID: CONTAINER_IDS.IMAGE,
              containerName: 'cue-bitmap',
              imageData: wave.data,
            })
          );
        }
        this.emitMirror();
      }
      return;
    }

    if (ev.listEvent) {
      const idx = ev.listEvent.currentSelectItemIndex ?? 0;
      this.selectedActionIndex = idx;
      const et = ev.listEvent.eventType;
      if (et === OsEventTypeList.SCROLL_TOP_EVENT) {
        void this.simulateScroll('up');
        return;
      }
      if (et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        void this.simulateScroll('down');
        return;
      }
      if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        void this.handleDoubleClick();
        return;
      }
      void this.handleClick(idx);
      return;
    }

    if (ev.sysEvent) {
      const et = ev.sysEvent.eventType;
      const src = ev.sysEvent.eventSource;
      this.lastEventLabel = `Sys event=${et} src=${src ?? 'unknown'}`;
      if (et === OsEventTypeList.LONG_PRESS_EVENT) {
        void this.startVoiceCapture();
      } else if (et === OsEventTypeList.LONG_PRESS_RELEASE_EVENT && this.mode === 'VOICE') {
        void this.finishVoiceCapture();
      } else if (et === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        void this.handleDoubleClick();
      } else if (et === OsEventTypeList.SCROLL_TOP_EVENT) {
        void this.simulateScroll('up');
      } else if (et === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
        void this.simulateScroll('down');
      } else if (et === OsEventTypeList.CLICK_EVENT) {
        void this.handleClick(this.selectedActionIndex);
      }
    }
  }

  private async handleClick(selectedIdx: number): Promise<void> {
    if (this.mode === 'PAIR') {
      if (selectedIdx === 0) {
        await this.apiPost('/api/pair/claim', { code6: this.snapshot?.pairing.code6, source: 'Even G2 Ring/Temple' });
        this.mode = 'NOW';
        this.statusBanner = 'Paired on glasses';
      } else {
        await this.apiPost('/api/pair/init', {});
        this.statusBanner = 'Generated fresh 6-digit code';
      }
      await this.renderCurrentPage();
      return;
    }

    if (this.mode === 'UNDO' && this.pendingUndo) {
      if (selectedIdx === 1) {
        await this.apiPost(`/api/actions/${this.pendingUndo.id}/commit-now`, {});
        this.lastEventLabel = 'Confirmed immediate commit';
      } else {
        await this.apiPost(`/api/actions/${this.pendingUndo.id}/undo`, {});
        this.lastEventLabel = 'Undone cleanly via G2 tap';
      }
      return;
    }

    if (this.mode === 'VOICE') {
      if (!this.voiceIntent) {
        if (selectedIdx === 0) {
          await this.finishVoiceCapture('Tell Priya 2:40 works and add Notion task lock SDK v2');
        } else {
          this.setMode('NOW');
        }
        return;
      }
      if (selectedIdx === 0) {
        await this.stageAction('voice-card', this.voiceIntent.proposedAction);
        this.voiceIntent = null;
      } else if (selectedIdx === 1) {
        this.voiceIntent = null;
        await this.startVoiceCapture();
      } else {
        this.voiceIntent = null;
        this.setMode('NOW');
      }
      return;
    }

    const filtered = filterCards(this.snapshot?.cards ?? [], this.filter);
    const activeCard = filtered[this.cardIndex % Math.max(1, filtered.length)];
    if (!activeCard) {
      if (selectedIdx === 0) this.setFilter('all');
      else await this.startVoiceCapture();
      return;
    }

    const actions = activeCard.actions.slice(0, 2);
    if (selectedIdx >= actions.length) {
      this.cardIndex = (this.cardIndex + 1) % filtered.length;
      this.selectedActionIndex = 0;
      this.lastEventLabel = `Card ${this.cardIndex + 1}/${filtered.length}`;
      await this.renderCurrentPage();
      return;
    }

    const chosen = actions[selectedIdx];
    if (chosen) {
      this.lastEventLabel = `Staged "${chosen.label}"`;
      await this.stageAction(activeCard.id, chosen);
    }
  }

  private async handleDoubleClick(): Promise<void> {
    if (this.mode === 'UNDO' && this.pendingUndo) {
      await this.apiPost(`/api/actions/${this.pendingUndo.id}/undo`, {});
      return;
    }
    if (this.mode !== 'NOW') {
      this.setMode('NOW');
      return;
    }
    const order: G2FilterCategory[] = ['all', 'telegram', 'notion'];
    const next = order[(order.indexOf(this.filter) + 1) % order.length] ?? 'all';
    this.setFilter(next);
  }

  private async startVoiceCapture(): Promise<void> {
    this.mode = 'VOICE';
    this.statusBanner = '';
    this.voiceIntent = null;
    this.voiceTick = 1;
    this.pcmSamples = new Uint8Array(0);
    this.lastEventLabel = 'Recording voice via G2 mic';
    if (this.bridge) {
      await this.bridge.audioControl(true, AudioInputSource.Glasses).catch(() => undefined);
    }
    this.startVoicePulse();
    await this.renderCurrentPage();
  }

  private async finishVoiceCapture(transcriptHint?: string): Promise<void> {
    this.stopVoicePulse();
    if (this.bridge) {
      await this.bridge.audioControl(false).catch(() => undefined);
    }
    const pcmBase64 = this.pcmSamples.length > 0 ? uint8ToBase64(this.pcmSamples) : undefined;
    const intent = (await this.apiPost('/api/voice/intent', {
      transcriptHint,
      pcmBase64,
      sampleRate: 16000,
    })) as VoiceIntentResult | null;
    if (intent) {
      this.voiceIntent = intent;
      this.lastEventLabel = `Parsed: ${intent.summary}`;
    }
    await this.renderCurrentPage();
  }

  private async stageAction(cardId: string, action: CueDraftAction): Promise<void> {
    await this.apiPost('/api/actions/stage', {
      cardId,
      action,
      idempotencyKey: `${cardId}:${action.id}:${Math.floor(Date.now() / 3500)}`,
    });
  }

  private async apiPost(url: string, body: unknown): Promise<unknown> {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  private startUndoTicker(): void {
    this.stopUndoTicker();
    this.undoTickTimer = setInterval(() => {
      if (!this.pendingUndo || this.mode !== 'UNDO') {
        this.stopUndoTicker();
        return;
      }
      const rem = Math.max(0, this.pendingUndo.executeAtMs - Date.now());
      if (this.bridge) {
        void this.bridge.textContainerUpgrade(toUndoCountdownUpgrade(rem));
      }
      this.emitMirror();
    }, 300);
  }

  private stopUndoTicker(): void {
    if (this.undoTickTimer) {
      clearInterval(this.undoTickTimer);
      this.undoTickTimer = null;
    }
  }

  private startVoicePulse(): void {
    this.stopVoicePulse();
    this.voicePulseTimer = setInterval(() => {
      if (this.mode !== 'VOICE' || this.voiceIntent) {
        this.stopVoicePulse();
        return;
      }
      this.voiceTick++;
      const wave = renderVoiceWaveform(this.pcmSamples, this.voiceTick);
      if (this.bridge && Date.now() - this.lastBitmapPushMs >= 250) {
        this.lastBitmapPushMs = Date.now();
        void this.bridge.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: CONTAINER_IDS.IMAGE,
            containerName: 'cue-bitmap',
            imageData: wave.data,
          })
        );
      }
      this.emitMirror();
    }, 280);
  }

  private stopVoicePulse(): void {
    if (this.voicePulseTimer) {
      clearInterval(this.voicePulseTimer);
      this.voicePulseTimer = null;
    }
  }

  private async renderCurrentPage(): Promise<void> {
    const vm = this.getViewModel();
    const built = buildG2Page(vm);

    if (this.bridge) {
      try {
        if (!this.startupDone) {
          await this.bridge.createStartUpPageContainer(toStartUpContainer(built));
          this.startupDone = true;
        } else {
          await this.bridge.rebuildPageContainer(toRebuildContainer(built));
        }
        await this.bridge.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: built.imageContainerId,
            containerName: built.imageContainerName,
            imageData: built.bitmap.data,
          })
        );
      } catch (err) {
        this.lastEventLabel = `Bridge error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    this.emitMirror(built, vm);
  }

  private emitMirror(prebuilt?: G2BuiltPage, preVm?: G2ViewModel): void {
    const vm = preVm ?? this.getViewModel();
    const built = prebuilt ?? buildG2Page(vm);
    for (const listener of this.listeners) {
      listener({
        bridgeConnected: this.bridgeConnected,
        built,
        vm,
        snapshot: this.snapshot,
        lastEventLabel: this.lastEventLabel,
      });
    }
  }

  getCurrentCard(): CueCard | undefined {
    const filtered = filterCards(this.snapshot?.cards ?? [], this.filter);
    return filtered[this.cardIndex % Math.max(1, filtered.length)];
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin);
}
