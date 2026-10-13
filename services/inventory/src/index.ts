import express from 'express';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const SERVICE = 'inventory';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3002);
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
let verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'access' })
  : null;

/**
 * Test-only seam: swaps the Cognito verifier for a fake one so tests can
 * authenticate as a known `sub` without a real Cognito token. Never called
 * outside test code — production always uses the verifier built above from
 * real Cognito env vars.
 */
export function __setVerifierForTests(fake: typeof verifier): void {
  verifier = fake;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

// docker-compose sets DB_NAME to this service's schema directly; running
// outside docker (dev:local, tests) only has the per-schema DB_NAME_* vars
// from the root .env, so fall back to that — same pattern as services/event
// and services/ticket (ported from origin/main).
const databaseConfigured = Boolean(
  process.env.DB_HOST &&
  (process.env.DB_NAME || process.env.DB_NAME_EVENT_INVENTORY) &&
  process.env.DB_USER &&
  process.env.DB_PASSWORD,
);

const database = mysql.createPool({
  host: process.env.DB_HOST ?? '',
  port: Number(process.env.DB_PORT ?? 3306),
  database: process.env.DB_NAME ?? process.env.DB_NAME_EVENT_INVENTORY ?? '',
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  connectionLimit: 4,
  ...(process.env.DB_SSL === 'false'
    ? {}
    : { ssl: { rejectUnauthorized: false } }),
});

// A single PUT can define at most this many priced zones; seat count is
// naturally bounded by the grid dimensions below (one seat per cell).
const MAX_ZONES = 50;
/** Reserved seating creates one database seat per occupied cell. */
export const MAX_RESERVED_SEATS = 400;

// Stage pieces are stored as inventory_items rows with this sentinel name.
// They are non-sellable (price_cents=0, total_qty=0) and kept separate from
// real zones in API responses. Organisers may not use this as a zone name.
const STAGE_SENTINEL = '__STAGE__';
const MAX_STAGE_PIECES = 5;

// Virtual venue-map grid the organiser paints seats onto directly. Size is
// customizable per event (stored in event_grid_settings) between these
// bounds; must stay in sync with the same constants in event-inventory.ts.
const DEFAULT_GRID_ROWS = 6;
const DEFAULT_GRID_COLS = 8;
const MIN_GRID_DIM = 1;
export const MAX_RESERVED_GRID_DIM = 20;
/** General admission has no seats per cell, so its map has no practical size limit;
 * this only guards against nonsense (the columns are SMALLINT UNSIGNED). */
const MAX_GA_GRID_DIM = 10_000;

// A Hold reserves inventory ahead of payment (see CONTEXT.md). It expires on
// its own if the customer never checks out, so nothing gets stuck reserved.
const HOLD_TTL_SECONDS = 600;
const MAX_HOLD_QTY = 20;

interface Caller {
  readonly sub: string;
}

type EventTier = 'TIER1_GA' | 'TIER2_SEATED';

interface EventRow {
  readonly event_id: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
  readonly tier: EventTier;
  readonly has_started: number;
}

interface ZoneInput {
  readonly inventoryItemId?: unknown;
  readonly name?: unknown;
  readonly price?: unknown;
  readonly color?: unknown;
  readonly gridRow?: unknown;
  readonly gridCol?: unknown;
  readonly gridRowSpan?: unknown;
  readonly gridColSpan?: unknown;
  readonly quantity?: unknown;
}

/** A zone is a rectangular block of grid cells (one drag gesture creates it).
 * TIER2_SEATED events get one auto-labelled seat per cell in the rectangle;
 * TIER1_GA events use an organiser-supplied `gaQuantity` as capacity (when
 * present) or fall back to the rectangle area — see `putZoneInventory`. */
interface ParsedZone {
  readonly inventoryItemId: number | null;
  readonly name: string;
  readonly code: string;
  readonly priceCents: number;
  readonly color: string;
  readonly gridRow: number;
  readonly gridCol: number;
  readonly gridRowSpan: number;
  readonly gridColSpan: number;
  readonly gaQuantity: number | null;
}

interface GridDims {
  readonly gridRows: number;
  readonly gridCols: number;
}

export function reservedSeatCount(
  zones: readonly Pick<ParsedZone, 'gridRowSpan' | 'gridColSpan'>[],
): number {
  return zones.reduce((total, zone) => total + zone.gridRowSpan * zone.gridColSpan, 0);
}

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Zone colour is mandatory (it's how seats get "painted"), unlike the old
 * optional zone-rectangle colour. */
function parseRequiredColor(raw: unknown): string | null {
  if (typeof raw !== 'string' || !HEX_COLOR_PATTERN.test(raw)) return null;
  return raw.toUpperCase();
}

export function parseGridDims(
  raw: { gridRows?: unknown; gridCols?: unknown },
  fallback: GridDims,
  maxDim = MAX_RESERVED_GRID_DIM,
): GridDims | null {
  const gridRows = raw.gridRows === undefined ? fallback.gridRows : raw.gridRows;
  const gridCols = raw.gridCols === undefined ? fallback.gridCols : raw.gridCols;
  if (typeof gridRows !== 'number' || !Number.isInteger(gridRows) || gridRows < MIN_GRID_DIM || gridRows > maxDim) return null;
  if (typeof gridCols !== 'number' || !Number.isInteger(gridCols) || gridCols < MIN_GRID_DIM || gridCols > maxDim) return null;
  return { gridRows, gridCols };
}

async function fetchGridSettings(eventId: number): Promise<GridDims> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT grid_rows, grid_cols FROM event_grid_settings WHERE event_id = ? LIMIT 1',
    [eventId],
  );
  const row = rows[0];
  return row
    ? { gridRows: row.grid_rows as number, gridCols: row.grid_cols as number }
    : { gridRows: DEFAULT_GRID_ROWS, gridCols: DEFAULT_GRID_COLS };
}

const SEAT_TAGS = new Set(['NONE', 'ACCESSIBLE', 'MAINTENANCE']);
type SeatTag = 'NONE' | 'ACCESSIBLE' | 'MAINTENANCE';

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

async function isEventOrganiser(eventId: number, sub: string): Promise<boolean> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    "SELECT membership_id FROM event_team_memberships WHERE event_id = ? AND user_sub = ? AND role = 'ORGANISER' AND invite_status = 'ACCEPTED' LIMIT 1",
    [eventId, sub],
  );
  return rows.length > 0;
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

/** Same contract as `validEventId`, exported under the more generic name used
 * for other path/body ids (e.g. a hold id), which aren't event ids. */
export function positiveId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePriceCents(price: unknown): number | null {
  let amount: number;
  if (typeof price === 'number') {
    amount = price;
  } else if (typeof price === 'string') {
    amount = Number(price);
  } else {
    amount = Number.NaN;
  }
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 0.000001 ? cents : null;
}

