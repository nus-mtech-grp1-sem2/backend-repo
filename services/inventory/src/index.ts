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
  connectionLimit: 4,
  ...(process.env.DB_SSL === 'false'
    ? {}
    : { ssl: { rejectUnauthorized: false } }),
});

// A single PUT can define at most this many priced zones; seat count is
// naturally bounded by the grid dimensions below (one seat per cell).
const MAX_ZONES = 50;

// Virtual venue-map grid the organiser paints seats onto directly. Size is
// customizable per event (stored in event_grid_settings) between these
// bounds; must stay in sync with the same constants in event-inventory.ts.
const DEFAULT_GRID_ROWS = 6;
const DEFAULT_GRID_COLS = 8;
const MIN_GRID_DIM = 1;
const MAX_GRID_DIM = 20;

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
}

/** A zone is a rectangular block of grid cells (one drag gesture creates it).
 * TIER2_SEATED events get one auto-labelled seat per cell in the rectangle;
 * TIER1_GA events treat the rectangle's area as a plain capacity number and
 * never create seat rows at all — see `putZoneInventory`. */
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
}

interface GridDims {
  readonly gridRows: number;
  readonly gridCols: number;
}

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Zone colour is mandatory (it's how seats get "painted"), unlike the old
 * optional zone-rectangle colour. */
function parseRequiredColor(raw: unknown): string | null {
  if (typeof raw !== 'string' || !HEX_COLOR_PATTERN.test(raw)) return null;
  return raw.toUpperCase();
}

function parseGridDims(raw: { gridRows?: unknown; gridCols?: unknown }, fallback: GridDims): GridDims | null {
  const gridRows = raw.gridRows === undefined ? fallback.gridRows : raw.gridRows;
  const gridCols = raw.gridCols === undefined ? fallback.gridCols : raw.gridCols;
  if (typeof gridRows !== 'number' || !Number.isInteger(gridRows) || gridRows < MIN_GRID_DIM || gridRows > MAX_GRID_DIM) return null;
  if (typeof gridCols !== 'number' || !Number.isInteger(gridCols) || gridCols < MIN_GRID_DIM || gridCols > MAX_GRID_DIM) return null;
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

function parsePriceCents(price: unknown): number | null {
  const amount = typeof price === 'number' ? price : typeof price === 'string' ? Number(price) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 0.000001 ? cents : null;
}

async function fetchEvent(eventId: number): Promise<EventRow | null> {
  const [rows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT event_id, status, tier FROM events WHERE event_id = ? LIMIT 1',
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
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** Zone codes are always derived from the name (organisers no longer pick
 * one) so the seat-map builder has one less field to fill in. */
function deriveCode(name: string): string | null {
  const code = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  return code.length >= 2 ? code : code.length > 0 ? code.padEnd(2, 'X') : null;
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
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const priceCents = parsePriceCents(entry.price);
    const code = name ? deriveCode(name) : null;
    const inventoryItemId = typeof entry.inventoryItemId === 'number' && Number.isSafeInteger(entry.inventoryItemId)
      ? entry.inventoryItemId
      : null;
    const color = parseRequiredColor(entry.color);
    const { gridRow, gridCol, gridRowSpan, gridColSpan } = entry;
    if (
      !name || name.length > 255 || !code || priceCents === null || !color ||
      typeof gridRow !== 'number' || !Number.isInteger(gridRow) || gridRow < 0 ||
      typeof gridCol !== 'number' || !Number.isInteger(gridCol) || gridCol < 0 ||
      typeof gridRowSpan !== 'number' || !Number.isInteger(gridRowSpan) || gridRowSpan < 1 ||
      typeof gridColSpan !== 'number' || !Number.isInteger(gridColSpan) || gridColSpan < 1 ||
      gridRow + gridRowSpan > gridDims.gridRows ||
      gridCol + gridColSpan > gridDims.gridCols
    ) {
      return null;
    }

    for (let r = gridRow; r < gridRow + gridRowSpan; r += 1) {
      for (let c = gridCol; c < gridCol + gridColSpan; c += 1) {
        if (occupied[r]![c]) return null; // overlaps a zone earlier in the payload
        occupied[r]![c] = true;
      }
    }

    let uniqueCode = code;
    for (let suffix = 2; seenCodes.has(uniqueCode); suffix += 1) {
      uniqueCode = `${code}${suffix}`.slice(0, 10);
    }
    seenCodes.add(uniqueCode);
    zones.push({ inventoryItemId, name, code: uniqueCode, priceCents, color, gridRow, gridCol, gridRowSpan, gridColSpan });
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

  const [zoneRows] = await database.query<mysql.RowDataPacket[]>(
    'SELECT ii.inventory_item_id, ii.name, ii.section_code, ii.price_cents, ii.color, ' +
      'ii.grid_row, ii.grid_col, ii.grid_row_span, ii.grid_col_span, ii.total_qty, ' +
      "COUNT(s.seat_id) AS seat_count, COALESCE(SUM(s.status = 'SOLD'), 0) AS sold_count, COALESCE(SUM(s.status = 'HELD'), 0) AS held_count " +
      'FROM inventory_items ii LEFT JOIN seats s ON s.inventory_item_id = ii.inventory_item_id ' +
      'WHERE ii.event_id = ? GROUP BY ii.inventory_item_id ORDER BY ii.inventory_item_id',
    [eventId],
  );
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
      // exist at all, so seatCount falls back to the zone's stored capacity.
      seatCount: event.tier === 'TIER1_GA' ? zone.total_qty : zone.seat_count,
      soldCount: zone.sold_count,
      heldCount: zone.held_count,
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

app.put('/events/:eventId/inventory', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'database_not_configured' });
  const eventId = validEventId(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: 'invalid_event' });
  const event = await fetchEvent(eventId);
  if (!event) return res.status(404).json({ error: 'event_not_found' });
  if (!(await requireEventOrganiser(req, res, eventId))) return;
  if (event.status === 'CANCELLED') return res.status(409).json({ error: 'event_cancelled' });

  const gridDims = parseGridDims(req.body as { gridRows?: unknown; gridCols?: unknown }, await fetchGridSettings(eventId));
  if (!gridDims) return res.status(400).json({ error: 'invalid_inventory_payload' });

  const zones = parseZones((req.body as { zones?: unknown }).zones, gridDims);
  if (!zones) return res.status(400).json({ error: 'invalid_inventory_payload' });

  await putZoneInventory(eventId, event.tier, zones, gridDims, res);
});

async function upsertGridSettings(connection: mysql.PoolConnection, eventId: number, gridDims: GridDims): Promise<void> {
  await connection.execute(
    'INSERT INTO event_grid_settings (event_id, grid_rows, grid_cols) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE grid_rows = VALUES(grid_rows), grid_cols = VALUES(grid_cols)',
    [eventId, gridDims.gridRows, gridDims.gridCols],
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
      'SELECT inventory_item_id, grid_row, grid_col, grid_row_span, grid_col_span FROM inventory_items WHERE event_id = ? FOR UPDATE',
      [eventId],
    );
    const existingZoneById = new Map(existingZoneRows.map((row) => [row.inventory_item_id as number, row]));
    for (const zone of zones) {
      if (zone.inventoryItemId !== null && !existingZoneById.has(zone.inventoryItemId)) {
        await connection.rollback();
        res.status(400).json({ error: 'invalid_inventory_payload' });
        return;
      }
    }

    const [committedRows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT DISTINCT inventory_item_id FROM seats WHERE event_id = ? AND status <> 'AVAILABLE' FOR UPDATE",
      [eventId],
    );
    const committedZoneIds = new Set(committedRows.map((row) => row.inventory_item_id as number));
    const payloadZoneById = new Map(zones.filter((z) => z.inventoryItemId !== null).map((z) => [z.inventoryItemId as number, z]));
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
        await connection.rollback();
        res.status(409).json({ error: 'cannot_modify_committed_seat' });
        return;
      }
    }

    // Upsert zone metadata + rectangle; remember each zone's eventual id.
    const zoneUpsertIds: number[] = [];
    for (const zone of zones) {
      const totalQty = tier === 'TIER1_GA' ? zone.gridRowSpan * zone.gridColSpan : 0;
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

    // Zones dropped from the payload are removed (safe: any zone still
    // holding a committed seat was required above to appear in the payload).
    const payloadZoneIds = new Set(zoneUpsertIds);
    for (const existingId of existingZoneById.keys()) {
      if (payloadZoneIds.has(existingId)) continue;
      await connection.execute('DELETE FROM seats WHERE inventory_item_id = ?', [existingId]);
      await connection.execute('DELETE FROM inventory_items WHERE inventory_item_id = ?', [existingId]);
    }

    if (tier === 'TIER2_SEATED') {
      for (let i = 0; i < zones.length; i += 1) {
        const zone = zones[i]!;
        const zoneId = zoneUpsertIds[i]!;
        // Regenerate the AVAILABLE seats for this zone's rectangle; any
        // committed seats already occupy their cells and are left alone.
        await connection.execute("DELETE FROM seats WHERE inventory_item_id = ? AND status = 'AVAILABLE'", [zoneId]);
        const [remainingRows] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT pos_x, pos_y FROM seats WHERE inventory_item_id = ?',
          [zoneId],
        );
        const occupied = new Set(remainingRows.map((row) => `${row.pos_y},${row.pos_x}`));
        for (let r = zone.gridRow; r < zone.gridRow + zone.gridRowSpan; r += 1) {
          for (let c = zone.gridCol; c < zone.gridCol + zone.gridColSpan; c += 1) {
            if (occupied.has(`${r},${c}`)) continue;
            const seatLabel = `${rowLabel(r)}${c + 1}`;
            await connection.execute(
              'INSERT INTO seats (event_id, inventory_item_id, seat_label, row_label, seat_number, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [eventId, zoneId, seatLabel, rowLabel(r), c + 1, c, r],
            );
          }
        }
      }
      await connection.execute(
        'UPDATE inventory_items ii SET total_qty = (SELECT COUNT(*) FROM seats s WHERE s.inventory_item_id = ii.inventory_item_id) WHERE ii.event_id = ?',
        [eventId],
      );
    }

    await upsertGridSettings(connection, eventId, gridDims);
    await syncEventTotalSeats(connection, eventId, tier);
    await connection.commit();
    res.status(204).end();
  } catch (error) {
    await connection.rollback();
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'duplicate_seat_label' });
      return;
    }
    console.error('failed to update zone inventory', error);
    res.status(502).json({ error: 'inventory_update_failed' });
  } finally {
    connection.release();
  }
}

