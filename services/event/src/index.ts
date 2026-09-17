import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { AdminGetUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { AttributeType } from '@aws-sdk/client-cognito-identity-provider';

const SERVICE = 'event';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3001);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const configured = USER_POOL_ID.length > 0 && CLIENT_ID.length > 0;
const verifier = configured
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;
const cognito = new CognitoIdentityProviderClient({});

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

const databaseConfigured = Boolean(
  process.env.DB_HOST &&
  process.env.DB_NAME &&
  process.env.DB_USER &&
  process.env.DB_PASSWORD,
);

const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT ?? 4),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 10000),
  enableKeepAlive: true,
  idleTimeout: Number(process.env.DB_IDLE_TIMEOUT ?? 60000),
  ...(process.env.DB_SSL === 'false'
    ? {}
    : { ssl: { rejectUnauthorized: false } }),
});

interface Caller {
  readonly sub: string;
}

interface EventInput {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly venue?: unknown;
  readonly startsAt?: unknown;
  readonly totalSeats?: unknown;
  readonly tier?: unknown;
  readonly price?: unknown;
  readonly priceCents?: unknown;
}

interface TeamInviteInput {
  readonly username?: unknown;
  readonly email?: unknown;
  readonly role?: unknown;
}

async function authenticate(req: express.Request): Promise<Caller | null> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !verifier) return null;

  try {
    const claims = await verifier.verify(token);
    return { sub: String(claims.sub) };
  } catch {
    return null;
  }
}

async function requireAuthenticated(req: express.Request, res: express.Response): Promise<Caller | null> {
  const caller = await authenticate(req);
  if (!caller) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  return caller;
}

function parsePriceCents(price: unknown): number | null {
  if (price === undefined) return null;
  const amount = typeof price === 'number' ? price : typeof price === 'string' ? Number(price) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 0.000001 ? cents : null;
}

function parseEventInput(input: EventInput): { title: string; description: string | null; venue: string; startsAt: string; totalSeats: number; tier: string; priceCents: number | null } | null {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() || null : null;
  const venue = typeof input.venue === 'string' ? input.venue.trim() : '';
  const startsAt = typeof input.startsAt === 'string' ? input.startsAt.trim() : '';
  const totalSeats = typeof input.totalSeats === 'number' ? input.totalSeats : Number.NaN;
  const tier = input.tier === 'TIER1_GA' || input.tier === 'TIER2_SEATED' ? input.tier : '';
  const priceCents = input.price === undefined ? (input.priceCents === undefined ? null : typeof input.priceCents === 'number' ? input.priceCents : Number.NaN) : parsePriceCents(input.price);
  if (!title || title.length > 255 || !venue || venue.length > 255 || !Number.isSafeInteger(totalSeats) || totalSeats < 1 || totalSeats > 1_000_000 || !tier || Number.isNaN(Date.parse(startsAt))) return null;
  if (priceCents !== null && (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100_000_000)) return null;
  return { title, description, venue, startsAt, totalSeats, tier, priceCents };
}

async function ownsEvent(eventId: number, sub: string): Promise<boolean> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT event_id FROM events WHERE event_id = ? AND organiser_sub = ? LIMIT 1',
    [eventId, sub],
  );
  return rows.length > 0;
}

async function isEventOrganiser(eventId: number, sub: string): Promise<boolean> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    "SELECT membership_id FROM event_team_memberships WHERE event_id = ? AND user_sub = ? AND role = 'ORGANISER' AND invite_status = 'ACCEPTED' LIMIT 1",
    [eventId, sub],
  );
  return rows.length > 0;
}

async function provisionSeats(connection: mysql.PoolConnection, eventId: number, inventoryItemId: number, totalSeats: number): Promise<void> {
  for (let seatNumber = 1; seatNumber <= totalSeats; seatNumber += 1) {
    await connection.execute(
      'INSERT INTO seats (event_id, inventory_item_id, seat_label) VALUES (?, ?, ?)',
      [eventId, inventoryItemId, `S${String(seatNumber).padStart(3, '0')}`],
    );
  }
}

async function requireEventOrganiser(req: express.Request, res: express.Response, eventId: number): Promise<Caller | null> {
  const caller = await authenticate(req);
  if (!caller) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  if (!(await isEventOrganiser(eventId, caller.sub))) {
    res.status(403).json({ error: 'event_organiser_required' });
    return null;
  }
  return caller;
}

function validEventId(value: string): number | null {
  const eventId = Number(value);
  return Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null;
}

function attribute(attributes: readonly AttributeType[] | undefined, name: string): string {
  return attributes?.find((item) => item.Name === name)?.Value ?? '';
}