async function fetchEvent(eventId: number): Promise<EventRow | null> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT event_id, status, tier, starts_at < UTC_TIMESTAMP() AS has_started FROM events WHERE event_id = ? LIMIT 1',
    [eventId],
  );
  return rows.length > 0 ? (rows[0] as unknown as EventRow) : null;
}

/** Spreadsheet-style row labels: 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB, ... */
function rowLabel(index: number): string {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCodePoint(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** Zone codes are always derived from the name (organisers no longer pick
 * one) so the seat-map builder has one less field to fill in. */
function deriveCode(name: string): string | null {
  const code = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  if (code.length >= 2) return code;
  if (code.length > 0) return code.padEnd(2, 'X');
  return null;
}

type ZoneFields = Omit<ParsedZone, 'code'> & { readonly code: string };

/** Parses and validates a single zone entry's own fields. Cross-zone checks
 * (overlap, code uniqueness) are the caller's job once every zone's
 * rectangle is known. Returns null on any invalid field. */
function parseZoneEntry(entry: ZoneInput, gridDims: GridDims): ZoneFields | null {
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const priceCents = parsePriceCents(entry.price);
  const code = name ? deriveCode(name) : null;
  const inventoryItemId = typeof entry.inventoryItemId === 'number' && Number.isSafeInteger(entry.inventoryItemId)
    ? entry.inventoryItemId
    : null;
  const color = parseRequiredColor(entry.color);
  const { gridRow, gridCol, gridRowSpan, gridColSpan } = entry;

  if (!name || name.length > 255 || name === STAGE_SENTINEL || !code || priceCents === null || !color) return null;
  if (typeof gridRow !== 'number' || !Number.isInteger(gridRow) || gridRow < 0) return null;
  if (typeof gridCol !== 'number' || !Number.isInteger(gridCol) || gridCol < 0) return null;
  if (typeof gridRowSpan !== 'number' || !Number.isInteger(gridRowSpan) || gridRowSpan < 1) return null;
  if (typeof gridColSpan !== 'number' || !Number.isInteger(gridColSpan) || gridColSpan < 1) return null;
  if (gridRow + gridRowSpan > gridDims.gridRows || gridCol + gridColSpan > gridDims.gridCols) return null;

  let gaQuantity: number | null = null;
  if (entry.quantity !== undefined) {
    const q = entry.quantity;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1) return null;
    gaQuantity = q;
  }

  return { inventoryItemId, name, code, priceCents, color, gridRow, gridCol, gridRowSpan, gridColSpan, gaQuantity };
}

/** Claims a zone's rectangle on the shared occupancy grid. Returns false
 * (without fully claiming the rectangle) if any cell is already claimed by
 * an earlier zone in the same payload. */
function claimZoneCells(
  occupied: boolean[][],
  zone: Pick<ZoneFields, 'gridRow' | 'gridCol' | 'gridRowSpan' | 'gridColSpan'>,
): boolean {
  for (let r = zone.gridRow; r < zone.gridRow + zone.gridRowSpan; r += 1) {
    for (let c = zone.gridCol; c < zone.gridCol + zone.gridColSpan; c += 1) {
      if (occupied[r]![c]) return false; // overlaps a zone earlier in the payload
      occupied[r]![c] = true;
    }
  }
  return true;
}

/** Appends a numeric suffix (2, 3, ...) until the code is unique among the
 * zones already seen in this payload. */
function uniqueZoneCode(code: string, seenCodes: ReadonlySet<string>): string {
  let candidate = code;
  let suffix = 2;
  while (seenCodes.has(candidate)) {
    candidate = `${code}${suffix}`.slice(0, 10);
    suffix += 1;
  }
  return candidate;
}

/** Each zone is defined by one rectangle (the organiser's single drag
 * gesture); rectangles may not overlap — every grid cell belongs to at most
 * one zone. Seats (for TIER2_SEATED events) are derived from this rectangle
 * server-side, not supplied by the client. */
function parseZones(raw: unknown, gridDims: GridDims): ParsedZone[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ZONES) return null;
  const zones: ParsedZone[] = [];
  const seenCodes = new Set<string>();
  const occupied: boolean[][] = Array.from({ length: gridDims.gridRows }, () => new Array(gridDims.gridCols).fill(false));

  for (const entry of raw as ZoneInput[]) {
    const fields = parseZoneEntry(entry, gridDims);
    if (!fields) return null;
    if (!claimZoneCells(occupied, fields)) return null;

    const code = uniqueZoneCode(fields.code, seenCodes);
    seenCodes.add(code);
    zones.push({ ...fields, code });
  }
  return zones;
}

/**
 * Live availability for the seat map. This is the endpoint the frontend has
 * always called (`GET /events/{id}/seats`) but nothing implemented — it now
 * lives here, alongside the inventory it reads.
 */
app.get('/events/:eventId/seats', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!(await requireAuthenticated(req, res))) return;
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  // A seat only exists once an organiser has drawn a zone rectangle over its
  // cell, so every row here is already for sale. Grid dimensions are included
  // so this map lines up exactly with the one the organiser drew.
  const gridDims = await fetchGridSettings(eventId);
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT s.seat_id, s.seat_label, s.pos_x, s.pos_y, s.inventory_item_id, ii.name AS section_name, ii.price_cents, ii.color, s.status, s.tag ' +
      'FROM seats s INNER JOIN inventory_items ii ON ii.inventory_item_id = s.inventory_item_id ' +
      'WHERE s.event_id = ? ORDER BY s.pos_y, s.pos_x',
    [eventId],
  );
  res.json({
    gridRows: gridDims.gridRows,
    gridCols: gridDims.gridCols,
    seats: rows.map((seat) => ({
      seatId: seat.seat_id,
      seatLabel: seat.seat_label,
      gridRow: seat.pos_y,
      gridCol: seat.pos_x,
      inventoryItemId: seat.inventory_item_id,
      sectionName: seat.section_name,
      priceCents: seat.price_cents,
      color: seat.color,
      status: seat.status,
      tag: seat.tag,
    })),
  });
});

/** Most seats one request can switch on or off: a whole 100 x 100 map. */
const MAX_SEAT_SWITCH = 10_000;

/**
 * Switches many seats on or off at once, for the organiser's seat selection.
 * Off is BLOCKED (never sold, tagged MAINTENANCE); on is AVAILABLE with no tag.
 * Sold and held seats are left alone, so a sale is never undone.
 */
