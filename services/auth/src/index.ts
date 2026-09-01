import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import bcrypt from "bcryptjs";
import "dotenv/config";
import express from "express";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import mysql from "mysql2/promise";

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

const SERVICE = "auth";
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3007);

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "";

/** Roles a user is allowed to grant themselves at sign-up. */
const SELF_SERVICE_ROLES = new Set(["customer", "organiser", "event-helper"]);
const DEFAULT_ROLE = "customer";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: SERVICE });
});

// Configuration is read once at startup so a misconfigured deployment is
// obvious from the health endpoint rather than from a 500 on first sign-in.
const configured = USER_POOL_ID.length > 0 && CLIENT_ID.length > 0;

const verifier = configured
  ? CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      clientId: CLIENT_ID,
      tokenUse: "access",
    })
  : null;

const idTokenVerifier = configured
  ? CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      clientId: CLIENT_ID,
      tokenUse: "id",
    })
  : null;

const cognito = new CognitoIdentityProviderClient({});

const databaseConfigured = Boolean(
  process.env.DB_HOST &&
  process.env.DB_NAME &&
  process.env.DB_USER &&
  process.env.DB_PASSWORD,
);

const database = mysql.createPool({
  host: process.env.DB_HOST ?? "",
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? "",
  user: process.env.DB_USER ?? "",
  password: process.env.DB_PASSWORD ?? "",
  connectionLimit: 4,
  ...(process.env.DB_SSL === "false"
    ? {}
    : { ssl: { rejectUnauthorized: false } }),
});

interface Caller {
  readonly username: string;
  readonly sub: string;
  readonly groups: readonly string[];
}

interface LoginIdentity {
  readonly sub: string;
  readonly email: string;
}

/**
 * Verifies the bearer token and puts the caller on the request.
 *
 * Signature, expiry, issuer, audience and token use are all checked by
 * aws-jwt-verify, which caches the pool's public keys.
 */
async function authenticate(req: express.Request): Promise<Caller | null> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !verifier) {
    return null;
  }

  try {
    const claims = await verifier.verify(token);
    const groups = claims["cognito:groups"];
    return {
      username: String(claims.username),
      sub: String(claims.sub),
      groups: Array.isArray(groups) ? groups.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** Verifies an ID token used only to establish the email-to-sub database link. */
async function authenticateLoginIdentity(req: express.Request): Promise<LoginIdentity | null> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !idTokenVerifier) {
    return null;
  }

  try {
    const claims = await idTokenVerifier.verify(token);
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    return typeof claims.sub === "string" && email ? { sub: claims.sub, email } : null;
  } catch {
    return null;
  }
}

/**
 * Records a successful sign-in for the security audit trail. Best-effort:
 * a logging failure (or an unmapped Cognito user) must never block sign-in.
 */
async function recordLogin(identity: LoginIdentity, req: express.Request): Promise<void> {
  if (!databaseConfigured) {
    return;
  }
  try {
    await database.execute(
      "UPDATE users SET cognito_sub = ? WHERE email = ? AND cognito_sub IS NULL",
      [identity.sub, identity.email],
    );
    const [rows] = await database.query<mysql.RowDataPacket[]>(
      "SELECT user_id FROM users WHERE cognito_sub = ? LIMIT 1",
      [identity.sub],
    );
    const userId = rows[0]?.user_id;
    if (!userId) {
      console.warn("login history skipped: no users row for Cognito sub %s", identity.sub);
      return;
    }
    await database.execute(
      "INSERT INTO user_login_history (user_id, ip_address, user_agent) VALUES (?, ?, ?)",
      [userId, req.ip ?? null, req.header("user-agent") ?? null],
    );
  } catch (error) {
    console.error("login history insert failed for %s", identity.sub, error);
  }
}

/**
 * Grants the group for the role recorded on the user, and reports the role the
 * caller now holds.
 *
 * Idempotent: adding a user to a group they are already in is a no-op, so the
 * SPA can call this on every sign-in without checking first.
 */
