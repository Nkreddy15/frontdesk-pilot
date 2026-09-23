import { startWorker } from './jobs.js';
import { pool, usingWasm, verifyRuntimeDatabase } from '../../../packages/core/src/db.js';
import { validateConfig } from '../../../packages/core/src/config.js';
validateConfig();
if (usingWasm) throw new Error('WASM development worker runs inside the API process.');
await verifyRuntimeDatabase();
const stop = startWorker();
console.log(JSON.stringify({ event: 'worker_started' }));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    stop();
    await pool.end();
    process.exit(0);
  });
