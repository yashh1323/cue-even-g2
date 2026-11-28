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

async function clickSmooth(page, selector, pauseAfterMs = 1500) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
    await sleep(220);
  }
  await loc.click();
  await sleep(pauseAfterMs);
}

await fs.rm(rawVideoDir, { recursive: true, force: true });
await fs.mkdir(rawVideoDir, { recursive: true });
await fs.mkdir(screenshotsDir, { recursive: true });

const spawned = [];

try {
  if (!(await isUp(`${GW}/api/state`))) {
    console.log('Starting Cue backend gateway (:8787)...');
    spawned.push(spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], { cwd: rootDir, stdio: 'ignore', shell: false }));
    await waitForUrl(`${GW}/api/state`, 'Gateway :8787');
  }
  if (!(await isUp(WEB))) {
    console.log('Starting Vite Cue web app (:5173)...');
    spawned.push(spawn(process.execPath, [path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173'], { cwd: rootDir, stdio: 'ignore', shell: false }));
    await waitForUrl(WEB, 'Vite :5173');
  }
  if (!(await isUp(`${SIM}/api/ping`))) {
    console.log('Starting official EvenHub Simulator (:9898)...');
    const simExe = require.resolve('@evenrealities/sim-win32-x64/bin/evenhub-simulator.exe');
    spawned.push(spawn(simExe, ['--automation-port', '9898', '--glow', WEB], { cwd: rootDir, stdio: 'ignore', shell: false }));
    await waitForUrl(`${SIM}/api/ping`, 'EvenHub Simulator :9898', 60000);
    await sleep(1800);
  }

  // Reset state cleanly into PAIR mode
  const pre = await (await fetch(`${GW}/api/state`)).json();
  if (!pre.pairing?.paired) {
    await postGw('/api/pair/claim', { code6: pre.pairing.code6, source: 'Init' });
    await sleep(300);
  }
  await postGw('/api/pair/init', {});
  await sleep(600);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 810 },
    recordVideo: { dir: rawVideoDir, size: { width: 1440, height: 810 } },
  });

  const page = await context.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btn-top-pair', { timeout: 20000 });
  await sleep(3000); // Initial live landing view

  // =========================================================================
  // 1. Account Connectors & Step-by-Step Zero-WebView QR Pairing (~24s)
  // =========================================================================
  await clickSmooth(page, '.connectors-disclosure summary', 5500); // Expand server-side Telegram/OpenRouter/Notion/Calendar setup
  await clickSmooth(page, '#btn-top-pair', 1500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(4500);
  // Capture Screenshot 1: Real UI with server connectors + live Pair QR code active
  await page.screenshot({ path: path.join(screenshotsDir, 'real-01-connectors-and-pairing.png') });
  await clickSmooth(page, '.connectors-disclosure summary', 1000);
  await clickSmooth(page, '#btn-pair-claim', 5000); // Confirm pairing -> immediate switch to NOW brief

  // =========================================================================
  // 2. Real Workday Pre-Meeting Brief & Hardware Navigation (~18s)
  // =========================================================================
  await clickSmooth(page, '#btn-g2-scroll-down', 4000);
  await clickSmooth(page, '#btn-g2-scroll-down', 4000);
  await clickSmooth(page, '#btn-g2-scroll-up', 3500);
  await clickSmooth(page, '#btn-g2-scroll-up', 3500);

  // =========================================================================
  // 3. Urgent Telegram DM SSE Push & Live 3-Second Undo Guard (~24s)
  // =========================================================================
  await clickSmooth(page, '[data-sim="telegram_urgent"]', 5000);
  await clickSmooth(page, '#btn-g2-tap', 1100); // Stage reply -> 3.0s countdown active!
  await page.screenshot({ path: path.join(screenshotsDir, 'real-02-live-3s-undo-guard.png') });
  await sleep(400);
  await clickSmooth(page, '[data-undo-id]', 6000); // Undo safely inside 3s window -> ledger shows "undone"

  // =========================================================================
  // 4. Voice Waveform, Compound Intent & Live Dual Execution (~30s)
  // =========================================================================
  await simInput('long_press');
  await clickSmooth(page, '#btn-g2-voice', 4500);
  await simInput('long_press_release');
  await clickSmooth(page, '#btn-run-voice-text', 4500); // Compile Telegram + Notion dual intent
  await clickSmooth(page, '#btn-g2-tap', 4800); // Watch full 3s countdown commit live into executed receipt!
  await page.screenshot({ path: path.join(screenshotsDir, 'real-03-executed-audit-ledger.png') });

  // Capture genuine unedited WebView inside official EvenHub Simulator (:9898)
  const simWebRes = await fetch(`${SIM}/api/screenshot/webview`);
  if (!simWebRes.ok) throw new Error(`Simulator /api/screenshot/webview failed HTTP ${simWebRes.status}`);
  await fs.writeFile(
    path.join(screenshotsDir, 'real-04-evenhub-simulator-webview.png'),
    Buffer.from(await simWebRes.arrayBuffer())
  );
  const simGlassRes = await fetch(`${SIM}/api/screenshot/glasses`);
  if (!simGlassRes.ok) throw new Error(`Simulator /api/screenshot/glasses failed HTTP ${simGlassRes.status}`);

  await sleep(7000); // Hold on final executed audit ledger

  const webmPath = await page.video().path();
  await context.close();
  await browser.close();

  console.log(`Raw real-app WebM recorded: ${webmPath}`);
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i', webmPath,
      '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '21',
      '-an',
      '-movflags', '+faststart',
      outMp4,
    ],
    { stdio: 'inherit', shell: false }
  );

  const stat = await fs.stat(outMp4);
  console.log(`FINAL REAL VIDEO READY: ${outMp4} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
} finally {
  for (const p of spawned) killTree(p);
}