app.post("/roles/sync", async (req, res) => {
  if (!configured) {
    res.status(503).json({ error: "cognito_not_configured" });
    return;
  }

  const caller = await authenticate(req);
  if (!caller) {
    res.status(401).json({ error: "unauthenticated" });
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
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: caller.username,
      }),
    );

    const requested = user.UserAttributes?.find(
      (attr) => attr.Name === "custom:role",
    )?.Value;
    const role =
      requested && SELF_SERVICE_ROLES.has(requested) ? requested : DEFAULT_ROLE;

    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: caller.username,
        GroupName: role,
      }),
    );

    res.json({ role, groups: [role], changed: true });
  } catch (error) {
    console.error("role sync failed for %s", caller.sub, error);
    res.status(502).json({ error: "role_sync_failed" });
  }
});

/**
 * Records a successful sign-in. The ID token provides verified email and sub
 * to establish the durable Cognito-to-users database linkage.
 */
app.post("/login-history", async (req, res) => {
  const identity = await authenticateLoginIdentity(req);
  if (!identity) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  await recordLogin(identity, req);
  res.status(204).end();
});

/**
 * Creates a row in the `users` table (see database/TABLES.md §1).
 * Called after email confirmation succeeds; Cognito manages authentication.
 */
interface UserRegistration {
  readonly name?: unknown;
  readonly email?: unknown;
}

app.post("/users", async (req, res) => {
  if (!databaseConfigured) {
    res.status(503).json({ error: "database_not_configured" });
    return;
  }

  const caller = await authenticate(req);
  const body = req.body as UserRegistration;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (name.length < 1 || name.length > 100) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }

  if (!caller && !email) {
    res.status(400).json({ error: "email_required" });
    return;
  }

  const targetEmail = caller?.username ?? email;
  const [existing] = await database.query<mysql.RowDataPacket[]>(
    "SELECT user_id FROM users WHERE email = ? LIMIT 1",
    [targetEmail],
  );
  if (existing.length > 0) {
    res.json({ created: false });
    return;
  }

  const nameParts = name.split(/\s+/);
  const firstName = nameParts.shift() ?? name;
  const lastName = nameParts.join(" ") || firstName;
  const username = (caller?.sub ? `user-${caller.sub}` : email || name).slice(0, 50);

  try {
    await database.execute(
      "INSERT INTO users (username, email, first_name, last_name, status, email_verified) " +
        "VALUES (?, ?, ?, ?, 'active', TRUE)",
      [username, targetEmail, firstName, lastName],
    );
    res.status(201).json({ created: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      res.json({ created: false });
      return;
    }
    console.error("user registration failed for %s", caller?.sub ?? targetEmail, error);
    res.status(502).json({ error: "user_registration_failed" });
  }
});

interface OldCustomerRegistration {
  readonly name?: unknown;
  readonly password?: unknown;
}

app.post("/customers", async (req, res) => {
  if (!databaseConfigured) {
    res.status(503).json({ error: "database_not_configured" });
    return;
  }

  const caller = await authenticate(req);
  if (!caller) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const body = req.body as OldCustomerRegistration;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (
    name.length < 1 ||
    name.length > 100 ||
    password.length < 8 ||
    password.length > 128
  ) {
    res.status(400).json({ error: "invalid_customer_details" });
    return;
  }

  const [existing] = await database.query<mysql.RowDataPacket[]>(
    "SELECT customer_id FROM customers WHERE email = ? LIMIT 1",
    [caller.username],
  );
  if (existing.length > 0) {
    res.json({ created: false });
    return;
  }

  const nameParts = name.split(/\s+/);
  const firstName = nameParts.shift() ?? name;
  const lastName = nameParts.join(" ") || firstName;
  const passwordHash = await bcrypt.hash(password, 12);
  const customerName = `customer-${caller.sub}`.slice(0, 50);

  try {
    await database.execute(
      "INSERT INTO customers (customer_name, admin_ind, operator_ind, email, password_hash, first_name, last_name, email_verified) " +
        "VALUES (?, 'N', 'N', ?, ?, ?, ?, TRUE)",
      [customerName, caller.username, passwordHash, firstName, lastName],
    );
    res.status(201).json({ created: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      res.json({ created: false });
      return;
    }
    console.error("customer registration failed for %s", caller.sub, error);
    res.status(502).json({ error: "customer_registration_failed" });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
  if (!configured) {
    console.warn(
      "COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID are unset: /roles/sync returns 503",
    );
  }
});
