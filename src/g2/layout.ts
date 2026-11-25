import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  utf8ByteLength,
  validateEvenHubPageContainer,
  formatEvenHubPageContainerValidationError,
} from '@evenrealities/even_hub_sdk';
import type { CueCard, G2FilterCategory, G2ScreenMode, QueuedWriteAction, VoiceIntentResult } from '../shared/protocol.ts';
import type { Gray8Bitmap } from './bitmaps.ts';
import { renderHorizonBar, renderPairingMatrix, renderVoiceWaveform } from './bitmaps.ts';

export const G2_WIDTH = 576;
export const G2_HEIGHT = 288;

export const CONTAINER_IDS = {
  HEADER: 1,
  BODY: 2,
  IMAGE: 3,
  ACTIONS: 4,
  FOOTER: 5,
} as const;

export const MENU_IDS = {
  NOW: 1,
  TELEGRAM: 2,
  NOTION: 3,
  VOICE: 4,
  PAIR: 5,
} as const;

export interface G2ViewModel {
  mode: G2ScreenMode;
  filter: G2FilterCategory;
  code6: string;
  paired: boolean;
  connectorsSummary: string;
  cards: CueCard[];
  cardIndex: number;
  selectedActionIndex: number;
  pendingUndo: QueuedWriteAction | null;
  voiceIntent: VoiceIntentResult | null;
  pcmSamples: Uint8Array;
  voiceTick: number;
  statusBanner?: string;
}

export interface G2BuiltPage {
  headerText: string;
  bodyText: string;
  listItems: string[];
  footerText: string;
  bitmap: Gray8Bitmap;
  imageContainerId: number;
  imageContainerName: string;
  payload: {
    containerTotalNum: number;
    textObject: TextContainerProperty[];
    imageObject: ImageContainerProperty[];
    listObject: ListContainerProperty[];
    menuObject: MenuContainerProperty;
  };
}

