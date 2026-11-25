import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const serverProc = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(rootDir, 'server', 'index.ts')],
  { cwd: rootDir, stdio: 'inherit', shell: false }
);

const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
const webProc = spawn(
  process.execPath,
  [viteBin, '--host', '127.0.0.1', '--port', '5173'],
  { cwd: rootDir, stdio: 'inherit', shell: false }
);

function shutdown(signal) {
  for (const child of [serverProc, webProc]) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const [name, proc] of [
  ['server', serverProc],
  ['vite', webProc],
]) {
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${name} exited with code ${code}`);
      shutdown('SIGTERM');
      process.exit(code);
    }
  });
}
