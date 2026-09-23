import { z } from 'zod';
export const uuid = z.string().uuid();
export const instant = z.string().datetime({ offset: true });
export const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use an international number, such as +15085550100.');
export const customerInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone,
    notes: z.string().max(1000).default(''),
  })
  .strict();
export const bookingInput = z
  .object({
    locationId: uuid,
    serviceId: uuid,
    staffId: uuid,
    startsAt: instant,
    customer: customerInput,
    notes: z.string().max(1000).default(''),
  })
  .strict();
export const availabilityInput = z
  .object({
    locationId: uuid,
    serviceId: uuid,
    staffId: uuid.optional(),
    from: instant,
    limit: z.coerce.number().int().min(1).max(48).default(12),
  })
  .strict();
export const confirmInput = z
  .object({
    locationId: uuid,
    holdToken: z.string().min(32).max(128),
    expectedVersion: z.number().int().positive(),
    readbackAccepted: z.literal(true),
  })
  .strict();
export const rescheduleInput = z
  .object({
    locationId: uuid,
    startsAt: instant,
    staffId: uuid,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const stateInput = z
  .object({
    locationId: uuid,
    expectedVersion: z.number().int().positive(),
    state: z.enum(['CANCELLED', 'COMPLETED', 'NO_SHOW']),
    reason: z.string().min(1).max(200),
  })
  .strict();
export const blockInput = z
  .object({
    locationId: uuid,
    resourceId: uuid,
    startsAt: instant,
    endsAt: instant,
    reason: z.string().trim().min(1).max(200),
  })
  .strict();
export type BookingInput = z.infer<typeof bookingInput>;
export type AvailabilityInput = z.infer<typeof availabilityInput>;
export type Result = { status: number; body: Record<string, any>; replayed?: boolean };
