import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../../packages/core/src/config.js';
import { DEMO } from '../../../packages/core/src/demo.js';
import { withTenant, type Context } from '../../../packages/core/src/db.js';
import { DomainError } from '../../../packages/core/src/errors.js';
const secret = new TextEncoder().encode(config.sessionSecret);
const jwks = config.supabaseUrl
  ? createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`))
  : null;
export const equals = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function requireOrigin(req: FastifyRequest) {
  if (req.headers.origin !== config.dashboardOrigin) throw new DomainError('ORIGIN_REJECTED', 403);
}
export async function signIn(
  req: FastifyRequest,
  reply: FastifyReply,
  body: { accessCode?: string; email?: string; password?: string },
) {
  requireOrigin(req);
  let userId: string, tenantId: string;
  if (body.accessCode) {
    if (
      !config.devAuth ||
      config.production ||
      !config.devToken ||
      !equals(body.accessCode, config.devToken)
    )
      throw new DomainError('INVALID_CREDENTIALS', 401);
    userId = DEMO.owner;
    tenantId = DEMO.tenant;
  } else {
    if (!jwks || !body.email || !body.password) throw new DomainError('AUTH_NOT_CONFIGURED', 503);
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.email, password: body.password }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new DomainError('INVALID_CREDENTIALS', 401);
    const tokens = (await response.json()) as any;
    const verified = await jwtVerify(tokens.access_token, jwks, {
      issuer: `${config.supabaseUrl}/auth/v1`,
      audience: 'authenticated',
    });
    userId = verified.payload.sub!;
    tenantId = (verified.payload.app_metadata as any)?.tenant_id;
    if (!userId || !tenantId) throw new DomainError('MEMBERSHIP_REQUIRED', 403);
  }
  const ctx: Context = { tenantId, userId, role: 'VIEWER', traceId: req.id };
  const member = await withTenant(
    ctx,
    async (tx) =>
      (await tx.query('SELECT role FROM memberships WHERE user_id=$1', [userId])).rows[0],
  );
  if (!member) throw new DomainError('MEMBERSHIP_REQUIRED', 403);
  const csrf = randomBytes(24).toString('hex');
  const token = await new SignJWT({ tenantId, csrf })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('receptionist')
    .setAudience('dashboard')
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
  reply.setCookie('receptionist_session', token, {
    httpOnly: true,
    secure: config.production,
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 3600,
  });
  return { csrf, role: member.role, development: config.devAuth };
}
export async function authenticate(req: FastifyRequest): Promise<Context & { csrf: string }> {
  const token = req.cookies.receptionist_session;
  if (!token) throw new DomainError('UNAUTHENTICATED', 401);
  let payload: any;
  try {
    ({ payload } = await jwtVerify(token, secret, {
      issuer: 'receptionist',
      audience: 'dashboard',
      algorithms: ['HS256'],
    }));
  } catch {
    throw new DomainError('UNAUTHENTICATED', 401);
  }
  const ctx: Context = {
    tenantId: payload.tenantId,
    userId: payload.sub,
    role: 'VIEWER',
    traceId: req.id,
  };
  const member = await withTenant(
    ctx,
    async (tx) =>
      (await tx.query('SELECT role,resource_id FROM memberships WHERE user_id=$1', [ctx.userId]))
        .rows[0],
  );
  if (!member || (member.role === 'STAFF' && !member.resource_id))
    throw new DomainError('FORBIDDEN', 403);
  ctx.role = member.role;
  ctx.resourceId = member.resource_id;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    requireOrigin(req);
    if (
      typeof req.headers['x-csrf-token'] !== 'string' ||
      !equals(req.headers['x-csrf-token'], payload.csrf)
    )
      throw new DomainError('CSRF_REJECTED', 403);
  }
  return { ...ctx, csrf: payload.csrf };
}
export function owner(ctx: Context) {
  if (ctx.role !== 'OWNER') throw new DomainError('OWNER_REQUIRED', 403);
}
export function writeAccess(ctx: Context) {
  if (ctx.role !== 'OWNER' && ctx.role !== 'STAFF') throw new DomainError('WRITE_FORBIDDEN', 403);
}
