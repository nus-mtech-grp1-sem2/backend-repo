/**
 * Loads real JPEG bytes into `onestagedb.event_images` for the events
 * `infrastructure/sql/04-seed-sample-data.sql` creates.
 *
 * Image bytes don't belong in a plain .sql file (a few hundred KB of hex text
 * per image), so this is a small script instead — run with:
 *
 *   npx tsx local-mysql/seed-images.mts
 *
 * Connects to the local Docker MySQL on the host-exposed port (3307), so it
 * needs no container access. Source images are read from `core-frontend`,
 * assumed to be a sibling checkout of this repo
 * (`.../nus-mtech-project-sem2/{backend-repo,core-frontend}`); override
 * `IMAGES_DIR` if your layout differs.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = process.env.IMAGES_DIR ?? path.resolve(__dirname, '../../core-frontend/public/images');

/** event_id -> source file, matching the events seeded by 04-seed-sample-data.sql. */
const EVENT_IMAGES: Record<number, string> = {
  1: 'hero-concert.jpg',
  2: 'hero-theatre.jpg',
  3: 'hero-stadium.jpg',
};

async function main(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3307),
    user: process.env.DB_USER ?? 'onestage',
    password: process.env.DB_PASSWORD ?? 'onestage123',
    database: 'onestagedb',
  });

  try {
    for (const [eventId, filename] of Object.entries(EVENT_IMAGES)) {
      const filePath = path.join(IMAGES_DIR, filename);
      const data = readFileSync(filePath);
      await connection.execute(
        'INSERT INTO event_images (event_id, mime_type, image_data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), image_data = VALUES(image_data)',
        [Number(eventId), 'image/jpeg', data],
      );
      console.log(`seeded image for event ${eventId} (${filename}, ${data.length} bytes)`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error('seed-images failed:', error);
  process.exitCode = 1;
});