app.patch('/events/:eventId/seats', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_request' });
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;
  if (event.status === 'CANCELLED') return res.status(409).json({ error: 'event_cancelled' });
  if (event.status === 'PUBLISHED' && Number(event.has_started) === 1) {
    return res.status(409).json({ error: 'event_completed' });
  }

  const body = (req.body ?? {}) as { seatIds?: unknown; available?: unknown };
  const seatIds: unknown[] = Array.isArray(body.seatIds) ? body.seatIds : [];
  if (typeof body.available !== 'boolean' || seatIds.length === 0 || seatIds.length > MAX_SEAT_SWITCH ||
      !seatIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    return res.status(400).json({ error: 'invalid_seat_switch' });
  }
  const [status, tag, from] = body.available ? ['AVAILABLE', 'NONE', 'BLOCKED'] : ['BLOCKED', 'MAINTENANCE', 'AVAILABLE'];
  try {
    const [result] = await database.query<mysql.ResultSetHeader>(
      'UPDATE seats SET status = ?, tag = ? WHERE event_id = ? AND status = ? AND seat_id IN (?)',
      [status, tag, eventId, from, seatIds],
    );
    return res.json({ updated: result.affectedRows });
  } catch (error) {
    console.error('failed to switch seats', error);
    return res.status(502).json({ error: 'seat_switch_failed' });
  }
});

/**
 * Per-seat tagging for the seat map. MAINTENANCE actually blocks the seat
 * from being booked (status -> BLOCKED); ACCESSIBLE is informational only
 * and leaves availability untouched.
 */
app.patch('/events/:eventId/seats/:seatId', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  const seatId = validEventId(req.params.seatId);
  if (!eventId || !seatId) return res.status(400).json({ error: 'invalid_request' });
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;

  const tag = (req.body as { tag?: unknown }).tag;
  if (typeof tag !== 'string' || !SEAT_TAGS.has(tag)) return res.status(400).json({ error: 'invalid_tag' });

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT seat_id, status, tag FROM seats WHERE seat_id = ? AND event_id = ? FOR UPDATE',
      [seatId, eventId],
    );
    const seat = rows[0];
    if (!seat) {
      await connection.rollback();
      res.status(404).json({ error: 'seat_not_found' });
      return;
    }

    const nextTag = tag as SeatTag;
    let nextStatus: 'AVAILABLE' | 'HELD' | 'SOLD' | 'BLOCKED' = seat.status;
    if (nextTag === 'MAINTENANCE') {
      if (seat.status === 'SOLD' || seat.status === 'HELD') {
        await connection.rollback();
        res.status(409).json({ error: 'seat_not_available' });
        return;
      }
      nextStatus = 'BLOCKED';
    } else if (seat.status === 'BLOCKED') {
      nextStatus = 'AVAILABLE';
    }

    await connection.execute('UPDATE seats SET tag = ?, status = ? WHERE seat_id = ?', [nextTag, nextStatus, seatId]);
    await connection.commit();
    res.json({ seatId, tag: nextTag, status: nextStatus });
  } catch (error) {
    await connection.rollback();
    console.error('failed to update seat tag', error);
    res.status(502).json({ error: 'seat_tag_update_failed' });
  } finally {
    connection.release();
  }
});

app.get('/events/:eventId/inventory', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;

  const gridDims = await fetchGridSettings(eventId);

  const [allItemRows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT ii.inventory_item_id, ii.name, ii.section_code, ii.price_cents, ii.color, ' +
      'ii.grid_row, ii.grid_col, ii.grid_row_span, ii.grid_col_span, ii.total_qty, ii.sold_qty, ii.reserved_qty, ' +
      "COUNT(s.seat_id) AS seat_count, COALESCE(SUM(s.status = 'SOLD'), 0) AS sold_count, COALESCE(SUM(s.status = 'HELD'), 0) AS held_count " +
      'FROM inventory_items ii LEFT JOIN seats s ON s.inventory_item_id = ii.inventory_item_id ' +
      'WHERE ii.event_id = ? GROUP BY ii.inventory_item_id ORDER BY ii.inventory_item_id',
    [eventId],
  );
  const zoneRows = allItemRows.filter((r) => r.name !== STAGE_SENTINEL);
  const stagePieceRows = allItemRows.filter((r) => r.name === STAGE_SENTINEL);

  const [seatRows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT seat_id, pos_x, pos_y, seat_label, inventory_item_id, status, tag FROM seats WHERE event_id = ? ORDER BY seat_id',
    [eventId],
  );

  res.json({
    gridRows: gridDims.gridRows,
    gridCols: gridDims.gridCols,
    zones: zoneRows.map((zone) => ({
      inventoryItemId: zone.inventory_item_id,
      name: zone.name,
      code: zone.section_code,
      priceCents: zone.price_cents,
      color: zone.color,
      gridRow: zone.grid_row,
      gridCol: zone.grid_col,
      gridRowSpan: zone.grid_row_span,
      gridColSpan: zone.grid_col_span,
      // TIER2_SEATED: derived from actual seat rows. TIER1_GA: no seat rows
      // exist at all, so seatCount/soldCount/heldCount fall back to the
      // zone's own stored counters instead of aggregating an empty table.
      seatCount: event.tier === 'TIER1_GA' ? zone.total_qty : zone.seat_count,
      soldCount: event.tier === 'TIER1_GA' ? zone.sold_qty : zone.sold_count,
      heldCount: event.tier === 'TIER1_GA' ? zone.reserved_qty : zone.held_count,
    })),
    stagePieces: stagePieceRows.map((p) => ({
      gridRow: p.grid_row,
      gridCol: p.grid_col,
      gridRowSpan: p.grid_row_span,
      gridColSpan: p.grid_col_span,
    })),
    seats: seatRows.map((seat) => ({
      seatId: seat.seat_id,
      gridRow: seat.pos_y,
      gridCol: seat.pos_x,
      seatLabel: seat.seat_label,
      inventoryItemId: seat.inventory_item_id,
      status: seat.status,
      tag: seat.tag,
    })),
  });
});

/**
 * Customer-facing ticket tiers: every zone's price/colour, remaining
 * capacity, and grid position, without the organiser-only seat detail
 * `GET .../inventory` exposes. Any authenticated caller may see this —
 * organiser status isn't required to browse what's for sale. The grid
 * fields mirror the organiser endpoint so a GA buyer can see the same
 * zone layout the organiser painted (read-only — GA has no individual
 * seats to pick, unlike TIER2_SEATED).
 */