interface HoldInput {
  readonly inventoryItemId?: unknown;
  readonly quantity?: unknown;
  readonly seatIds?: unknown;
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

  const body = req.body as HoldInput;
  const inventoryItemId = typeof body.inventoryItemId === 'number' && Number.isSafeInteger(body.inventoryItemId)
    ? body.inventoryItemId
    : null;
  if (!inventoryItemId) return res.status(400).json({ error: 'invalid_hold_payload' });

  // TIER2_SEATED holds name the exact seats wanted (so the same seat can't be
  // handed to two customers); TIER1_GA holds are a plain capacity count since
  // there are no individual seat rows to name.
  let quantity: number;
  let seatIds: number[] | null = null;
  if (event.tier === 'TIER2_SEATED') {
    const rawSeatIds = body.seatIds;
    const isValidSeatIdList = Array.isArray(rawSeatIds) &&
      rawSeatIds.length > 0 &&
      rawSeatIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id));
    if (!isValidSeatIdList) return res.status(400).json({ error: 'invalid_hold_payload' });
    seatIds = [...new Set(rawSeatIds as number[])];
    if (seatIds.length !== (rawSeatIds as number[]).length) return res.status(400).json({ error: 'invalid_hold_payload' });
    quantity = seatIds.length;
  } else {
    quantity = typeof body.quantity === 'number' ? body.quantity : Number.NaN;
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_HOLD_QTY) {
    return res.status(400).json({ error: 'invalid_hold_payload' });
  }

  await createHold(eventId, inventoryItemId, quantity, caller.sub, seatIds, res);
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

async function syncEventTotalSeats(connection: mysql.PoolConnection, eventId: number, tier: EventTier): Promise<void> {
  const query = tier === 'TIER1_GA'
    ? 'SELECT COALESCE(SUM(total_qty), 0) AS total FROM inventory_items WHERE event_id = ?'
    : 'SELECT COUNT(*) AS total FROM seats WHERE event_id = ?';
  const [rows] = await connection.query<mysql.RowDataPacket[]>(query, [eventId]);
  const total = rows[0]!['total'] as number;
  await connection.execute('UPDATE events SET total_seats = ? WHERE event_id = ?', [Math.max(total, 1), eventId]);
}

// Guarded so importing this module from tests (NODE_ENV=test) doesn't also
// bind the real port — tests start their own ephemeral listener via `app`.
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`${SERVICE}-service -> http://${HOST}:${PORT}`);
  });
}

export { app, database };
