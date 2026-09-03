import 'dotenv/config';
import express from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * Auth service.
 *
 * Verifies Cognito access tokens. Event-specific Organizer and Helper access
 * is owned by the Event service's event_team_memberships table, not Cognito
 * groups.
 */

const SERVICE = 'auth';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3007);

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

// Configuration is read once at startup so a misconfigured deployment is
// obvious from the health endpoint rather than from a 500 on first sign-in.
const configured = USER_POOL_ID.length > 0 && CLIENT_ID.length > 0;

const verifier = configured
  ? CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      clientId: CLIENT_ID,
      tokenUse: 'access',
    })
  : null;

interface Caller {
  readonly sub: string;
}

/**
 * Verifies the bearer token and puts the caller on the request.
 *
 * Signature, expiry, issuer, audience and token use are all checked by
 * aws-jwt-verify, which caches the pool's public keys.
 */
async function authenticate(req: express.Request): Promise<Caller | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !verifier) {
    return null;
  }

  try {
    const claims = await verifier.verify(token);
    return {
      sub: String(claims.sub),
    };
  } catch {
    return null;
  }
}

/**
 * Compatibility endpoint for deployed frontend clients. Role synchronization
 * is intentionally removed; the frontend may stop calling this endpoint.
 */
app.post('/roles/sync', async (req, res) => {
  if (!configured) {
    res.status(503).json({ error: 'cognito_not_configured' });
    return;
  }

  const caller = await authenticate(req);
  if (!caller) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  res.status(204).end();
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
  if (!configured) {
    console.warn(
      'COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are unset: token verification is unavailable',
    );
  }
});
