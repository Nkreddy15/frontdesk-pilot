import { DateTime } from 'luxon';
let csrf = '';
export const setCsrf = (value: string) => {
  csrf = value;
};
export class ApiError extends Error {
  constructor(
    public data: any,
    public status: number,
  ) {
    super(data.message || data.error?.replaceAll('_', ' ').toLowerCase() || 'Request failed');
  }
}
export async function api(path: string, method = 'GET', data?: unknown, key?: string) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await res.json();
  if (!res.ok) throw new ApiError(value, res.status);
  return value;
}
export const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const localTime = (value: string, zone: string, format = 'h:mm a') =>
  DateTime.fromISO(value, { setZone: true }).setZone(zone).toFormat(format);
export const dateInput = (value: string, zone: string) =>
  DateTime.fromISO(value, { setZone: true }).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");
export const toInstant = (value: string, zone: string) => {
  const d = DateTime.fromISO(value, { zone });
  if (!d.isValid || d.toFormat("yyyy-MM-dd'T'HH:mm") !== value)
    throw new Error('That local time does not exist. Choose another time.');
  if (d.getPossibleOffsets().length > 1)
    throw new Error(
      'That time is ambiguous because daylight saving time changes. Choose another time or use an availability option.',
    );
  return d.toUTC().toISO()!;
};
export type Bootstrap = {
  tenant: any;
  locations: any[];
  services: any[];
  resources: any[];
  settings: any;
  role: string;
  databaseMode: string;
  providerStatus: { voice: boolean; sms: boolean; calendar: boolean };
};
