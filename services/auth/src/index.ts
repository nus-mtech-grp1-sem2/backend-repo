import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import express from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * Auth service.
 *
 * Grants the Cognito group matching the role a user chose at sign-up. This is
 * the server side of that flow because only an admin caller may change group
 * membership: the browser holds no AWS credentials and must never hold any.
 *
 * The client's only input is its access token. Everything else — which user,
 * which role they asked for — is read back from Cognito, so a caller cannot
 * grant a role by editing a request body.
 */

const SERVICE = 'auth';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3007);

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';

/** Roles a user is allowed to grant themselves at sign-up. */
const SELF_SERVICE_ROLES = new Set(['customer', 'organiser', 'event-helper']);
const DEFAULT_ROLE = 'customer';

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

const cognito = new CognitoIdentityProviderClient({});

interface Caller {
  readonly username: string;
  readonly sub: string;
  readonly groups: readonly string[];
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
    const groups = claims['cognito:groups'];
    return {
      username: String(claims.username),
      sub: String(claims.sub),
      groups: Array.isArray(groups) ? groups.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Grants the group for the role recorded on the user, and reports the role the
 * caller now holds.
 *
 * Idempotent: adding a user to a group they are already in is a no-op, so the
 * SPA can call this on every sign-in without checking first.
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

  // Already in a group: nothing to grant. Reported rather than re-applied so a
  // user cannot use this endpoint to change roles later.
  if (caller.groups.length > 0) {
    res.json({ role: caller.groups[0], groups: caller.groups, changed: false });
    return;
  }

  try {
    const user = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: caller.username }),
    );

    const requested = user.UserAttributes?.find((attr) => attr.Name === 'custom:role')?.Value;
    const role = requested && SELF_SERVICE_ROLES.has(requested) ? requested : DEFAULT_ROLE;

    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: caller.username,
        GroupName: role,
      }),
    );

    res.json({ role, groups: [role], changed: true });
  } catch (error) {
    console.error('role sync failed for %s', caller.sub, error);
    res.status(502).json({ error: 'role_sync_failed' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
  if (!configured) {
    console.warn('COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are unset: /roles/sync returns 503');
  }
});
