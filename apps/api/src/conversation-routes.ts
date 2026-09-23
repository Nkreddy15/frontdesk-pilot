import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, owner } from './auth.js';
import { startCall, command, commandSchema } from '../../../packages/core/src/conversation.js';
import { uuid } from '../../../packages/core/src/contracts.js';
export async function conversationRoutes(app: FastifyInstance) {
  app.post('/v1/simulator/calls', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return startCall(ctx, z.object({ locationId: uuid }).strict().parse(req.body).locationId);
  });
  app.post('/v1/simulator/calls/:id/actions', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = uuid.parse((req.params as any).id),
      b = z
        .object({ actionId: z.string().min(8).max(120), command: commandSchema })
        .strict()
        .parse(req.body);
    return command(ctx, id, b.actionId, b.command);
  });
}
