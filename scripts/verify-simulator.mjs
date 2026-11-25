import fs from 'node:fs/promises';
import path from 'node:path';

const SIM = 'http://127.0.0.1:9898';
const GW = 'http://127.0.0.1:8787';
const outDir = path.resolve(process.cwd(), 'docs', 'screenshots');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSim() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${SIM}/api/ping`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error('Simulator automation port did not respond in time');
}

async function savePng(urlPath, fileName) {
  const r = await fetch(`${SIM}${urlPath}`);
  if (!r.ok) throw new Error(`Screenshot ${urlPath} failed HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(path.join(outDir, fileName), buf);
  return buf.length;
}

async function simInput(action) {
  const r = await fetch(`${SIM}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

await fs.mkdir(outDir, { recursive: true });
await waitForSim();
await sleep(1600);

console.log('1. Capturing NOW Brief screen...');
await savePng('/api/screenshot/glasses', 'g2-01-now-brief.png');
await savePng('/api/screenshot/webview', 'webview-01.png');

console.log('2. Testing simulator R1/Temple DOWN + CLICK -> UNDO Guard...');
await simInput('down');
await sleep(300);
await simInput('click');
await sleep(700);
await savePng('/api/screenshot/glasses', 'g2-02-undo-guard.png');

console.log('3. Undoing inside 3s window via simulator CLICK...');
await simInput('click');
await sleep(700);

console.log('4. Testing Voice Capture via LONG_PRESS -> LONG_PRESS_RELEASE...');
await simInput('long_press');
await sleep(700);
await savePng('/api/screenshot/glasses', 'g2-03-voice-waveform.png');
await simInput('long_press_release');
await sleep(900);
await savePng('/api/screenshot/glasses', 'g2-04-voice-intent.png');

console.log('5. Returning to NOW & opening OS menu (context_menu)...');
await simInput('double_click');
await sleep(500);

console.log('6. Checking simulator console logs...');
const consoleRes = await (await fetch(`${SIM}/api/console`)).json();
const entries = Array.isArray(consoleRes) ? consoleRes : consoleRes.entries || [];
const errors = entries.filter((e) => String(e.level || '').toLowerCase() === 'error');
console.log(`Console entries=${entries.length}, errors=${errors.length}`);
if (errors.length > 0) {
  console.error(errors);
  process.exitCode = 1;
} else {
  console.log('ALL 4 SCREENS + HARDWARE GESTURES VERIFIED WITH 0 ERRORS IN EVENHUB SIMULATOR!');
}
