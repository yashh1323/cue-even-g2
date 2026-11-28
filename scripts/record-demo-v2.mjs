import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/YASH KASHYAP/.gemini/config/skills/auto-qa/node_modules/playwright-core');

const SIM = 'http://127.0.0.1:9898';
const GW = 'http://127.0.0.1:8787';
const WEB = 'http://127.0.0.1:5173';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const rootDir = process.cwd();
const rawVideoDir = path.join(rootDir, 'demo', 'raw-video');
const audioDir = path.join(rootDir, 'demo', 'audio');
const screenshotsDir = path.join(rootDir, 'docs', 'screenshots');
const outMp4 = path.join(rootDir, 'demo', 'cue-even-g2-demo.mp4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url, label, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUp(url)) return true;
    await sleep(400);
  }
  throw new Error(`${label} (${url}) did not become ready within ${timeoutMs}ms`);
}

function killTree(proc) {
  if (!proc || proc.killed || !proc.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
  } catch {}
}

async function postGw(endpoint, body = {}) {
  const r = await fetch(`${GW}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function simInput(action) {
  await fetch(`${SIM}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

await fs.rm(rawVideoDir, { recursive: true, force: true });
await fs.mkdir(rawVideoDir, { recursive: true });
await fs.mkdir(screenshotsDir, { recursive: true });

const manifest = JSON.parse((await fs.readFile(path.join(audioDir, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
const durationMap = Object.fromEntries(manifest.map((c) => [c.id, c.duration]));

// Start backend + frontend + official simulator cleanly if not already listening
const spawned = [];
try {
  if (!(await isUp(`${GW}/api/state`))) {
    console.log('Starting Cue backend gateway (:8787)...');
    spawned.push(spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], { cwd: rootDir, stdio: 'ignore', shell: false }));
    await waitForUrl(`${GW}/api/state`, 'Gateway :8787');
  }
  if (!(await isUp(WEB))) {
    console.log('Starting Vite companion UI (:5173)...');
    spawned.push(spawn(process.execPath, [path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173'], { cwd: rootDir, stdio: 'ignore', shell: false }));
    await waitForUrl(WEB, 'Vite :5173');
  }
  if (!(await isUp(`${SIM}/api/ping`))) {
    console.log('Starting official EvenHub Simulator (:9898)...');
    const simExe = require.resolve('@evenrealities/sim-win32-x64/bin/evenhub-simulator.exe');
    spawned.push(spawn(simExe, ['--automation-port', '9898', '--glow', WEB], { cwd: rootDir, stdio: 'inherit', shell: false }));
    await waitForUrl(`${SIM}/api/ping`, 'EvenHub Simulator :9898', 60000);
    await sleep(1800);
  }

  // Reset to clean initial state before recording
  const pre = await (await fetch(`${GW}/api/state`)).json();
  if (!pre.pairing?.paired) {
    await postGw('/api/pair/claim', { code6: pre.pairing.code6, source: 'Init' });
    await sleep(300);
  }
  await postGw('/api/pair/init', {});
  await sleep(500);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: rawVideoDir, size: { width: 1920, height: 1080 } },
  });

  const page = await context.newPage();
  const stageHtml = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          width: 1920px; height: 1080px; background: #07090d; color: #f2f4f7;
          font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
          padding: 26px 40px; display: flex; flex-direction: column; gap: 18px; overflow: hidden;
        }
        .header {
          display: flex; justify-content: space-between; align-items: center;
          border-bottom: 1px solid #1e2633; padding-bottom: 14px;
        }
        .title-group { display: flex; flex-direction: column; gap: 4px; }
        .title { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; color: #f8fafc; }
        .chapter { font-size: 18px; color: #94a3b8; }
        .steps { display: flex; gap: 8px; }
        .step-pill {
          font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 999px;
          border: 1px solid #263142; background: #0f141e; color: #64748b;
        }
        .step-pill.active {
          border-color: #a3e635; background: rgba(163,230,53,0.12); color: #d9f99d;
        }
        .step-pill.done {
          border-color: #365314; background: #0d1509; color: #84cc16;
        }
        .diff-banner {
          background: linear-gradient(90deg, rgba(16,28,14,0.95), rgba(14,22,36,0.95));
          border: 1px solid #4d7c0f; border-radius: 12px; padding: 14px 20px;
          display: none; align-items: center; gap: 16px;
        }
        .diff-banner.visible { display: flex; }
        .diff-tag {
          background: #a3e635; color: #090d05; font-weight: 700; font-size: 12px;
          padding: 6px 12px; border-radius: 999px; white-space: nowrap; letter-spacing: 0.04em;
        }
        .diff-text { font-size: 18px; line-height: 1.4; color: #ecfccb; font-weight: 500; }
        .stage { display: grid; grid-template-columns: 740px 1fr; gap: 28px; flex: 1; min-height: 0; }
        .col { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
        .col-head { display: flex; justify-content: space-between; align-items: center; }
        .col-label { font-size: 15px; font-weight: 600; color: #cbd5e1; letter-spacing: 0.02em; }
        .live-dot { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #a3e635; font-family: Consolas, monospace; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #a3e635; }
        .lens-bezel {
          background: #020804; border: 2px solid #2e4c26; border-radius: 16px; padding: 18px;
          box-shadow: 0 0 40px rgba(132, 204, 22, 0.08);
        }
        .lens-img { width: 100%; height: auto; image-rendering: pixelated; display: block; border-radius: 6px; background: #000; }
        .hw-specs {
          background: #0d121b; border: 1px solid #1e2633; border-radius: 12px; padding: 14px 18px;
          font-size: 15px; color: #94a3b8; line-height: 1.5; flex: 1;
        }
        .hw-specs strong { color: #e2e8f0; }
        .comp-wrap {
          flex: 1; border: 1px solid #232d3f; border-radius: 14px; overflow: hidden;
          background: #0b0e14; position: relative;
        }
        iframe { width: 100%; height: 100%; border: 0; background: #0b0e14; }
        .footer {
          border-top: 1px solid #1e2633; padding-top: 12px;
          display: flex; justify-content: space-between; align-items: center; gap: 20px;
        }
        .caption { font-size: 20px; color: #f1f5f9; font-weight: 500; }
        .meta { font-size: 15px; color: #84cc16; font-family: Consolas, monospace; white-space: nowrap; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="title-group">
          <div class="title">Cue — Hands-Free Chief-of-Staff HUD for Even Realities G2</div>
          <div class="chapter" id="chapter-label">Chapter 1: What Cue Does That Even AI Cannot Do Alone</div>
        </div>
        <div class="steps">
          <div class="step-pill active" id="pill-1">1. vs Even AI</div>
          <div class="step-pill" id="pill-2">2. Connect Account</div>
          <div class="step-pill" id="pill-3">3. 10:48 AM Brief</div>
          <div class="step-pill" id="pill-4">4. Telegram + Undo</div>
          <div class="step-pill" id="pill-5">5. Voice Dual Write</div>
          <div class="step-pill" id="pill-6">6. Live Receipt</div>
        </div>
      </div>

      <div class="diff-banner visible" id="diff-banner">
        <span class="diff-tag">VS EVEN AI ALONE</span>
        <div class="diff-text">
          Cue continuously streams live calendar &amp; Telegram triage, compiles compound Telegram + Notion voice commands, and enforces a 3-second hardware undo guard with a server-side audit ledger before any external write fires.
        </div>
      </div>

      <div class="stage">
        <div class="col">
          <div class="col-head">
            <span class="col-label">Official EvenHub G2 Simulator Lens (576 × 288 Monochrome)</span>
            <span class="live-dot"><span class="dot"></span>LIVE STREAMING</span>
          </div>
          <div class="lens-bezel" style="position: relative; aspect-ratio: 2 / 1;">
            <img id="lens-img-a" class="lens-img" style="position: relative; z-index: 2;" alt="Live EvenHub G2 Simulator Display" />
            <img id="lens-img-b" class="lens-img" style="position: absolute; inset: 18px; width: calc(100% - 36px); z-index: 1;" alt="" />
          </div>
          <div class="hw-specs" id="lens-notes">
            <strong>Hardware Loop:</strong> Real-time EvenHub Bridge · Gray8 112×112 QR Matrix · 240×24 Horizon Bar · 24-Bar Audio Waveform · R1 Ring / Temple Tap &amp; Long-Press
          </div>
        </div>

        <div class="col">
          <div class="col-head">
            <span class="col-label">Vantage Companion Console &amp; Server-Side Audit Ledger (:5173 → :8787)</span>
            <span class="live-dot"><span class="dot"></span>ZERO CLIENT SECRETS</span>
          </div>
          <div class="comp-wrap">
            <iframe id="companion-frame" src="${WEB}"></iframe>
          </div>
        </div>
      </div>

      <div class="footer">
        <div class="caption" id="caption-label">Meet Cue: proactive G2 HUD with 2-way Telegram triage, compound voice execution, and hardware undo safety.</div>
        <div class="meta">dev.yashh.cue · Even Hub SDK 0.0.16 · cue-g2.ehpk</div>
      </div>

      <script>
        const imgA = document.getElementById('lens-img-a');
        const imgB = document.getElementById('lens-img-b');
        let frontIsA = true;
        let busy = false;
        function pollLens() {
          if (busy) return;
          busy = true;
          const next = frontIsA ? imgB : imgA;
          const prev = frontIsA ? imgA : imgB;
          const done = () => {
            busy = false;
          };
          next.onload = () => {
            next.style.zIndex = '2';
            prev.style.zIndex = '1';
            frontIsA = !frontIsA;
            done();
          };
          next.onerror = done;
          next.src = '${SIM}/api/screenshot/glasses?t=' + Date.now();
        }
        pollLens();
        setInterval(pollLens, 160);
      </script>
    </body>
  </html>`;

  await page.setContent(stageHtml, { waitUntil: 'domcontentloaded' });
  const compFrame = page.frameLocator('#companion-frame');
  await compFrame.locator('#btn-top-pair').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => {
    const a = document.getElementById('lens-img-a');
    const b = document.getElementById('lens-img-b');
    return (a && a.naturalWidth > 0) || (b && b.naturalWidth > 0);
  }, { timeout: 20000 });
  await sleep(600);

  async function setUi(stepNum, chapter, caption, showDiffBanner, notesHtml) {
    await page.evaluate(({ stepNum, chapter, caption, showDiffBanner, notesHtml }) => {
      document.getElementById('chapter-label').textContent = chapter;
      document.getElementById('caption-label').textContent = caption;
      document.getElementById('diff-banner').classList.toggle('visible', Boolean(showDiffBanner));
      if (notesHtml) document.getElementById('lens-notes').innerHTML = notesHtml;
      for (let i = 1; i <= 6; i++) {
        const el = document.getElementById('pill-' + i);
        el.classList.remove('active', 'done');
        if (i < stepNum) el.classList.add('done');
        if (i === stepNum) el.classList.add('active');
      }
    }, { stepNum, chapter, caption, showDiffBanner, notesHtml });
  }

  const timeline = [];
  let cursorSec = 0;
  const videoStartMs = Date.now();
  function markClipStart(id) {
    const startSec = (Date.now() - videoStartMs) / 1000;
    timeline.push({ id, wav: path.join(audioDir, `clip-${id}.wav`), startSec, duration: durationMap[id] });
    return startSec;
  }
  async function waitUntilElapsed(targetSec) {
    const rem = targetSec * 1000 - (Date.now() - videoStartMs);
    if (rem > 0) await sleep(rem);
  }

  // --- CLIP 01: Differentiator vs Even AI ---
  markClipStart('01-differentiator');
  cursorSec += durationMap['01-differentiator'] + 0.6;
  await waitUntilElapsed(cursorSec);

  // --- CLIP 02: Step-by-step Account Connection & Zero-WebView QR Pairing ---
  markClipStart('02-connect-account');
  await setUi(
    2,
    'Chapter 2: Step-by-Step Account Connection (Zero-WebView QR Pairing)',
    '1) Add server-side Telegram/Notion connectors -> 2) Pair G2 with 112x112 Gray8 QR & 6-digit code.',
    false,
    '<strong>Step-by-Step Pairing:</strong> Tokens live strictly on your Gateway (:8787). Scanning the Gray8 QR or running <code>/pair CODE</code> in Telegram links the glasses cleanly.'
  );
  // Expand server-side connectors panel to show token fields clearly
  const disclosure = compFrame.locator('.connectors-disclosure summary');
  await disclosure.click();
  await sleep(durationMap['02-connect-account'] * 320); // hold on connector setup ~1/3 of clip
  await disclosure.click();
  await compFrame.locator('#btn-top-pair').click();
  await sleep(1600);
  await page.screenshot({ path: path.join(screenshotsDir, 'cue-shot-01-pairing.png') });
  cursorSec += durationMap['02-connect-account'] + 0.6;
  await waitUntilElapsed(cursorSec - 4.0);
  // Confirm pair code live and watch glasses switch from QR to NOW brief
  await compFrame.locator('#btn-pair-claim').click();
  await waitUntilElapsed(cursorSec);

  // --- CLIP 03: Real Moment From Day (10:48 AM Pre-Meeting Brief) ---
  markClipStart('03-real-moment');
  await setUi(
    3,
    'Chapter 3: Live 10:48 AM Pre-Meeting Brief & Glanceable Horizon Bar',
    'Walking to Design Sync (T-12m): live 576x288 meeting card, Gray8 urgency bar, and quick replies.',
    false,
    '<strong>Live NOW Card:</strong> Scroll temple/R1 ring up or down to inspect priority Calendar events, Notion sprint blockers, and Telegram threads without touching your phone.'
  );
  await sleep(3500);
  await simInput('down');
  await sleep(2500);
  await simInput('up');
  await sleep(1500);
  cursorSec += durationMap['03-real-moment'] + 0.6;
  await waitUntilElapsed(cursorSec);

  // --- CLIP 04: Urgent Telegram DM Push + 3-Second Hardware Undo Guard (Undo Demo) ---
  markClipStart('04-telegram-undo');
  await setUi(
    4,
    'Chapter 4: Live Urgent Telegram DM + 3-Second Hardware Undo Safety Guard',
    'Incoming Telegram DM streams over SSE -> 1 temple tap stages reply -> 2nd tap inside 3s cancels safely.',
    false,
    '<strong>3s Undo Guard:</strong> Every external Telegram/Notion write pauses in a live 3.0s countdown on both lenses and Companion before firing.'
  );
  await postGw('/api/simulate/event', { scenario: 'telegram_urgent' });
  await sleep(2600);
  await page.screenshot({ path: path.join(screenshotsDir, 'cue-shot-02-now-telegram.png') });
  await sleep(2500);
  await simInput('click'); // Stages reply into 3s Undo countdown!
  await sleep(1200);
  await page.screenshot({ path: path.join(screenshotsDir, 'cue-shot-03-undo-guard.png') });
  await sleep(600);
  await simInput('click'); // Cancel safely inside 3s window!
  cursorSec += durationMap['04-telegram-undo'] + 0.6;
  await waitUntilElapsed(cursorSec);

  // --- CLIP 05: Hands-Free Voice Waveform -> Compound Dual Intent ---
  markClipStart('05-voice-dual');
  await setUi(
    5,
    'Chapter 5: Hands-Free Temple Hold -> Live Audio Waveform & Compound Dual Intent',
    'Hold temple for G2 Mic PCM -> Release compiles "Reply to Priya + Create Notion task" in 1 plan.',
    false,
    '<strong>Voice Pipeline:</strong> Long-pressing streams AudioEvent PCM frames, animates a 24-bar Gray8 equalizer on the lens, and compiles multi-app actions cleanly.'
  );
  await sleep(2000);
  await simInput('long_press');
  await sleep(5500);
  await simInput('long_press_release');
  cursorSec += durationMap['05-voice-dual'] + 0.6;
  await waitUntilElapsed(cursorSec);

  // --- CLIP 06: Confirm & Watch Live 3s Countdown Execute Telegram + Notion ---
  markClipStart('06-commit-receipt');
  await setUi(
    6,
    'Chapter 6: Live Execution & Verifiable Server-Side Audit Receipt',
    'Tap once to confirm -> 3.0s guard commits Telegram reply + Notion task -> receipt logged in Ledger.',
    false,
    '<strong>Dual Dispatch Executed:</strong> Both Telegram notification receipt and Notion task are committed idempotently and recorded with timestamps.'
  );
  await sleep(1200);
  await simInput('click');
  await sleep(3800);
  await page.screenshot({ path: path.join(screenshotsDir, 'cue-shot-04-voice-receipt.png') });
  cursorSec += durationMap['06-commit-receipt'] + 0.6;
  await waitUntilElapsed(cursorSec);

  // --- CLIP 07: Packaging & Closing ---
  markClipStart('07-closing');
  await setUi(
    6,
    'Chapter 7: Built on Even Hub SDK 0.0.16 (cue-g2.ehpk)',
    'Open-source · Verified cue-g2.ehpk · Automated unit & simulator tests · Ready for G2 glasses.',
    true,
    '<strong>Shipped Artifacts:</strong> <code>cue-g2.ehpk</code> (SDK 0.0.16) · Live Companion + Gateway · GitHub repo & simulator suite.'
  );
  cursorSec += durationMap['07-closing'] + 1.2;
  await waitUntilElapsed(cursorSec);

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  console.log(`Recorded raw live WebM (${cursorSec.toFixed(2)}s): ${videoPath}`);

  // Build aligned narration track with adelay so every spoken clip hits its exact scene start!
  const ffInputs = [];
  const filterParts = [];
  for (let i = 0; i < timeline.length; i++) {
    ffInputs.push('-i', timeline[i].wav);
    const delayMs = Math.max(0, Math.round(timeline[i].startSec * 1000));
    filterParts.push(`[${i + 1}:a]adelay=${delayMs}|${delayMs},volume=1.25[a${i}]`);
  }
  const mixLabels = timeline.map((_, i) => `[a${i}]`).join('');
  filterParts.push(`${mixLabels}amix=inputs=${timeline.length}:normalize=0:duration=longest[aout]`);

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i', videoPath,
      ...ffInputs,
      '-filter_complex', filterParts.join(';'),
      '-map', '0:v',
      '-map', '[aout]',
      '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outMp4,
    ],
    { stdio: 'inherit', shell: false }
  );

  const stat = await fs.stat(outMp4);
  console.log(`FINAL NARRATED DEMO MP4 READY: ${outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
} finally {
  for (const p of spawned) killTree(p);
}
