import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// `tsc` dijalankan lewat binary Node, bukan `pnpm.cmd`. Sejak Node 20.12
// (perbaikan CVE-2024-27980) `child_process.spawn` menolak berkas `.cmd`/`.bat`
// tanpa `shell: true` dan melempar `EINVAL` di Windows. Menjalankan skrip JS
// milik TypeScript langsung memakai `process.execPath` bekerja di semua OS
// tanpa shell tambahan.
const tscBin = require.resolve('typescript/bin/tsc');

// 1. Jalankan TypeScript compiler dalam watch mode
const tsc = spawn(process.execPath, [tscBin, '-p', 'tsconfig.build.json', '-w', '--preserveWatchOutput'], {
  stdio: 'inherit',
});

// 2. Jalankan Node.js native watch pada dist/main.js
const server = spawn(process.execPath, ['--watch', 'dist/main.js'], {
  stdio: 'inherit',
});

function cleanup() {
  if (tsc && !tsc.killed) {
    tsc.kill();
  }
  if (server && !server.killed) {
    server.kill();
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