/** Published events list, newest start date first. */
async function listEvents(_req: express.Request, res: express.Response) {
  if (!databaseConfigured) {
    res.status(503).json({ error: 'database_not_configured' });
    return;
  }

  try {
    const [rows] = await database.query(
      "SELECT event_id, title AS event_name, tier AS event_type, starts_at AS event_start_datetime, total_seats, " +
        "NULL AS event_end_datetime, status FROM events WHERE status = 'PUBLISHED' ORDER BY starts_at ASC",
    );
    res.json({ events: rows });
  } catch (error) {
    console.error('failed to list events', error);
    res.status(502).json({ error: 'events_list_failed' });
  }
}

app.get('/events', listEvents);

app.get('/helper/shifts', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;
  try {
    const [events] = await database.query(
      "SELECT events.event_id, events.title, events.venue, events.starts_at, events.total_seats FROM events INNER JOIN event_team_memberships ON event_team_memberships.event_id = events.event_id WHERE event_team_memberships.user_sub = ? AND event_team_memberships.role IN ('HELPER', 'ORGANISER') AND event_team_memberships.invite_status = 'ACCEPTED' AND events.status = 'PUBLISHED' ORDER BY events.starts_at ASC",
      [caller.sub],
    );
    res.json({ events });
  } catch (error) {
    console.error('failed to list helper shifts', error);
    res.status(502).json({ error: 'helper_shifts_failed' });
  }
});

app.get('/events/manage', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;
  const [events] = await database.query(
    "SELECT events.event_id, events.title, events.description, events.venue, events.starts_at, events.total_seats, events.tier, events.status, inventory.price_cents, COALESCE(inventory.remaining_qty, 0) AS remaining_qty, COALESCE(inventory.total_qty, 0) AS inventory_total_qty FROM events INNER JOIN event_team_memberships ON event_team_memberships.event_id = events.event_id LEFT JOIN (SELECT event_id, MIN(price_cents) AS price_cents, SUM(total_qty - reserved_qty - sold_qty) AS remaining_qty, SUM(total_qty) AS total_qty FROM inventory_items GROUP BY event_id) AS inventory ON inventory.event_id = events.event_id WHERE event_team_memberships.user_sub = ? AND event_team_memberships.role = 'ORGANISER' AND event_team_memberships.invite_status = 'ACCEPTED' ORDER BY events.starts_at ASC",
    [caller.sub],
  );
  res.json({ events });
});

app.get('/events/:eventId', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    "SELECT events.event_id, events.organiser_sub, events.title, events.description, events.venue, events.starts_at, events.total_seats, events.tier, events.status, inventory_items.price_cents FROM events LEFT JOIN inventory_items ON inventory_items.event_id = events.event_id AND inventory_items.name = 'General Admission' WHERE events.event_id = ? LIMIT 1",
    [eventId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'event_not_found' });
  res.json({ event: rows[0] });
});

app.get('/events/:eventId/seats', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = Number(req.params.eventId);
  if (!Number.isSafeInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'invalid_event' });
  try {
    const [seats] = await database.query<mysql.RowDataPacket[]>(
      `SELECT seat_id, seat_label, status
         FROM seats WHERE event_id = ? ORDER BY seat_id`,
      [eventId],
    );
    return res.json({ seats });
  } catch (error) {
    console.error('failed to list event seats', error);
    return res.status(502).json({ error: 'event_seats_failed' });
  }
});

app.post('/events', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const caller = await requireAuthenticated(req, res);
  const input = parseEventInput(req.body as EventInput);
  if (!caller) return;
  if (!input) return res.status(400).json({ error: 'invalid_event' });

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      'INSERT INTO events (organiser_sub, title, description, venue, starts_at, total_seats, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [caller.sub, input.title, input.description, input.venue, input.startsAt, input.totalSeats, input.tier],
    );
    if (input.priceCents !== null) {
      const [inventory] = await connection.execute<mysql.ResultSetHeader>(
        'INSERT INTO inventory_items (event_id, name, total_qty, price_cents) VALUES (?, ?, ?, ?)',
        [result.insertId, 'General Admission', input.totalSeats, input.priceCents],
      );
      if (input.tier === 'TIER2_SEATED') await provisionSeats(connection, result.insertId, inventory.insertId, input.totalSeats);
    }
    await connection.execute(
      "INSERT INTO event_team_memberships (event_id, user_sub, user_email, role, invite_status, granted_by_sub) VALUES (?, ?, '', 'ORGANISER', 'ACCEPTED', ?)",
      [result.insertId, caller.sub, caller.sub],
    );
    await connection.commit();
    res.status(201).json({ eventId: result.insertId });
  } catch (error) {
    await connection.rollback();
    console.error('failed to create event', error);
    res.status(502).json({ error: 'event_create_failed' });
  } finally {
    connection.release();
  }
});

