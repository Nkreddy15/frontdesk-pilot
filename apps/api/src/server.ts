import { buildApp } from './app.js';
import { config } from '../../../packages/core/src/config.js';
import { pool, usingWasm, verifyRuntimeDatabase } from '../../../packages/core/src/db.js';
import { startWorker } from '../../worker/src/jobs.js';
const app = await buildApp();
await verifyRuntimeDatabase();
await app.listen({ host: config.host, port: config.port });
const stop = usingWasm ? startWorker() : () => {};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
