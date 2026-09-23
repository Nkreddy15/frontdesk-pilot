import { mkdir, writeFile, readFile, chmod, chown, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
const root = process.cwd(),
  local = resolve(root, '.local'),
  data = resolve(local, 'postgres'),
  bin = resolve(root, 'node_modules/@embedded-postgres/linux-x64/native/bin');
const admin = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function run(name, args) {
  return new Promise((ok, fail) => {
    const p = spawn(resolve(bin, name), args, { ...admin, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (b) => (log += b));
    p.stderr.on('data', (b) => (log += b));
    p.on('error', fail);
    p.on('exit', (code) => (code === 0 ? ok(log) : fail(new Error(`${name} failed: ${log}`))));
  });
}
await mkdir(local, { recursive: true, mode: 0o755 });
const action = process.argv[2] || 'start';
if (action === 'setup' && !(await exists(resolve(root, '.env')))) {
  const dbPass = randomBytes(24).toString('hex'),
    appPass = randomBytes(24).toString('hex'),
    token = randomBytes(24).toString('hex');
  let env = await readFile(resolve(root, '.env.example'), 'utf8');
  const values = {
    DATABASE_URL: `postgresql://receptionist_app:${appPass}@127.0.0.1:55432/receptionist`,
    MIGRATION_DATABASE_URL: `postgresql://postgres:${dbPass}@127.0.0.1:55432/receptionist`,
    DEV_AUTH_ENABLED: 'true',
    DEV_AUTH_TOKEN: token,
    SESSION_SECRET: randomBytes(48).toString('hex'),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_TENANT_IDS: '10000000-0000-4000-8000-000000000001',
  };
  for (const [k, v] of Object.entries(values))
    env = env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
  await writeFile(resolve(root, '.env'), env, { mode: 0o600 });
  await writeFile(resolve(local, 'owner-access-code.txt'), token + '\n', { mode: 0o600 });
}
dotenv.config({ quiet: true });
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Configure .env first.');
const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL);
if (ownerUrl.hostname !== '127.0.0.1' || ownerUrl.port !== '55432')
  throw new Error('Local database script only manages 127.0.0.1:55432.');
if (action === 'stop') {
  await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  process.stdout.write('Local PostgreSQL stopped.\n');
  process.exit(0);
}
if (!(await exists(resolve(data, 'PG_VERSION')))) {
  if (action !== 'setup') throw new Error('Run npm run setup:local.');
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (admin.uid) await chown(data, admin.uid, admin.gid);
  const pw = resolve(local, 'init-password');
  await writeFile(pw, decodeURIComponent(ownerUrl.password), { mode: 0o600 });
  if (admin.uid) await chown(pw, admin.uid, admin.gid);
  await run('initdb', [
    '-D',
    data,
    '-U',
    'postgres',
    '--auth=scram-sha-256',
    `--pwfile=${pw}`,
    '--encoding=UTF8',
    '--locale=C',
  ]);
  const { unlink } = await import('node:fs/promises');
  await unlink(pw);
}
let active = false;
try {
  await run('pg_ctl', ['-D', data, 'status']);
  active = true;
} catch {}
if (!active)
  await run('pg_ctl', [
    '-D',
    data,
    '-l',
    resolve(data, 'server.log'),
    '-o',
    `-p 55432 -h 127.0.0.1 -k ${data}`,
    '-w',
    'start',
  ]);
if (action === 'setup') {
  const adminUrl = new URL(ownerUrl);
  adminUrl.pathname = '/postgres';
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='receptionist'")).rowCount)
    await client.query('CREATE DATABASE receptionist');
  const appPass = decodeURIComponent(new URL(process.env.DATABASE_URL).password);
  if (!/^[a-f0-9]{48}$/.test(appPass))
    throw new Error('Use a generated local application password.');
  if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname='receptionist_app'")).rowCount)
    await client.query(
      `CREATE ROLE receptionist_app LOGIN PASSWORD '${appPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  await client.end();
}
process.stdout.write(
  'Real PostgreSQL is running on localhost:55432. Credentials remain in .env.\n',
);
