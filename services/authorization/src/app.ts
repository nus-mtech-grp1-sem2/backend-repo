import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAction, permits, policyVersion } from './policy.js';
import type { Access } from './policy.js';

export interface Dependencies {
  workloadToken: string;
  verify: (token: string) => Promise<{ sub: string }>;
  access: (sub: string, eventId: number) => Promise<Access>;
}
export class InvalidCallerToken extends Error {}
const digest = (value: string) => createHash('sha256').update(value).digest();
export function createApp(deps: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));
  app.get('/health', (_req, res) => { res.json({ status: 'ok', service: 'authorization' }); });
  app.post('/authorize', async (req, res) => {
    const decisionId = randomUUID();
    res.setHeader('X-Decision-Id', decisionId);
    res.setHeader('Cache-Control', 'no-store');
    const credential = req.header('X-Service-Token') ?? '';
    if (!deps.workloadToken || !timingSafeEqual(digest(credential), digest(deps.workloadToken))) {
      res.status(401).json({ error: 'invalid_service_credential' }); return;
    }
    const header = req.header('Authorization') ?? '';
    if (!header.startsWith('Bearer ') || !header.slice(7)) {
      res.status(401).json({ error: 'unauthenticated' }); return;
    }
    let caller: { sub: string };
    try { caller = await deps.verify(header.slice(7)); }
    catch (error) {
      res.status(error instanceof InvalidCallerToken ? 401 : 503).json({ error: error instanceof InvalidCallerToken ? 'unauthenticated' : 'authorization_unavailable' }); return;
    }
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['action', 'eventId'].includes(key)) || !isAction(input.action) ||
        (input.action !== 'event.create' && (!Number.isSafeInteger(input.eventId) || (input.eventId as number) < 1)) ||
        (input.action === 'event.create' && input.eventId !== undefined)) {
      res.status(400).json({ error: 'invalid_request' }); return;
    }
    try {
      const access = input.action === 'event.create' ? { roles: [], isOwner: false } : await deps.access(caller.sub, input.eventId as number);
      const allowed = permits(input.action, access);
      console.info(JSON.stringify({ decisionId, policyVersion, action: input.action, eventId: input.eventId, allowed }));
      res.status(allowed ? 200 : 403).json({ allowed, decisionId, policyVersion });
    } catch (error) {
      console.error('authorization decision unavailable', { decisionId, error: error instanceof Error ? error.message : 'unknown failure' });
      res.status(503).json({ error: 'authorization_unavailable', decisionId });
    }
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
    if (status >= 400 && status < 500) { res.status(status).json({ error: 'invalid_request' }); return; }
    console.error('authorization request failed');
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