app.get('/events/:eventId/zones', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  if (!(await requireAuthenticated(req, res))) return;
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });

  const gridDims = await fetchGridSettings(eventId);

  const [allItemRows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT inventory_item_id, name, price_cents, color, total_qty, reserved_qty, sold_qty, ' +
      'grid_row, grid_col, grid_row_span, grid_col_span ' +
      'FROM inventory_items WHERE event_id = ? ORDER BY inventory_item_id',
    [eventId],
  );
  const zoneRows = allItemRows.filter((r) => r.name !== STAGE_SENTINEL);
  const stagePieceRows = allItemRows.filter((r) => r.name === STAGE_SENTINEL);

  res.json({
    gridRows: gridDims.gridRows,
    gridCols: gridDims.gridCols,
    zones: zoneRows.map((zone) => ({
      inventoryItemId: zone.inventory_item_id,
      name: zone.name,
      priceCents: zone.price_cents,
      color: zone.color,
      remaining: zone.total_qty - zone.reserved_qty - zone.sold_qty,
      gridRow: zone.grid_row,
      gridCol: zone.grid_col,
      gridRowSpan: zone.grid_row_span,
      gridColSpan: zone.grid_col_span,
    })),
    stagePieces: stagePieceRows.map((p) => ({
      gridRow: p.grid_row,
      gridCol: p.grid_col,
      gridRowSpan: p.grid_row_span,
      gridColSpan: p.grid_col_span,
    })),
  });
});

app.put('/events/:eventId/inventory', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;
  if (event.status === 'CANCELLED') return res.status(409).json({ error: 'event_cancelled' });
  // A live event may still add or remove capacity and change prices; the
  // checks in putZoneInventory keep every sold or held ticket intact. Once the
  // event has started, the layout is final.
  if (event.status === 'PUBLISHED' && Number(event.has_started) === 1) {
    return res.status(409).json({ error: 'event_completed' });
  }

  const gridDims = parseGridDims(
    req.body as { gridRows?: unknown; gridCols?: unknown },
    await fetchGridSettings(eventId),
    event.tier === 'TIER1_GA' ? MAX_GA_GRID_DIM : MAX_RESERVED_GRID_DIM,
  );
  if (!gridDims) return res.status(400).json({ error: 'invalid_inventory_payload' });

  const zones = parseZones((req.body as { zones?: unknown }).zones, gridDims);
  if (!zones) return res.status(400).json({ error: 'invalid_inventory_payload' });
  if (event.tier === 'TIER2_SEATED' && reservedSeatCount(zones) > MAX_RESERVED_SEATS) {
    return res.status(400).json({ error: 'reserved_seat_limit_exceeded', maxSeats: MAX_RESERVED_SEATS });
  }

  await putZoneInventory(eventId, event.tier, zones, gridDims, res);
});

async function upsertGridSettings(connection: mysql.PoolConnection, eventId: number, gridDims: GridDims): Promise<void> {
  await connection.execute(
    'INSERT INTO event_grid_settings (event_id, grid_rows, grid_cols) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE grid_rows = VALUES(grid_rows), grid_cols = VALUES(grid_cols)',
    [eventId, gridDims.gridRows, gridDims.gridCols],
  );
}

type ZoneInventoryCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** Every zone that references an existing `inventoryItemId` must actually
 * belong to this event (a stale/foreign id would otherwise upsert nothing
 * and silently orphan the payload). */
function checkZoneReferencesExist(
  zones: readonly ParsedZone[],
  existingZoneById: ReadonlyMap<number, mysql.RowDataPacket>,
): ZoneInventoryCheck {
  for (const zone of zones) {
    if (zone.inventoryItemId !== null && !existingZoneById.has(zone.inventoryItemId)) {
      return { ok: false, status: 400, error: 'invalid_inventory_payload' };
    }
  }
  return { ok: true };
}

/** A zone that has ever been referenced by an `inventory_holds` row — active,
 * confirmed, released, or expired — cannot be hard-deleted:
 * `inventory_holds.inventory_item_id` FK-references `inventory_items`, and
 * MySQL blocks the DELETE (ER_ROW_IS_REFERENCED_2) even for holds that were
 * released/expired long ago and no longer show up as a committed seat. Check
 * for this up front and reject with a clear 409 instead of letting the
 * DELETE throw and surface as a 502. */
async function checkNoHoldHistory(
  connection: mysql.PoolConnection,
  droppedZoneIds: readonly number[],
): Promise<ZoneInventoryCheck> {
  if (droppedZoneIds.length === 0) return { ok: true };
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT DISTINCT inventory_item_id FROM inventory_holds WHERE inventory_item_id IN (?)',
    [droppedZoneIds],
  );
  if (rows.length > 0) {
    return { ok: false, status: 409, error: 'zone_has_reservation_history' };
  }
  return { ok: true };
}

/** A zone that already has a committed (SOLD/HELD) seat has its rectangle
 * frozen: it must still appear in the payload at the exact same position and
 * size, though name/price/colour stay editable. */
function checkCommittedZonesUnchanged(
  committedZoneIds: ReadonlySet<number>,
  existingZoneById: ReadonlyMap<number, mysql.RowDataPacket>,
  payloadZoneById: ReadonlyMap<number, ParsedZone>,
): ZoneInventoryCheck {
  for (const zoneId of committedZoneIds) {
    const existing = existingZoneById.get(zoneId)!;
    const payloadZone = payloadZoneById.get(zoneId);
    if (
      !payloadZone ||
      payloadZone.gridRow !== existing.grid_row ||
      payloadZone.gridCol !== existing.grid_col ||
      payloadZone.gridRowSpan !== existing.grid_row_span ||
      payloadZone.gridColSpan !== existing.grid_col_span
    ) {
      return { ok: false, status: 409, error: 'cannot_modify_committed_seat' };
    }
  }
  return { ok: true };
}

/** TIER1_GA only: a zone's capacity (explicit quantity or fallback area) cannot
 * shrink below the tickets already sold or currently held in it. */
function checkGaZonesCoverAllocated(
  tier: EventTier,
  zones: readonly ParsedZone[],
  existingZoneById: ReadonlyMap<number, mysql.RowDataPacket>,
): ZoneInventoryCheck {
  if (tier !== 'TIER1_GA') return { ok: true };
  for (const zone of zones) {
    if (zone.inventoryItemId === null) continue;
    const existing = existingZoneById.get(zone.inventoryItemId)!;
    const allocated = Number(existing.reserved_qty) + Number(existing.sold_qty);
    const capacity = zone.gaQuantity ?? zone.gridRowSpan * zone.gridColSpan;
    if (capacity < allocated) {
      return { ok: false, status: 409, error: 'zone_below_allocated' };
    }
  }
  return { ok: true };
}

/** Upserts each zone's metadata + rectangle, returning the eventual
 * `inventory_item_id` for each zone (same order as `zones`). */
