export class ProviderError extends Error {
  constructor(
    public code: string,
    public disposition: 'BLOCKED' | 'FAILED' | 'UNKNOWN' | 'RETRY' | 'SUPERSEDED',
  ) {
    super(code);
  }
}
export type Delivery = { providerId?: string; deliveryStatus?: string };
