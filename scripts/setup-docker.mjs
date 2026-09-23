import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
if (process.env.NODE_ENV === 'production')
  throw new Error('This command is for local development only.');
await mkdir('.local', { recursive: true, mode: 0o700 });
const prior = await readFile('.env', 'utf8').catch(() => null);
if (prior) {
  const old = dotenv.parse(prior);
  if (
    old.DATABASE_URL &&
    !old.DATABASE_URL.includes('CHANGE_ME') &&
    !old.DATABASE_URL.includes('@127.0.0.1:55432/')
  )
    throw new Error(
      'Existing database configuration detected. Use a clean checkout for Docker setup.',
    );
  if (old.USE_PGLITE === 'true')
    throw new Error(
      'Preserve your WASM checkout. Use a separate checkout for native PostgreSQL validation.',
    );
}
const old = dotenv.parse(prior || ''),
  adminPass =
    old.MIGRATION_DATABASE_URL && !old.MIGRATION_DATABASE_URL.includes('CHANGE_ME')
      ? decodeURIComponent(new URL(old.MIGRATION_DATABASE_URL).password)
      : randomBytes(24).toString('hex');
const appPass =
  old.DATABASE_URL && !old.DATABASE_URL.includes('CHANGE_ME')
    ? decodeURIComponent(new URL(old.DATABASE_URL).password)
    : randomBytes(24).toString('hex');
if (!/^[a-f0-9]{48}$/.test(adminPass) || !/^[a-f0-9]{48}$/.test(appPass))
  throw new Error('Use generated local passwords.');
const token = old.DEV_AUTH_TOKEN || randomBytes(24).toString('hex');
let env = prior || (await readFile('.env.example', 'utf8'));
const values = {
  USE_PGLITE: 'false',
  DATABASE_URL: `postgresql://receptionist_app:${appPass}@127.0.0.1:55432/receptionist`,
  MIGRATION_DATABASE_URL: `postgresql://postgres:${adminPass}@127.0.0.1:55432/receptionist`,
  DATABASE_SSL: 'false',
  DEV_AUTH_ENABLED: 'true',
  DEV_AUTH_TOKEN: token,
  SESSION_SECRET: old.SESSION_SECRET || randomBytes(48).toString('hex'),
  TOKEN_ENCRYPTION_KEY: old.TOKEN_ENCRYPTION_KEY || randomBytes(32).toString('hex'),
  WORKER_TENANT_IDS: '10000000-0000-4000-8000-000000000001',
};
for (const [k, v] of Object.entries(values))
  env = new RegExp(`^${k}=.*$`, 'm').test(env)
    ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`)
    : env + `\n${k}=${v}\n`;
await writeFile('.env', env, { mode: 0o600 });
await writeFile('.local/owner-access-code.txt', token + '\n', { mode: 0o600 });
await writeFile(
  '.local/docker.env',
  `POSTGRES_PASSWORD=${adminPass}\nAPP_DB_PASSWORD=${appPass}\n`,
  { mode: 0o600 },
);
const child = spawn(
  'docker',
  ['compose', '--env-file', '.local/docker.env', 'up', '-d', '--wait', 'db'],
  { stdio: 'inherit' },
);
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', resolve);
});
if (code !== 0) throw new Error('Docker PostgreSQL failed to start.');
console.log(
  'Native PostgreSQL is ready at 127.0.0.1:55432. Applying migrations is the next setup step.',
);
