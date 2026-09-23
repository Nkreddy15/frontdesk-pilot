import 'dotenv/config';
import { spawn } from 'node:child_process';
const children = [];
function start(args, cwd = process.cwd()) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) process.stderr.write(`A development service stopped (${code}).\n`);
  });
}
start(['--import', 'tsx', 'apps/api/src/server.ts']);
start(
  ['../../node_modules/next/dist/bin/next', 'dev', '--webpack', '-H', '127.0.0.1', '-p', '3000'],
  process.cwd() + '/apps/dashboard',
);
// WASM has one process owning the database; the API schedules the worker in that mode.
if (process.env.USE_PGLITE !== 'true') start(['--import', 'tsx', 'apps/worker/src/main.ts']);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(0);
  });
