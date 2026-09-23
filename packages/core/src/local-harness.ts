// PostgreSQL-WASM development harness. Serializes transactions; NOT a concurrency proof.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { resolve } from 'node:path';
import { openSync, closeSync, unlinkSync } from 'node:fs';
let instance: PGlite | undefined;
let lock: string | undefined;
export async function wasmDb() {
  const dataPath = resolve(process.cwd(), process.env.PGLITE_DATA_DIR || '.local/wasm-db');
  if (process.env.NODE_ENV === 'production')
    throw new Error('WASM harness is forbidden in production.');
  if (!instance) {
    if (process.env.NODE_ENV !== 'test') {
      lock = dataPath + '.lock';
      try {
        closeSync(openSync(lock, 'wx', 0o600));
      } catch {
        lock = undefined;
        throw new Error(
          'WASM database is already in use. Stop the other process. Remove .local/wasm-db.lock only after confirming no process owns it.',
        );
      }
    }
    instance = new PGlite(process.env.NODE_ENV === 'test' ? 'memory://' : dataPath, {
      extensions: { btree_gist },
    });
  }
  await instance.waitReady;
  return instance;
}
let tail = Promise.resolve();
export async function wasmConnect() {
  let release!: () => void;
  const prior = tail;
  tail = new Promise<void>((r) => (release = r));
  await prior;
  let db: PGlite;
  try {
    db = await wasmDb();
  } catch (e) {
    release();
    throw e;
  }
  return {
    query: async (sql: string, args?: unknown[]) => {
      const r = await db.query(sql, args);
      return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
    },
    release,
  };
}
export async function closeWasm() {
  if (instance) {
    await instance.close();
    instance = undefined;
  }
  if (lock) {
    unlinkSync(lock);
    lock = undefined;
  }
}
