import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderHorizonBar, renderPairingMatrix, renderVoiceWaveform } from '../src/g2/bitmaps.ts';
import { assertValidG2Payload, buildG2Page } from '../src/g2/layout.ts';
import { createInitialSeedState } from '../server/store.ts';
import { deterministicVoiceParse } from '../server/connectors/ai.ts';
import { createCueServer } from '../server/index.ts';

test('Gray8 bitmap generators produce exact firmware-bounded dimensions and luminance range', () => {
  const qr = renderPairingMatrix('482910', 'cue-g2');
  assert.equal(qr.width, 112);
  assert.equal(qr.height, 112);
  assert.equal(qr.data.length, 112 * 112);
  assert.ok(qr.data.some((px) => px > 200));

  const bar = renderHorizonBar(12, 0, 4);
  assert.equal(bar.width, 240);
  assert.equal(bar.height, 24);
  assert.equal(bar.data.length, 240 * 24);

  const wave = renderVoiceWaveform(new Uint8Array([0, 30, 120, 60, 0, -40]), 2);
  assert.equal(wave.width, 240);
  assert.equal(wave.height, 36);
  assert.equal(wave.data.length, 240 * 36);
});

test('G2 page builder passes SDK & firmware invariants across PAIR, NOW, VOICE, UNDO modes', () => {
  const seed = createInitialSeedState();
  for (const mode of ['PAIR', 'NOW', 'VOICE', 'UNDO'] as const) {
    const built = buildG2Page({
      mode,
      filter: 'all',
      code6: seed.pairing.code6,
      paired: true,
      connectorsSummary: 'TG:SBX AI:DET',
      cards: seed.cards,
      cardIndex: 0,
      selectedActionIndex: 0,
      pendingUndo:
        mode === 'UNDO'
          ? {
              id: 'act_test',
              idempotencyKey: 'k1',
              cardId: 'card-1',
              kind: 'dual_exec',
              summary: 'Approve 2:40 + Notion',
              status: 'pending_undo',
              stagedAtMs: Date.now(),
              executeAtMs: Date.now() + 3000,
              payload: { recipient: 'Priya Nair', replyText: '2:40 works' },
            }
          : null,
      voiceIntent: mode === 'VOICE' ? deterministicVoiceParse('Tell Priya 2:40 works and add Notion task lock SDK v2') : null,
      pcmSamples: new Uint8Array(64),
      voiceTick: 1,
    });

    assertValidG2Payload(built.payload);
    assert.equal(built.payload.menuObject.menuItems?.length, 5);
    assert.ok(built.listItems.length >= 1);
    for (const item of built.listItems) {
      assert.ok(Buffer.byteLength(item, 'utf8') <= 32, `List item exceeded 32 bytes: ${item}`);
    }
  }
});

test('Deterministic voice parser extracts dual Telegram + Notion intent', () => {
  const res = deterministicVoiceParse('Tell Priya 2:40 works and add Notion task lock SDK v2');
  assert.equal(res.proposedAction.kind, 'dual_exec');
  assert.equal(res.proposedAction.payload.recipient, 'Priya');
  assert.match(res.proposedAction.payload.notionTitle || '', /lock SDK v2/i);
});

test('Backend gateway handles 6-digit pairing, 3s undo cancellation, idempotency, and timed commit', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-test-'));
  const stateFile = path.join(tmpDir, 'state.json');
  const port = 18787 + Math.floor(Math.random() * 1000);
  const handle = createCueServer({
    port,
    stateFilePath: stateFile,
    undoWindowMs: 250,
    disableExternalPolling: true,
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    // Wait briefly for server socket bind
    await new Promise((r) => setTimeout(r, 80));

    const health = await (await fetch(`${baseUrl}/api/health`)).json() as { ok: boolean };
    assert.equal(health.ok, true);

    const initPair = await (await fetch(`${baseUrl}/api/pair/init`, { method: 'POST' })).json() as {
      pairing: { code6: string; paired: boolean };
    };
    assert.match(initPair.pairing.code6, /^\d{6}$/);
    assert.equal(initPair.pairing.paired, false);

    const claim = await (
      await fetch(`${baseUrl}/api/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code6: initPair.pairing.code6, source: 'Test' }),
      })
    ).json() as { ok: boolean; pairing: { paired: boolean; sessionToken: string } };
    assert.equal(claim.ok, true);
    assert.equal(claim.pairing.paired, true);
    assert.ok(claim.pairing.sessionToken.startsWith('cue_'));

    // Stage + Undo before timer
    const stage1 = await (
      await fetch(`${baseUrl}/api/actions/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cardId: 'card-tg-1',
          idempotencyKey: 'idem-cancel-1',
          action: {
            id: 'a1',
            label: 'Cancel Test',
            kind: 'telegram_reply',
            payload: { recipient: 'Priya', replyText: 'Test' },
          },
        }),
      })
    ).json() as { action: { id: string; status: string } };
    assert.equal(stage1.action.status, 'pending_undo');

    // Duplicate idempotencyKey must return the exact same action ID
    const stage1Dup = await (
      await fetch(`${baseUrl}/api/actions/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cardId: 'card-tg-1',
          idempotencyKey: 'idem-cancel-1',
          action: {
            id: 'a1',
            label: 'Cancel Test',
            kind: 'telegram_reply',
            payload: { recipient: 'Priya', replyText: 'Test' },
          },
        }),
      })
    ).json() as { action: { id: string } };
    assert.equal(stage1Dup.action.id, stage1.action.id);

    const undone = await (
      await fetch(`${baseUrl}/api/actions/${stage1.action.id}/undo`, { method: 'POST' })
    ).json() as { action: { status: string } };
    assert.equal(undone.action.status, 'undone');

    // Stage without undo -> auto-executes after undoWindowMs (250ms)
    const stage2 = await (
      await fetch(`${baseUrl}/api/actions/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cardId: 'card-tg-1',
          idempotencyKey: 'idem-exec-2',
          action: {
            id: 'a2',
            label: 'Execute Dual Test',
            kind: 'dual_exec',
            payload: { recipient: 'Priya', replyText: '2:40 OK', notionTitle: 'Test Task' },
          },
        }),
      })
    ).json() as { action: { id: string } };

    await new Promise((r) => setTimeout(r, 420));
    const snap = await (await fetch(`${baseUrl}/api/state`)).json() as {
      ledger: Array<{ id: string; status: string; receiptText?: string }>;
    };
    const committed = snap.ledger.find((l) => l.id === stage2.action.id);
    assert.equal(committed?.status, 'executed');
    assert.match(committed?.receiptText || '', /Created Notion task/);
  } finally {
    await handle.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