async function upsertZoneRows(
  connection: mysql.PoolConnection,
  eventId: number,
  tier: EventTier,
  zones: readonly ParsedZone[],
): Promise<number[]> {
  const zoneUpsertIds: number[] = [];
  for (const zone of zones) {
    const totalQty = tier === 'TIER1_GA' ? (zone.gaQuantity ?? zone.gridRowSpan * zone.gridColSpan) : 0;
    if (zone.inventoryItemId !== null) {
      await connection.execute(
        'UPDATE inventory_items SET name = ?, section_code = ?, price_cents = ?, color = ?, ' +
          'grid_row = ?, grid_col = ?, grid_row_span = ?, grid_col_span = ?' +
          (tier === 'TIER1_GA' ? ', total_qty = ?' : '') +
          ' WHERE inventory_item_id = ?',
        tier === 'TIER1_GA'
          ? [zone.name, zone.code, zone.priceCents, zone.color, zone.gridRow, zone.gridCol, zone.gridRowSpan, zone.gridColSpan, totalQty, zone.inventoryItemId]
          : [zone.name, zone.code, zone.priceCents, zone.color, zone.gridRow, zone.gridCol, zone.gridRowSpan, zone.gridColSpan, zone.inventoryItemId],
      );
      zoneUpsertIds.push(zone.inventoryItemId);
    } else {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        'INSERT INTO inventory_items (event_id, name, section_code, total_qty, price_cents, color, grid_row, grid_col, grid_row_span, grid_col_span) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [eventId, zone.name, zone.code, totalQty, zone.priceCents, zone.color, zone.gridRow, zone.gridCol, zone.gridRowSpan, zone.gridColSpan],
      );
      zoneUpsertIds.push(result.insertId);
    }
  }
  return zoneUpsertIds;
}

/** Zones dropped from the payload are removed (safe: any zone still holding
 * a committed seat was required by `checkCommittedZonesUnchanged` to remain
 * present, so it can never be "dropped" here). */
async function deleteDroppedZones(
  connection: mysql.PoolConnection,
  existingZoneIds: Iterable<number>,
  keepIds: ReadonlySet<number>,
): Promise<void> {
  for (const existingId of existingZoneIds) {
    if (keepIds.has(existingId)) continue;
    await connection.execute('DELETE FROM seats WHERE inventory_item_id = ?', [existingId]);
    await connection.execute('DELETE FROM inventory_items WHERE inventory_item_id = ?', [existingId]);
  }
}

/** Seats written per INSERT when regenerating a zone (7 values each). */
const SEAT_INSERT_BATCH = 500;

/** TIER2_SEATED only: regenerates the AVAILABLE seats for each zone's
 * rectangle (one per cell); any committed seats already occupy their cells
 * and are left alone. */
async function regenerateSeatedZoneSeats(
  connection: mysql.PoolConnection,
  eventId: number,
  zones: readonly ParsedZone[],
  zoneUpsertIds: readonly number[],
): Promise<void> {
  for (let i = 0; i < zones.length; i += 1) {
    const zone = zones[i]!;
    const zoneId = zoneUpsertIds[i]!;
    await connection.execute("DELETE FROM seats WHERE inventory_item_id = ? AND status = 'AVAILABLE'", [zoneId]);
    const [remainingRows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT pos_x, pos_y FROM seats WHERE inventory_item_id = ?',
      [zoneId],
    );
    const occupied = new Set(remainingRows.map((row) => `${row.pos_y},${row.pos_x}`));
    const seats: (string | number)[][] = [];
    for (let r = zone.gridRow; r < zone.gridRow + zone.gridRowSpan; r += 1) {
      for (let c = zone.gridCol; c < zone.gridCol + zone.gridColSpan; c += 1) {
        if (occupied.has(`${r},${c}`)) continue;
        seats.push([eventId, zoneId, `${rowLabel(r)}${c + 1}`, rowLabel(r), c + 1, c, r]);
      }
    }
    // Many rows per statement: a 100 x 100 map is 10,000 seats, and one round trip
    // each made saving a large map take minutes against a remote database.
    for (let start = 0; start < seats.length; start += SEAT_INSERT_BATCH) {
      await connection.query(
        'INSERT INTO seats (event_id, inventory_item_id, seat_label, row_label, seat_number, pos_x, pos_y) VALUES ?',
        [seats.slice(start, start + SEAT_INSERT_BATCH)],
      );
    }
  }
  await connection.execute(
    'UPDATE inventory_items ii SET total_qty = (SELECT COUNT(*) FROM seats s WHERE s.inventory_item_id = ii.inventory_item_id) WHERE ii.event_id = ?',
    [eventId],
  );
}

/**
 * A zone is a rectangle; the payload is the full desired set of zones. For
 * TIER2_SEATED events, seats are derived here (one per cell) rather than
 * supplied by the client. For TIER1_GA events, no seats are ever created —
 * the rectangle's area becomes the zone's `total_qty` directly.
 *
 * A zone that already has a committed (SOLD/HELD) seat has its rectangle
 * frozen: it must still appear in the payload at the exact same position and
 * size, though name/price/colour stay editable. Zones dropped from the
 * payload are deleted, which is only safe because a zone with committed
 * seats is required above to remain present.
 */