app.put('/events/:eventId', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const caller = await requireAuthenticated(req, res);
  const eventId = Number(req.params.eventId);
  const input = parseEventInput(req.body as EventInput);
  if (!caller) return;
  if (!Number.isSafeInteger(eventId) || eventId < 1 || !input) return res.status(400).json({ error: 'invalid_event' });
  if (!(await isEventOrganiser(eventId, caller.sub))) return res.status(403).json({ error: 'event_organiser_required' });
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'UPDATE events SET title = ?, description = ?, venue = ?, starts_at = ?, total_seats = ?, tier = ? WHERE event_id = ?',
      [input.title, input.description, input.venue, input.startsAt, input.totalSeats, input.tier, eventId],
    );
    if (input.priceCents !== null) {
      const [items] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT inventory_item_id FROM inventory_items WHERE event_id = ? AND name = 'General Admission' LIMIT 1",
        [eventId],
      );
      if (items.length === 0) {
        await connection.execute(
          "INSERT INTO inventory_items (event_id, name, total_qty, price_cents) VALUES (?, 'General Admission', ?, ?)",
          [eventId, input.totalSeats, input.priceCents],
        );
      } else {
        await connection.execute(
          'UPDATE inventory_items SET price_cents = ? WHERE inventory_item_id = ?',
          [input.priceCents, items[0]!.inventory_item_id],
        );
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error('failed to update event', error);
    return res.status(502).json({ error: 'event_update_failed' });
  } finally {
    connection.release();
  }
  res.status(204).end();
});

app.post('/events/:eventId/publish', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const caller = await requireAuthenticated(req, res);
  const eventId = Number(req.params.eventId);
  if (!caller) return;
  if (!Number.isSafeInteger(eventId) || !(await isEventOrganiser(eventId, caller.sub))) return res.status(403).json({ error: 'event_organiser_required' });
  await database.execute("UPDATE events SET status = 'PUBLISHED' WHERE event_id = ?", [eventId]);
  res.status(204).end();
});

app.post('/events/:eventId/cancel', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const caller = await requireAuthenticated(req, res);
  const eventId = Number(req.params.eventId);
  if (!caller) return;
  if (!Number.isSafeInteger(eventId) || !(await isEventOrganiser(eventId, caller.sub))) return res.status(403).json({ error: 'event_organiser_required' });
  await database.execute("UPDATE events SET status = 'CANCELLED' WHERE event_id = ?", [eventId]);
  res.status(204).end();
});

app.delete('/events/:eventId', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const caller = await requireAuthenticated(req, res);
  const eventId = Number(req.params.eventId);
  if (!caller) return;
  if (!Number.isSafeInteger(eventId) || !(await isEventOrganiser(eventId, caller.sub))) return res.status(403).json({ error: 'event_organiser_required' });
  const [result] = await database.execute<mysql.ResultSetHeader>("DELETE FROM events WHERE event_id = ? AND status = 'DRAFT'", [eventId]);
  if (result.affectedRows === 0) return res.status(409).json({ error: 'only_draft_events_can_be_deleted' });
  res.status(204).end();
});

