export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 422,
    public details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
export function databaseError(e: unknown): DomainError {
  if (e instanceof DomainError) return e;
  const error = e as { code?: string; message?: string };
  if (error.code === '23P01') return new DomainError('SLOT_CONFLICT', 409);
  if (error.code === '23503') return new DomainError('INVALID_REFERENCE', 422);
  if (error.code === '23514') return new DomainError('INVALID_STATE', 422);
  if (error.code === 'P0001')
    return new DomainError(
      error.message || 'INVALID_STATE',
      error.message === 'HOLD_EXPIRED' ? 410 : 409,
    );
  throw e;
}