async function putZoneInventory(
  eventId: number,
  tier: EventTier,
  zones: readonly ParsedZone[],
  gridDims: GridDims,
  res: express.Response,
): Promise<void> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();

    const [existingZoneRows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT inventory_item_id, grid_row, grid_col, grid_row_span, grid_col_span, reserved_qty, sold_qty FROM inventory_items WHERE event_id = ? AND name != ? FOR UPDATE',
      [eventId, STAGE_SENTINEL],
    );
    const existingZoneById = new Map(existingZoneRows.map((row) => [row.inventory_item_id as number, row]));

    const referenceCheck = checkZoneReferencesExist(zones, existingZoneById);
    if (!referenceCheck.ok) {
      await connection.rollback();
      res.status(referenceCheck.status).json({ error: referenceCheck.error });
      return;
    }

    const [committedRows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT DISTINCT inventory_item_id FROM seats WHERE event_id = ? AND status <> 'AVAILABLE' FOR UPDATE",
      [eventId],
    );
    const committedZoneIds = new Set(committedRows.map((row) => row.inventory_item_id as number));
    const payloadZoneById = new Map(zones.filter((z) => z.inventoryItemId !== null).map((z) => [z.inventoryItemId as number, z]));

    const committedCheck = checkCommittedZonesUnchanged(committedZoneIds, existingZoneById, payloadZoneById);
    if (!committedCheck.ok) {
      await connection.rollback();
      res.status(committedCheck.status).json({ error: committedCheck.error });
      return;
    }

    const allocatedCheck = checkGaZonesCoverAllocated(tier, zones, existingZoneById);
    if (!allocatedCheck.ok) {
      await connection.rollback();
      res.status(allocatedCheck.status).json({ error: allocatedCheck.error });
      return;
    }

    const droppedZoneIds = [...existingZoneById.keys()].filter((id) => !payloadZoneById.has(id));
    const holdHistoryCheck = await checkNoHoldHistory(connection, droppedZoneIds);
    if (!holdHistoryCheck.ok) {
      await connection.rollback();
      res.status(holdHistoryCheck.status).json({ error: holdHistoryCheck.error });
      return;
    }

    const zoneUpsertIds = await upsertZoneRows(connection, eventId, tier, zones);
    await deleteDroppedZones(connection, existingZoneById.keys(), new Set(zoneUpsertIds));

    if (tier === 'TIER2_SEATED') {
      await regenerateSeatedZoneSeats(connection, eventId, zones, zoneUpsertIds);
    }

    await upsertGridSettings(connection, eventId, gridDims);

    const totalSeats = await computeTotalSeats(connection, eventId, tier);
    const capacityCheck = await checkCapacityAboveAvailableBuyers(connection, eventId, totalSeats);
    if (!capacityCheck.ok) {
      await connection.rollback();
      res.status(409).json({
        error: 'capacity_below_available_buyers',
        availableBuyers: capacityCheck.availableBuyers,
      });
      return;
    }
    await connection.execute('UPDATE events SET total_seats = ? WHERE event_id = ?', [totalSeats, eventId]);
    await connection.commit();
    res.status(204).end();
  } catch (error) {
    await connection.rollback();
    const code = (error as { code?: string }).code;
    if (code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'duplicate_seat_label' });
      return;
    }
    // Defensive fallback for the same FK constraint `checkNoHoldHistory`
    // guards against above — e.g. a hold created concurrently between that
    // check and the DELETE. Still a clear 409, never a raw 502.
    if (code === 'ER_ROW_IS_REFERENCED_2' || code === 'ER_ROW_IS_REFERENCED') {
      res.status(409).json({ error: 'zone_has_reservation_history' });
      return;
    }
    console.error('failed to update zone inventory', error);
    res.status(502).json({ error: 'inventory_update_failed' });
  } finally {
    connection.release();
  }
}

interface StagePieceInput {
  readonly gridRow?: unknown;
  readonly gridCol?: unknown;
  readonly gridRowSpan?: unknown;
  readonly gridColSpan?: unknown;
}

interface ParsedStagePiece {
  readonly gridRow: number;
  readonly gridCol: number;
  readonly gridRowSpan: number;
  readonly gridColSpan: number;
}

function parseStagePieces(raw: unknown, gridDims: GridDims): ParsedStagePiece[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_STAGE_PIECES) return null;
  const pieces: ParsedStagePiece[] = [];
  const occupied: boolean[][] = Array.from({ length: gridDims.gridRows }, () => new Array(gridDims.gridCols).fill(false));

  for (const entry of raw as StagePieceInput[]) {
    const { gridRow, gridCol, gridRowSpan, gridColSpan } = entry;
    if (typeof gridRow !== 'number' || !Number.isInteger(gridRow) || gridRow < 0) return null;
    if (typeof gridCol !== 'number' || !Number.isInteger(gridCol) || gridCol < 0) return null;
    if (typeof gridRowSpan !== 'number' || !Number.isInteger(gridRowSpan) || gridRowSpan < 1) return null;
    if (typeof gridColSpan !== 'number' || !Number.isInteger(gridColSpan) || gridColSpan < 1) return null;
    if (gridRow + gridRowSpan > gridDims.gridRows || gridCol + gridColSpan > gridDims.gridCols) return null;
    if (!claimZoneCells(occupied, { gridRow, gridCol, gridRowSpan, gridColSpan })) return null;
    pieces.push({ gridRow, gridCol, gridRowSpan, gridColSpan });
  }
  return pieces;
}

/**
 * Replaces all stage pieces for an event. Stage pieces are stored as
 * inventory_items rows with name='__STAGE__', price_cents=0, total_qty=0 —
 * a sentinel that lets them coexist with real zones without a schema change.
 * Pieces may not overlap each other or existing priced zones.
 */
app.put('/events/:eventId/stage', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;

  const gridDims = await fetchGridSettings(eventId);
  const pieces = parseStagePieces((req.body as { pieces?: unknown }).pieces, gridDims);
  if (!pieces) return res.status(400).json({ error: 'invalid_stage_payload' });

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();

    const [existingZoneRows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT grid_row, grid_col, grid_row_span, grid_col_span FROM inventory_items WHERE event_id = ? AND name != ? FOR UPDATE',
      [eventId, STAGE_SENTINEL],
    );

    const zoneOccupied: boolean[][] = Array.from({ length: gridDims.gridRows }, () => new Array(gridDims.gridCols).fill(false));
    for (const zone of existingZoneRows) {
      if (zone.grid_row == null) continue;
      for (let r = zone.grid_row; r < zone.grid_row + zone.grid_row_span; r += 1) {
        for (let c = zone.grid_col; c < zone.grid_col + zone.grid_col_span; c += 1) {
          if (r < gridDims.gridRows && c < gridDims.gridCols) zoneOccupied[r]![c] = true;
        }
      }
    }

    for (const piece of pieces) {
      for (let r = piece.gridRow; r < piece.gridRow + piece.gridRowSpan; r += 1) {
        for (let c = piece.gridCol; c < piece.gridCol + piece.gridColSpan; c += 1) {
          if (zoneOccupied[r]?.[c]) {
            await connection.rollback();
            res.status(409).json({ error: 'stage_overlaps_zone' });
            return;
          }
        }
      }
    }

    await connection.execute('DELETE FROM inventory_items WHERE event_id = ? AND name = ?', [eventId, STAGE_SENTINEL]);
    for (const piece of pieces) {
      await connection.execute(
        'INSERT INTO inventory_items (event_id, name, section_code, total_qty, price_cents, color, grid_row, grid_col, grid_row_span, grid_col_span) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?)',
        [eventId, STAGE_SENTINEL, 'STGE', '#374151', piece.gridRow, piece.gridCol, piece.gridRowSpan, piece.gridColSpan],
      );
    }

    await connection.commit();
    res.status(204).end();
  } catch (error) {
    await connection.rollback();
    console.error('failed to update stage pieces', error);
    res.status(502).json({ error: 'stage_update_failed' });
  } finally {
    connection.release();
  }
});

interface HoldInput {
  readonly inventoryItemId?: unknown;
  readonly quantity?: unknown;
  readonly seatIds?: unknown;
}

type HoldRequest =
  | { readonly ok: true; readonly inventoryItemId: number; readonly quantity: number; readonly seatIds: number[] | null }
  | { readonly ok: false };

