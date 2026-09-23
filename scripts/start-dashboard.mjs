import { spawn } from 'node:child_process';
const child = spawn(
  process.execPath,
  [
    '../../node_modules/next/dist/bin/next',
    'start',
    '-H',
    '0.0.0.0',
    '-p',
    process.env.PORT || '3000',
  ],
  { cwd: new URL('../apps/dashboard', import.meta.url), stdio: 'inherit', env: process.env },
);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code || 0));
child.on('error', () => process.exit(1));
