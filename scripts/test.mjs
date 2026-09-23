import 'dotenv/config';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files = process.argv.slice(2);
const args = files.length
  ? files
  : readdirSync('tests')
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => 'tests/' + f);
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...args],
  { env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
