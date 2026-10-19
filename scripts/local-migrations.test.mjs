import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { localMigrations, skippedMigrations } from './local-migrations.mjs';

// Backend CI builds its database with scripts/initialize-test-db.mjs, but local
// Docker and the frontend's full-stack e2e tests build it from the compose init
// mounts. A migration added to only one of them breaks the other silently.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFiles = ['infrastructure/docker-compose.yml', 'infrastructure/docker-compose.override.yml'];
const initMount = /^\s*-\s*\.\.\/database\/(\S+\.sql):\/docker-entrypoint-initdb\.d\/(\S+\.sql)(?::ro)?\s*$/;

async function composeInitMigrations() {
  const mounts = [];
  for (const file of composeFiles) {
    const content = await readFile(path.join(repositoryRoot, file), 'utf8');
    for (const line of content.split('\n')) {
      const match = initMount.exec(line);
      if (match) mounts.push({ source: match[1], target: match[2] });
    }
  }
  // The MySQL image runs init scripts in the sorted order of their target names.
  return mounts.sort((a, b) => (a.target < b.target ? -1 : 1)).map(mount => mount.source);
}

describe('local database migrations', () => {
  it('lists every database/*.sql file as applied or deliberately skipped', async () => {
    const files = (await readdir(path.join(repositoryRoot, 'database'))).filter(name => name.endsWith('.sql'));
    const unlisted = files.filter(name => !localMigrations.includes(name) && !(name in skippedMigrations));
    assert.deepEqual(unlisted, [], 'Add new migrations to scripts/local-migrations.mjs (or skippedMigrations with a reason).');
    const missing = [...localMigrations, ...Object.keys(skippedMigrations)].filter(name => !files.includes(name));
    assert.deepEqual(missing, [], 'scripts/local-migrations.mjs names files that are not in database/.');
  });

  it('mounts the same migrations, in the same order, into the compose MySQL container', async () => {
    assert.deepEqual(
      await composeInitMigrations(),
      localMigrations,
      'Mount each migration in infrastructure/docker-compose.override.yml under /docker-entrypoint-initdb.d, ' +
        'with a target name that sorts into the same position as in scripts/local-migrations.mjs.',
    );
  });
});