app.get('/events/:eventId/users', async (req, res) => {
  const eventId = validEventId(req.params.eventId);
  if (!configured) return res.status(503).json({ error: 'cognito_not_configured' });
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  if (search.length < 2) return res.status(400).json({ error: 'search_requires_two_characters' });
  try {
    const result = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }));
    const users = (result.Users ?? []).map((user) => {
      const name = attribute(user.Attributes, 'name');
      return { username: user.Username ?? '', firstName: attribute(user.Attributes, 'given_name') || name.split(' ')[0] || '', lastName: attribute(user.Attributes, 'family_name') || name.split(' ').slice(1).join(' '), email: attribute(user.Attributes, 'email') };
    }).filter((user) => user.email && `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(search)).slice(0, 20);
    res.json({ users });
  } catch (error) {
    console.error('failed to list Cognito users', error);
    res.status(502).json({ error: 'cognito_users_unavailable' });
  }
});

app.get('/events/:eventId/team-members', async (req, res) => {
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;
  const [members] = await database.query(
    "SELECT membership_id, user_sub, user_email, role, invite_status, granted_by_sub, granted_at, responded_at FROM event_team_memberships WHERE event_id = ? ORDER BY role, user_email",
    [eventId],
  );
  res.json({ members });
});

app.delete('/events/:eventId/team-members/:userSub', async (req, res) => {
  const eventId = validEventId(req.params.eventId);
  const caller = await requireAuthenticated(req, res);
  const memberSub = req.params.userSub;
  if (!caller) return;
  if (!eventId || !memberSub || memberSub === caller.sub) return res.status(400).json({ error: 'invalid_team_member_removal' });
  const [events] = await database.query<mysql.RowDataPacket[]>(
    'SELECT organiser_sub FROM events WHERE event_id = ? LIMIT 1',
    [eventId],
  );
  if (events.length === 0) return res.status(404).json({ error: 'event_not_found' });
  const [members] = await database.query<mysql.RowDataPacket[]>(
    'SELECT role FROM event_team_memberships WHERE event_id = ? AND user_sub = ? LIMIT 1',
    [eventId, memberSub],
  );
  if (members.length === 0) return res.status(404).json({ error: 'team_member_not_found' });
  const event = events[0]!;
  const member = members[0]!;
  if (member.role === 'ORGANISER' && event.organiser_sub !== caller.sub) return res.status(403).json({ error: 'event_owner_required' });
  if (member.role === 'HELPER' && !(await isEventOrganiser(eventId, caller.sub))) return res.status(403).json({ error: 'event_organiser_required' });
  await database.execute('DELETE FROM event_team_memberships WHERE event_id = ? AND user_sub = ?', [eventId, memberSub]);
  res.status(204).end();
});

app.post('/events/:eventId/invitations', async (req, res) => {
  const eventId = validEventId(req.params.eventId);
  const body = req.body as TeamInviteInput;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body.role === 'ORGANISER' || body.role === 'HELPER' ? body.role : '';
  if (!configured) return res.status(503).json({ error: 'cognito_not_configured' });
  if (!eventId || (!username && !email) || !role) return res.status(400).json({ error: 'invalid_invitation' });
  const caller = await requireEventOrganiser(req, res, eventId);
  if (!caller) return;
  try {
    const [events] = await database.query<mysql.RowDataPacket[]>(
      'SELECT organiser_sub FROM events WHERE event_id = ? LIMIT 1',
      [eventId],
    );
    const eventOwnerSub = events[0]?.organiser_sub;
    if (!eventOwnerSub) return res.status(404).json({ error: 'event_not_found' });
    const user = email
      ? (await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Filter: `email = \"${email.replaceAll('"', '\\"')}\"`, Limit: 2 }))).Users?.[0]
      : await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    if (!user) return res.status(404).json({ error: 'invited_user_not_found' });
    const userAttributes =
      (user as { UserAttributes?: readonly AttributeType[] }).UserAttributes ??
      (user as { Attributes?: readonly AttributeType[] }).Attributes;
    const userSub = attribute(userAttributes, 'sub');
    const userEmail = attribute(userAttributes, 'email');
    if (!userSub || !userEmail) return res.status(400).json({ error: 'invited_user_missing_identity' });
    await database.execute(
      "INSERT INTO event_team_memberships (event_id, user_sub, user_email, role, invite_status, granted_by_sub) VALUES (?, ?, ?, ?, 'PENDING', ?)",
      [eventId, userSub, userEmail, role, eventOwnerSub],
    );
    res.status(201).json({ invited: true });
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'already_invited_or_member' });
    console.error('failed to invite team member', error);
    res.status(502).json({ error: 'invitation_failed' });
  }
});

app.post('/team-invitations/:membershipId/:decision', async (req, res) => {
  const caller = await authenticate(req);
  const membershipId = Number(req.params.membershipId);
  const decision = req.params.decision === 'accept' ? 'ACCEPTED' : req.params.decision === 'reject' ? 'REJECTED' : null;
  if (!caller) return res.status(401).json({ error: 'unauthenticated' });
  if (!Number.isSafeInteger(membershipId) || membershipId < 1 || !decision) return res.status(400).json({ error: 'invalid_invitation' });
  const [result] = await database.execute<mysql.ResultSetHeader>(
    "UPDATE event_team_memberships SET invite_status = ?, responded_at = CURRENT_TIMESTAMP WHERE membership_id = ? AND user_sub = ? AND invite_status = 'PENDING'",
    [decision, membershipId, caller.sub],
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'invitation_not_found' });
  res.status(204).end();
});

app.get('/team-invitations', async (req, res) => {
  const caller = await authenticate(req);
  if (!caller) return res.status(401).json({ error: 'unauthenticated' });
  const [invitations] = await database.query(
    "SELECT event_team_memberships.membership_id, event_team_memberships.event_id, event_team_memberships.role, events.title, events.venue, events.starts_at FROM event_team_memberships INNER JOIN events ON events.event_id = event_team_memberships.event_id WHERE event_team_memberships.user_sub = ? AND event_team_memberships.invite_status = 'PENDING' ORDER BY event_team_memberships.granted_at DESC",
    [caller.sub],
  );
  res.json({ invitations });
});

app.listen(PORT, HOST, () => {
  console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
});