/** Validates and normalises a hold request body. TIER2_SEATED holds name the
 * exact seats wanted (so the same seat can't be handed to two customers);
 * TIER1_GA holds are a plain capacity count since there are no individual
 * seat rows to name. */
function parseHoldRequest(body: HoldInput, tier: EventTier): HoldRequest {
  const inventoryItemId = typeof body.inventoryItemId === 'number' && Number.isSafeInteger(body.inventoryItemId)
    ? body.inventoryItemId
    : null;
  if (!inventoryItemId) return { ok: false };

  let quantity: number;
  let seatIds: number[] | null = null;
  if (tier === 'TIER2_SEATED') {
    const rawSeatIds = body.seatIds;
    const isValidSeatIdList = Array.isArray(rawSeatIds) &&
      rawSeatIds.length > 0 &&
      rawSeatIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id));
    if (!isValidSeatIdList) return { ok: false };
    seatIds = [...new Set(rawSeatIds as number[])];
    if (seatIds.length !== (rawSeatIds as number[]).length) return { ok: false };
    quantity = seatIds.length;
  } else {
    quantity = typeof body.quantity === 'number' ? body.quantity : Number.NaN;
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_HOLD_QTY) return { ok: false };

  return { ok: true, inventoryItemId, quantity, seatIds };
}

/**
 * A hold reserves inventory ahead of payment (see CONTEXT.md "oversell
 * prevention"). `inventory_items.total_qty` is the organiser-saved capacity
 * (set by `PUT /events/:eventId/inventory`, the single source of truth); this
 * endpoint is the one place `reserved_qty`/`sold_qty` are checked against it
 * on every reservation attempt, under a row lock, so two concurrent holds
 * can never together exceed `total_qty` — the DB's own
 * `chk_inventory_counts` CHECK constraint is a second, DB-level backstop if
 * application logic ever has a bug.
 */
app.post('/events/:eventId/holds', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (event.status !== 'PUBLISHED') return res.status(409).json({ error: 'event_not_on_sale' });

  const holdRequest = parseHoldRequest(req.body as HoldInput, event.tier);
  if (!holdRequest.ok) return res.status(400).json({ error: 'invalid_hold_payload' });

  await createHold(eventId, holdRequest.inventoryItemId, holdRequest.quantity, caller.sub, holdRequest.seatIds, res);
});

/**
 * Releases any hold whose TTL has passed before this reservation attempt is
 * evaluated, so a customer who abandons checkout doesn't keep inventory
 * reserved forever (see `HOLD_TTL_SECONDS`). Runs inside the same
 * transaction/row-lock as the reservation check that follows it.
 */
async function expireStaleHolds(connection: mysql.PoolConnection, eventId: number): Promise<void> {
  const [staleRows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT hold_id, inventory_item_id, quantity FROM inventory_holds WHERE event_id = ? AND status = 'ACTIVE' AND expires_at <= NOW() FOR UPDATE",
    [eventId],
  );
  for (const stale of staleRows) {
    await connection.execute(
      'UPDATE inventory_items SET reserved_qty = reserved_qty - ? WHERE inventory_item_id = ?',
      [stale.quantity, stale.inventory_item_id],
    );
    await connection.execute("UPDATE seats SET status = 'AVAILABLE', hold_id = NULL WHERE hold_id = ?", [stale.hold_id]);
    await connection.execute("UPDATE inventory_holds SET status = 'EXPIRED' WHERE hold_id = ?", [stale.hold_id]);
  }
}

type HoldAttemptOutcome =
  | { readonly kind: 'created'; readonly holdId: number; readonly expiresAt: Date; readonly seatIds: number[] | null }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'insufficient'; readonly available: number }
  | { readonly kind: 'seat_not_available' }
  // InnoDB deadlocks (1213) and lock-wait timeouts (1205) are expected,
  // transient outcomes of many customers racing for the same row under
  // `FOR UPDATE` — MySQL's own guidance is that the client should simply
  // retry the transaction, not surface it as a hard failure to the customer.
  | { readonly kind: 'retry' }
  | { readonly kind: 'error' };

const ER_LOCK_DEADLOCK = 1213;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_CHECK_CONSTRAINT_VIOLATED = 3819;

