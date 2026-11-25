import { execFileSync } from 'node:child_process';
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
const framesDir = path.join(rootDir, 'demo', 'frames');
const outMp4 = path.join(rootDir, 'demo', 'cue-even-g2-demo.mp4');
const screenshotsDir = path.join(rootDir, 'docs', 'screenshots');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSimGlasses(destPath) {
  const r = await fetch(`${SIM}/api/screenshot/glasses`);
  if (!r.ok) throw new Error(`Simulator glasses HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

async function simInput(action) {
  await fetch(`${SIM}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

async function postGw(endpoint, body = {}) {
  const r = await fetch(`${GW}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

await fs.rm(framesDir, { recursive: true, force: true });
await fs.mkdir(framesDir, { recursive: true });
await fs.mkdir(screenshotsDir, { recursive: true });

// Cycle claim -> init so both Companion and EvenHub Simulator transition cleanly into PAIR mode over SSE
const pre = await (await fetch(`${GW}/api/state`)).json();
await postGw('/api/pair/claim', { code6: pre.pairing.code6, source: 'Init' });
await sleep(350);
await postGw('/api/pair/init', {});
await sleep(450);
const initState = await (await fetch(`${GW}/api/state`)).json();
const pairCode = initState.pairing.code6;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox'],
});

const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const companionPage = await context.newPage();
await companionPage.goto(WEB, { waitUntil: 'networkidle' });

// Second page renders the 1920x1080 studio composite frame (Real Simulator Glasses Lens + Live Companion UI + Caption Bar)
const stagePage = await context.newPage();
await stagePage.setViewportSize({ width: 1920, height: 1080 });

const scenes = [];
async function captureScene(id, stepTitle, caption, holdSeconds) {
  const glassesPng = path.join(screenshotsDir, `demo-${id}-glasses.png`);
  const compPng = path.join(screenshotsDir, `demo-${id}-companion.png`);
  await fetchSimGlasses(glassesPng);
  await companionPage.screenshot({ path: compPng });

  const gB64 = (await fs.readFile(glassesPng)).toString('base64');
  const cB64 = (await fs.readFile(compPng)).toString('base64');

  const html = `<!doctype html>
  <html>
    <head>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          width: 1920px; height: 1080px; background: #07090d; color: #f2f4f7;
          font-family: 'Segoe UI', system-ui, sans-serif;
          padding: 44px 56px; display: flex; flex-direction: column; justify-content: space-between;
        }
        .header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #222831; padding-bottom: 18px; }
        .title { font-size: 36px; font-weight: 500; letter-spacing: -0.02em; }
        .badge { color: #b8f34e; font-size: 22px; font-family: Consolas, monospace; border: 1px solid #496023; padding: 8px 18px; border-radius: 999px; background: #10170c; }
        .stage { display: grid; grid-template-columns: 780px 1fr; gap: 40px; align-items: center; flex: 1; padding: 28px 0; }
        .lens-col { display: flex; flex-direction: column; gap: 16px; }
        .col-label { font-size: 18px; color: #8c95a3; letter-spacing: 0.02em; }
        .lens-bezel { background: #030a04; border: 2px solid #2f4d28; border-radius: 14px; padding: 22px; }
        .lens-img { width: 100%; height: auto; image-rendering: pixelated; display: block; border-radius: 4px; background: #fff; }
        .comp-bezel { border: 1px solid #232a35; border-radius: 10px; overflow: hidden; background: #0b0d12; }
        .comp-img { width: 100%; height: auto; display: block; }
        .footer { border-top: 1px solid #222831; padding-top: 20px; display: flex; justify-content: space-between; align-items: center; }
        .caption { font-size: 26px; color: #d8dee7; }
        .sub { font-size: 19px; color: #8c95a3; font-family: Consolas, monospace; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="title">Cue for Even Realities G2 — ${stepTitle}</div>
        <div class="badge">Track: AI Assistants &amp; Work + Two-Way Telegram</div>
      </div>
      <div class="stage">
        <div class="lens-col">
          <div class="col-label">Live Official EvenHub Simulator Output (576 x 288 Monochrome Green)</div>
          <div class="lens-bezel">
            <img class="lens-img" src="data:image/png;base64,${gB64}" />
          </div>
        </div>
        <div class="lens-col">
          <div class="col-label">Vantage Companion Console &amp; Server-Side Audit Ledger</div>
          <div class="comp-bezel">
            <img class="comp-img" src="data:image/png;base64,${cB64}" />
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="caption">${caption}</div>
        <div class="sub">dev.yashh.cue · Even Hub SDK 0.0.16 · Zero client secrets</div>
      </div>
    </body>
  </html>`;

  await stagePage.setContent(html);
  const framePath = path.join(framesDir, `scene-${id}.png`);
  await stagePage.screenshot({ path: framePath });
  scenes.push({ framePath, holdSeconds });
  console.log(`Captured scene ${id}: ${stepTitle} (${holdSeconds}s)`);
}

// Scene 01: PAIR QR Screen on Simulator + Companion Console
await companionPage.click('#btn-top-pair');
await sleep(700);
await captureScene(
  '01-pair',
  '1. Zero-WebView Login Pairing (Telegram / Companion)',
  `G2 renders Gray8 112x112 pairing matrix & code ${pairCode} — bypasses blocked WebView Google Sign-In.`,
  9
);
// Save clean PAIR screenshot for README/docs too
await fs.copyFile(
  path.join(screenshotsDir, 'demo-01-pair-glasses.png'),
  path.join(screenshotsDir, 'g2-00-pair-qr.png')
);

// Scene 02: Confirm pairing -> Instant transition to NOW Brief
await companionPage.click('#btn-pair-claim');
await sleep(900);
await captureScene(
  '02-now',
  '2. One-Glance Pre-Meeting Brief + Horizon Timeline',
  'T-12m Design Sync & Gray8 countdown bar appear cleanly on 576x288 lens with 1-tap Telegram replies.',
  10
);

// Scene 03: Push Urgent Telegram DM via SSE live push
await postGw('/api/simulate/event', { scenario: 'telegram_urgent' });
await sleep(800);
await captureScene(
  '03-tg-push',
  '3. Real-Time Telegram Urgent DM Triage',
  'Incoming Telegram DM streams over SSE onto glasses with AI/deterministic smart reply actions.',
  10
);

// Scene 04: Tap reply -> Stage 3-Second Undo Guard -> Demonstrate Safe Undo
await simInput('click');
await sleep(600);
await captureScene(
  '04-undo-guard',
  '4. Safety First: 3-Second Hardware Undo Guard',
  'Single tap stages outbound Telegram/Notion write in a live 3s countdown before external dispatch.',
  9
);
await simInput('click'); // Undo within 3s!
await sleep(700);
await captureScene(
  '05-undone',
  '5. Cancelled Cleanly Inside 3s Window',
  'One tap aborts the staged write cleanly; audit ledger records zero external messages sent.',
  8
);

// Scene 06: Long-Press G2 Mic -> Voice Capture Waveform -> Parse Dual Intent
await simInput('long_press');
await sleep(650);
await captureScene(
  '06-voice-mic',
  '6. Hands-Free Temple Hold -> G2 Mic Waveform',
  'Holding temple streams raw AudioEvent PCM and renders a live 24-bar Gray8 equalizer waveform.',
  9
);
await simInput('long_press_release');
await sleep(900);
await captureScene(
  '07-voice-plan',
  '7. Compound Voice Intent: Telegram + Notion Dual Write',
  '"Tell Priya 2:40 works & add Notion task" compiles into one-tap confirmed dual action.',
  10
);

// Scene 08: Confirm & Commit Dual Action -> Final Executed Receipt Ledger
await simInput('click');
await sleep(600);
// Wait for 3s timer to finish commit
await sleep(3200);
await captureScene(
  '08-executed',
  '8. Confirmed Execution & Telegram Audit Receipt',
  'Dual write dispatches Telegram reply, creates Notion task, and logs verifiable receipt in ledger.',
  11
);

await browser.close();

// Assemble smooth MP4 via ffmpeg concat demuxer (~76s < 3 min limit!)
const concatLines = [];
for (const s of scenes) {
  concatLines.push(`file '${s.framePath.replaceAll('\\', '/')}'`);
  concatLines.push(`duration ${s.holdSeconds}`);
}
// ffmpeg concat requires repeating the last file without duration
concatLines.push(`file '${scenes[scenes.length - 1].framePath.replaceAll('\\', '/')}'`);
const concatTxt = path.join(rootDir, 'demo', 'concat.txt');
await fs.writeFile(concatTxt, concatLines.join('\n'), 'utf8');

execFileSync(
  'ffmpeg',
  [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatTxt,
    '-vf',
    'fps=30,format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    outMp4,
  ],
  { stdio: 'inherit', shell: false }
);

const stat = await fs.stat(outMp4);
console.log(`DEMO VIDEO READY: ${outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
