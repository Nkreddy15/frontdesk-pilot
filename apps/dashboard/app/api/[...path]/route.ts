import { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!['auth', 'v1'].includes(path[0]))
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  const target = new URL(
    '/' + path.map(encodeURIComponent).join('/') + request.nextUrl.search,
    process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000',
  );
  const headers = new Headers();
  for (const k of ['content-type', 'cookie', 'origin', 'x-csrf-token', 'idempotency-key']) {
    const value = request.headers.get(k);
    if (value) headers.set(k, value);
  }
  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(25000),
    });
    const output = new Headers({
      'Content-Type': res.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
    });
    for (const value of res.headers.getSetCookie()) output.append('Set-Cookie', value);
    return new Response(res.body, { status: res.status, headers: output });
  } catch {
    return Response.json(
      {
        error: 'BACKEND_UNAVAILABLE',
        message:
          'The booking service is unavailable. No confirmation can be assumed. Retry with the same request.',
      },
      { status: 503 },
    );
  }
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