export function truncateG2Text(input: string, maxChars: number): string {
  const clean = input.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}~`;
}

export function buildMenuObject(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemID: MENU_IDS.NOW, itemName: 'Now Brief' }),
      new MenuItemProperty({ itemID: MENU_IDS.TELEGRAM, itemName: 'Telegram Inbox' }),
      new MenuItemProperty({ itemID: MENU_IDS.NOTION, itemName: 'Notion Tasks' }),
      new MenuItemProperty({ itemID: MENU_IDS.VOICE, itemName: 'Voice Command' }),
      new MenuItemProperty({ itemID: MENU_IDS.PAIR, itemName: 'Pair & Status' }),
    ],
  });
}

export function filterCards(cards: CueCard[], filter: G2FilterCategory): CueCard[] {
  if (filter === 'telegram') return cards.filter((c) => c.kind === 'telegram');
  if (filter === 'notion') return cards.filter((c) => c.kind === 'notion');
  return cards;
}

export function buildG2Page(vm: G2ViewModel): G2BuiltPage {
  const filtered = filterCards(vm.cards, vm.filter);
  const safeIdx = filtered.length > 0 ? ((vm.cardIndex % filtered.length) + filtered.length) % filtered.length : 0;
  const activeCard = filtered[safeIdx];

  let headerText = '';
  let bodyText = '';
  let listItems: string[] = [];
  let footerText = '';
  let bitmap: Gray8Bitmap;
  let bodyWidth = 544;
  let bodyY = 34;
  let bodyH = 84;
  let headerWidth = 300;
  let imgX = 320;
  let imgY = 6;
  let imgW = 240;
  let imgH = 24;
  let listY = 122;
  let listH = 132;

  if (vm.mode === 'PAIR') {
    headerWidth = 544;
    headerText = `CUE · ${vm.paired ? 'PAIRED OK' : 'PAIR GLASSES'} · ${vm.connectorsSummary}`;
    bodyWidth = 392;
    bodyY = 36;
    bodyH = 112;
    bodyText = [
      `PAIR CODE: ${vm.code6}`,
      vm.paired
        ? 'Connected via Companion/TG. Select below to enter HUD.'
        : `Send /pair ${vm.code6} in TG or enter in Companion.`,
      vm.statusBanner ? vm.statusBanner : 'No WebView Google login needed.',
    ].join('\n');
    bitmap = renderPairingMatrix(vm.code6, 'cue-g2');
    imgX = 432;
    imgY = 36;
    imgW = bitmap.width;
    imgH = bitmap.height;
    listY = 156;
    listH = 98;
    listItems = vm.paired
      ? ['Open Now Brief HUD', 'Regenerate 6-Digit Code']
      : ['Pair This Session Now', 'Open Demo HUD Anyway'];
    footerText = '[TAP] Confirm   [MENU] Switch View';
  } else if (vm.mode === 'UNDO' && vm.pendingUndo) {
    const remMs = Math.max(0, vm.pendingUndo.executeAtMs - Date.now());
    const remSec = (remMs / 1000).toFixed(1);
    headerText = `CUE · 3S UNDO GUARD · ${remSec}s`;
    bitmap = renderHorizonBar(0, 0, 1, remMs);
    bodyText = [
      `STAGED: ${truncateG2Text(vm.pendingUndo.summary, 38)}`,
      `Target: ${vm.pendingUndo.kind.replace('_', ' ')}`,
      `Dispatching in ${remSec}s unless cancelled below.`,
    ].join('\n');
    listItems = ['UNDO ACTION NOW', 'COMMIT IMMEDIATELY'];
    footerText = '[TAP] Cancel Write   [2xTAP] Abort';
  } else if (vm.mode === 'VOICE') {
    headerWidth = 544;
    headerText = 'CUE · HANDS-FREE VOICE INTENT';
    bitmap = renderVoiceWaveform(vm.pcmSamples, vm.voiceTick);
    imgX = 16;
    imgY = 36;
    imgW = bitmap.width;
    imgH = bitmap.height;
    bodyY = 78;
    bodyH = 56;
    const intent = vm.voiceIntent;
    bodyText = intent
      ? [
          `HEARD: ${truncateG2Text(intent.transcript, 38)}`,
          `PLAN [${intent.mode.toUpperCase()}]: ${truncateG2Text(intent.summary, 34)}`,
        ].join('\n')
      : [
          'Listening via G2 mic PCM stream...',
          'Say e.g. "Tell Priya 2:40 works & add Notion task"',
        ].join('\n');
    listY = 138;
    listH = 116;
    listItems = intent
      ? [truncateG2Text(intent.proposedAction.label, 30), 'Re-capture Voice Sample', 'Back to Now Brief']
      : ['Parse Sample Dual Command', 'Back to Now Brief'];
    footerText = '[TAP] Parse Command   [2xTAP] Back';
  } else {
    const cardNum = filtered.length > 0 ? `${safeIdx + 1}/${filtered.length}` : '0/0';
    const urgencyLabel = activeCard ? `T-${activeCard.urgencyMinutes}M` : 'IDLE';
    const modeTag = activeCard?.briefMode === 'ai' ? 'AI' : 'DET';
    headerText = `CUE · ${urgencyLabel} · ${cardNum} [${modeTag}]`;
    bitmap = renderHorizonBar(activeCard?.urgencyMinutes ?? 30, safeIdx, Math.max(1, filtered.length));
    if (activeCard) {
      bodyText = [
        truncateG2Text(activeCard.title, 40),
        truncateG2Text(activeCard.subtitle, 42),
        truncateG2Text(activeCard.contextLine, 42),
      ].join('\n');
      listItems = activeCard.actions.slice(0, 2).map((a) => truncateG2Text(a.label, 30));
      if (filtered.length > 1) {
        listItems.push(truncateG2Text(`Next Card -> (${safeIdx + 1}/${filtered.length})`, 30));
      }
    } else {
      bodyText = `No ${vm.filter} items right now.\nAll caught up.`;
      listItems = ['Switch to All Cards', 'Open Voice Command'];
    }
    footerText = '[TAP] Act (3s)  [SCROLL] Select  [HOLD] Mic';
  }

  const sanitizedItems = listItems.slice(0, 3).map((item) => {
    const clipped = truncateG2Text(item || 'Action', 30);
    return utf8ByteLength(clipped) <= 32 ? clipped : clipped.slice(0, 28);
  });

  const textObject = [
    new TextContainerProperty({
      containerID: CONTAINER_IDS.HEADER,
      containerName: 'cue-header',
      xPosition: 16,
      yPosition: 6,
      width: headerWidth,
      height: 24,
      content: headerText,
      textColor: 2,
      isEventCapture: 0,
      zOrderIndex: 0,
    }),
    new TextContainerProperty({
      containerID: CONTAINER_IDS.BODY,
      containerName: 'cue-body',
      xPosition: 16,
      yPosition: bodyY,
      width: bodyWidth,
      height: bodyH,
      content: bodyText,
      textColor: 4,
      isEventCapture: 0,
      zOrderIndex: 1,
    }),
    new TextContainerProperty({
      containerID: CONTAINER_IDS.FOOTER,
      containerName: 'cue-footer',
      xPosition: 16,
      yPosition: 258,
      width: 544,
      height: 24,
      content: vm.statusBanner && vm.mode !== 'PAIR' ? truncateG2Text(vm.statusBanner, 46) : footerText,
      textColor: 2,
      isEventCapture: 0,
      zOrderIndex: 4,
    }),
  ];

  const imageObject = [
    new ImageContainerProperty({
      containerID: CONTAINER_IDS.IMAGE,
      containerName: 'cue-bitmap',
      xPosition: imgX,
      yPosition: imgY,
      width: imgW,
      height: imgH,
      zOrderIndex: 2,
    }),
  ];

  const listObject = [
    new ListContainerProperty({
      containerID: CONTAINER_IDS.ACTIONS,
      containerName: 'cue-actions',
      xPosition: 16,
      yPosition: listY,
      width: 544,
      height: listH,
      borderWidth: 1,
      borderColor: 2,
      borderRadius: 4,
      paddingLength: 2,
      isEventCapture: 1,
      zOrderIndex: 3,
      itemContainer: new ListItemContainerProperty({
        itemCount: sanitizedItems.length,
        itemWidth: 520,
        isItemSelectBorderEn: 1,
        itemName: sanitizedItems,
      }),
    }),
  ];

  const menuObject = buildMenuObject();
  const containerTotalNum = textObject.length + imageObject.length + listObject.length;

  const payload = {
    containerTotalNum,
    textObject,
    imageObject,
    listObject,
    menuObject,
  };

  assertValidG2Payload(payload);

  return {
    headerText,
    bodyText,
    listItems: sanitizedItems,
    footerText,
    bitmap,
    imageContainerId: CONTAINER_IDS.IMAGE,
    imageContainerName: 'cue-bitmap',
    payload,
  };
}

/**
 * Validates SDK rules + firmware hardware invariants BEFORE any bridge call.
 */
export function assertValidG2Payload(payload: G2BuiltPage['payload']): void {
  const sdkRes = validateEvenHubPageContainer(payload);
  if (!sdkRes.valid) {
    throw new Error(`SDK Page Validation Failed: ${formatEvenHubPageContainerValidationError(sdkRes)}`);
  }

  const all = [...payload.textObject, ...payload.imageObject, ...payload.listObject];
  if (payload.containerTotalNum !== all.length || payload.containerTotalNum < 1 || payload.containerTotalNum > 12) {
    throw new Error(`Invalid containerTotalNum=${payload.containerTotalNum} vs actual=${all.length}`);
  }

  let captureCount = 0;
  for (const c of payload.textObject) {
    if (c.isEventCapture === 1) captureCount++;
    if (c.textColor !== undefined && (c.textColor < 0 || c.textColor > 4)) {
      throw new Error(`Invalid textColor ${c.textColor}`);
    }
  }
  for (const l of payload.listObject) {
    if (l.isEventCapture === 1) captureCount++;
  }
  if (captureCount > 1) {
    throw new Error(`Firmware invariant violated: ${captureCount} event listeners on one page (max 1)`);
  }

  for (const img of payload.imageObject) {
    const w = img.width ?? 0;
    const h = img.height ?? 0;
    if (w < 20 || w > 288 || h < 20 || h > 144) {
      throw new Error(`ImageContainerProperty ${w}x${h} outside firmware bounds 20..288 x 20..144`);
    }
  }
}

export function toStartUpContainer(built: G2BuiltPage): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer(built.payload);
}

export function toRebuildContainer(built: G2BuiltPage): RebuildPageContainer {
  return new RebuildPageContainer(built.payload);
}

export function toUndoCountdownUpgrade(remMs: number): TextContainerUpgrade {
  const sec = (Math.max(0, remMs) / 1000).toFixed(1);
  return new TextContainerUpgrade({
    containerID: CONTAINER_IDS.HEADER,
    containerName: 'cue-header',
    content: `CUE · 3S UNDO GUARD · ${sec}s`,
    textColor: 4,
  });
}
