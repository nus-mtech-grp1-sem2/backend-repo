import type { Request, Response } from 'express';

export interface AuthorizationClientOptions {
  url: string;
  serviceToken: string;
  timeoutMs?: number;
}

// Configure once per microservice, after loading its environment.
export function createAuthorizationGuard(options: AuthorizationClientOptions) {
  const endpoint = new URL(options.url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Authorization URL must be an HTTP(S) endpoint without credentials, query or fragment');
  }
  if (options.serviceToken.length < 32) throw new Error('Authorization service credential must contain at least 32 characters');
  const timeoutMs = options.timeoutMs ?? 500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Authorization timeout must be between 1 and 30000 ms');

  return async function requireAuthorization(req: Request, res: Response, action: string, eventId?: number): Promise<boolean> {
    const authorization = req.header('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ') || !authorization.slice(7)) {
      res.status(401).json({ error: 'unauthenticated' }); return false;
    }
    const requestId = req.header('X-Request-Id');
    try {
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json', Authorization: authorization,
          'X-Service-Token': options.serviceToken,
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        body: JSON.stringify({ action, ...(eventId === undefined ? {} : { eventId }) }),
      });
      // Bound response size and keep the same deadline through body consumption.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty authorization response');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8192) { await reader.cancel(); throw new Error('Oversized authorization response'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid authorization response');
      const result = body as Record<string, unknown>;
      if (response.status === 401 && result.error === 'unauthenticated') {
        res.status(401).json({ error: 'unauthenticated' }); return false;
      }
      const validDecision = typeof result.decisionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.decisionId) &&
        typeof result.policyVersion === 'string' && result.policyVersion.length > 0;
      if (response.status === 200 && result.allowed === true && validDecision) return true;
      if (response.status === 403 && result.allowed === false && validDecision) {
        res.status(403).json({ error: 'forbidden', decisionId: result.decisionId }); return false;
      }
      // Invalid workload credential is a server configuration failure, not user 401.
      throw new Error(`Unexpected authorization result (HTTP ${response.status})`);
    } catch (error) {
      console.error('authorization check unavailable', { action, eventId, requestId, reason: error instanceof Error ? error.name : 'unknown' });
      res.status(503).json({ error: 'authorization_unavailable' }); return false;
    }
  };
}