async function attemptCreateHold(
  eventId: number,
  inventoryItemId: number,
  quantity: number,
  customerSub: string,
  seatIds: readonly number[] | null,
): Promise<HoldAttemptOutcome> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    await expireStaleHolds(connection, eventId);

    const [itemRows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT inventory_item_id, total_qty, reserved_qty, sold_qty FROM inventory_items WHERE inventory_item_id = ? AND event_id = ? FOR UPDATE',
      [inventoryItemId, eventId],
    );
    const item = itemRows[0];
    if (!item) {
      await connection.rollback();
      return { kind: 'not_found' };
    }

    const available = (item.total_qty as number) - (item.reserved_qty as number) - (item.sold_qty as number);
    if (quantity > available) {
      await connection.rollback();
      return { kind: 'insufficient', available };
    }

    // TIER2_SEATED: the specific seats requested must themselves still be
    // AVAILABLE — `reserved_qty <= total_qty` alone isn't enough, since two
    // customers could each be under the numeric cap while both wanting the
    // exact same seat. Locking every named seat row here (in a fixed order —
    // ascending seat_id, since `IN (...)` doesn't guarantee scan order) keeps
    // concurrent requests for overlapping seat sets from deadlocking each
    // other and makes the whole seat set claimed atomically or not at all.
    let lockedSeatIds: number[] | null = null;
    if (seatIds) {
      const placeholders = seatIds.map(() => '?').join(',');
      const [seatRows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT seat_id, status FROM seats WHERE seat_id IN (${placeholders}) AND inventory_item_id = ? AND event_id = ? ORDER BY seat_id FOR UPDATE`,
        [...seatIds, inventoryItemId, eventId],
      );
      const allFound = seatRows.length === seatIds.length;
      const allAvailable = seatRows.every((row) => row.status === 'AVAILABLE');
      if (!allFound || !allAvailable) {
        await connection.rollback();
        return { kind: 'seat_not_available' };
      }
      lockedSeatIds = seatRows.map((row) => row.seat_id as number);
    }

    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000);
    const [holdResult] = await connection.execute<mysql.ResultSetHeader>(
      "INSERT INTO inventory_holds (event_id, inventory_item_id, customer_sub, quantity, status, expires_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)",
      [eventId, inventoryItemId, customerSub, quantity, expiresAt],
    );
    const holdId = holdResult.insertId;
    await connection.execute('UPDATE inventory_items SET reserved_qty = reserved_qty + ? WHERE inventory_item_id = ?', [quantity, inventoryItemId]);

    if (lockedSeatIds) {
      const placeholders = lockedSeatIds.map(() => '?').join(',');
      await connection.execute(`UPDATE seats SET status = 'HELD', hold_id = ? WHERE seat_id IN (${placeholders})`, [holdId, ...lockedSeatIds]);
    }

    await connection.commit();
    return { kind: 'created', holdId, expiresAt, seatIds: lockedSeatIds };
  } catch (error) {
    await connection.rollback();
    const errno = (error as { errno?: number }).errno;
    if (errno === ER_LOCK_DEADLOCK || errno === ER_LOCK_WAIT_TIMEOUT) return { kind: 'retry' };
    if (errno === ER_CHECK_CONSTRAINT_VIOLATED) return { kind: 'insufficient', available: 0 };
    console.error('failed to create hold', error);
    return { kind: 'error' };
  } finally {
    connection.release();
  }
}

// How many times to silently retry a hold attempt that failed only because
// of transient lock contention (not because inventory was actually
// insufficient) before giving up and telling the customer to try again.
const MAX_HOLD_LOCK_RETRIES = 5;

async function createHold(
  eventId: number,
  inventoryItemId: number,
  quantity: number,
  customerSub: string,
  seatIds: readonly number[] | null,
  res: express.Response,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_HOLD_LOCK_RETRIES; attempt += 1) {
    const outcome = await attemptCreateHold(eventId, inventoryItemId, quantity, customerSub, seatIds);
    switch (outcome.kind) {
      case 'created':
        res.status(201).json({
          holdId: outcome.holdId,
          eventId,
          inventoryItemId,
          quantity,
          status: 'ACTIVE',
          expiresAt: outcome.expiresAt.toISOString(),
          ...(outcome.seatIds ? { seatIds: outcome.seatIds } : {}),
        });
        return;
      case 'not_found':
        res.status(404).json({ error: 'inventory_item_not_found' });
        return;
      case 'insufficient':
        res.status(409).json({ error: 'insufficient_inventory', available: outcome.available });
        return;
      case 'seat_not_available':
        res.status(409).json({ error: 'seat_not_available' });
        return;
      case 'error':
        res.status(502).json({ error: 'hold_creation_failed' });
        return;
      case 'retry':
        continue;
    }
  }
  // Contention was so high every retry hit a deadlock/lock-wait-timeout — not
  // an oversell (nothing was committed), just a busy moment. 409 tells the
  // customer this hold didn't happen and it's safe/expected to try again.
  res.status(409).json({ error: 'hold_contention_exceeded' });
}

/**
 * Shared transition for the two ways a hold's life ends: the customer backs
 * out (RELEASED) or checkout succeeds (CONFIRMED). Only the customer who
 * placed the hold may transition it — checkout calls this with the same
 * customer's bearer token it used to create the hold, not a service token.
 * Ported from origin/main's `finishHold`; the underlying columns
 * (`inventory_holds.status`, `inventory_items.reserved_qty`/`sold_qty`,
 * `seats.status`/`hold_id`) are identical between both branches' schemas.
 */
async function finishHold(req: express.Request, res: express.Response, status: 'RELEASED' | 'CONFIRMED'): Promise<void> {
  if (!databaseConfigured) {
    res.status(503).json({ error: 'database_not_configured' });
    return;
  }
  const holdId = positiveId(req.params.holdId);
  if (!holdId) {
    res.status(400).json({ error: 'invalid_hold' });
    return;
  }
  const caller = await requireAuthenticated(req, res);
  if (!caller) return;

  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const [holds] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT hold_id, inventory_item_id, quantity, status FROM inventory_holds WHERE hold_id = ? AND customer_sub = ? FOR UPDATE',
      [holdId, caller.sub],
    );
    const hold = holds[0];
    if (!hold) {
      await connection.rollback();
      res.status(404).json({ error: 'hold_not_found' });
      return;
    }
    if (hold.status !== 'ACTIVE') {
      await connection.rollback();
      res.status(409).json({ error: 'hold_not_active' });
      return;
    }

    await connection.execute('UPDATE inventory_holds SET status = ? WHERE hold_id = ?', [status, holdId]);
    await connection.execute(
      'UPDATE inventory_items SET reserved_qty = reserved_qty - ?, sold_qty = sold_qty + ? WHERE inventory_item_id = ?',
      [hold.quantity, status === 'CONFIRMED' ? hold.quantity : 0, hold.inventory_item_id],
    );
    await connection.execute(
      "UPDATE seats SET status = ?, hold_id = NULL WHERE hold_id = ?",
      [status === 'CONFIRMED' ? 'SOLD' : 'AVAILABLE', holdId],
    );
    await connection.commit();
    res.json({ holdId, status });
  } catch (error) {
    await connection.rollback();
    console.error('inventory hold transition failed', error);
    res.status(502).json({ error: 'hold_transition_failed' });
  } finally {
    connection.release();
  }
}

app.post('/holds/:holdId/release', (req, res) => {
  void finishHold(req, res, 'RELEASED');
});

app.post('/holds/:holdId/confirm', (req, res) => {
  void finishHold(req, res, 'CONFIRMED');
});

async function computeTotalSeats(connection: mysql.PoolConnection, eventId: number, tier: EventTier): Promise<number> {
  const query = tier === 'TIER1_GA'
    ? 'SELECT COALESCE(SUM(total_qty), 0) AS total FROM inventory_items WHERE event_id = ?'
    : 'SELECT COUNT(*) AS total FROM seats WHERE event_id = ?';
  const [rows] = await connection.query<mysql.RowDataPacket[]>(query, [eventId]);
  return Math.max(rows[0]!['total'] as number, 1);
}

type CapacityCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly availableBuyers: number };

/** `chk_events_available_buyers` (see database/10-add-event-available-buyers.sql)
 * blocks `total_seats` from dropping below `available_buyers` at the DB
 * layer, but a raw constraint violation surfaces as an opaque 502. Checking
 * it here first lets the organiser see exactly why the shrink was rejected. */
async function checkCapacityAboveAvailableBuyers(
  connection: mysql.PoolConnection,
  eventId: number,
  totalSeats: number,
): Promise<CapacityCheck> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT available_buyers FROM events WHERE event_id = ?',
    [eventId],
  );
  const availableBuyers = rows[0]?.available_buyers as number | null;
  if (availableBuyers !== null && availableBuyers !== undefined && totalSeats < availableBuyers) {
    return { ok: false, availableBuyers };
  }
  return { ok: true };
}

// Guarded so importing this module from tests (NODE_ENV=test) doesn't also
// bind the real port — tests start their own ephemeral listener via `app`.
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
  });
}

export { app, database };
