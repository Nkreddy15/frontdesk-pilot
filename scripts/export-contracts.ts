import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as c from '../packages/core/src/contracts.js';
import { commandSchema } from '../packages/core/src/conversation.js';
const schemas = {
  booking: c.bookingInput,
  availability: c.availabilityInput,
  confirmHold: c.confirmInput,
  reschedule: c.rescheduleInput,
  changeState: c.stateInput,
  block: c.blockInput,
  conversationCommand: commandSchema,
};
await writeFile(
  'docs/contracts.json',
  JSON.stringify(
    {
      description: 'Application request schemas; provider API schemas are separate.',
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
      ),
    },
    null,
    2,
  ) + '\n',
);
