import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Removing a team member revokes their row (invite_status 'REVOKED') rather
// than deleting it. That only takes their access away if every service's
// membership check requires 'ACCEPTED', so this reads the SQL in each
// service's source and holds every statement on event_team_memberships to it.

const servicesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Statement {
  readonly file: string;
  readonly sql: string;
}

/** Every SQL string in a service's src/index.ts that names event_team_memberships. */
function membershipStatements(): Statement[] {
  const statements: Statement[] = [];
  for (const service of readdirSync(servicesDirectory)) {
    const file = path.join(servicesDirectory, service, 'src', 'index.ts');
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/event_team_memberships/g)) {
      const at = match.index;
      const lineStart = source.lastIndexOf('\n', at) + 1;
      const line = source.slice(lineStart, at).trim();
      // Skip comments, and table names listed as data (the event delete loop).
      if (line.startsWith('*') || line.startsWith('//') || source[at - 1] === "'") continue;
      const start = Math.max(source.lastIndexOf('"', at), source.lastIndexOf('`', at));
      const end = source.slice(at).search(/["`]\s*,\s*\[/);
      const sql = source.slice(start + 1, end === -1 ? undefined : at + end).replace(/\s+/g, ' ');
      // A statement that joins the table twice is found once per mention.
      if (!statements.some((statement) => statement.file === file && statement.sql === sql)) {
        statements.push({ file: path.relative(servicesDirectory, file), sql });
      }
    }
  }
  return statements;
}

describe('event team membership access', () => {
  const statements = membershipStatements();

  it('finds the membership checks in every service that has them', () => {
    const files = new Set(statements.map((statement) => statement.file.split(path.sep)[0]));
    for (const service of ['event', 'inventory', 'queue', 'order', 'ticket']) assert.ok(files.has(service), service);
  });

  it('only grants access to accepted memberships, so revoked members lose it everywhere', () => {
    const accessChecks = statements.filter(
      (statement) => /^SELECT/.test(statement.sql.trim()) && /\brole (=|IN)/.test(statement.sql),
    );
    assert.ok(accessChecks.length >= 8, `found ${accessChecks.length} access checks`);
    for (const { file, sql } of accessChecks) assert.match(sql, /invite_status = 'ACCEPTED'/, `${file}: ${sql}`);
  });

  it('makes every other read or update say which invitation statuses it covers', () => {
    for (const { file, sql } of statements) {
      if (/^\s*(INSERT INTO|DELETE FROM)/.test(sql)) continue;
      assert.match(sql, /invite_status (=|<>) '[A-Z]+'/, `${file}: ${sql}`);
    }
  });

  it('never deletes a single member, which would erase the record of their access', () => {
    for (const { file, sql } of statements) {
      if (/^\s*DELETE FROM/.test(sql)) assert.doesNotMatch(sql, /user_sub/, `${file}: ${sql}`);
    }
  });
});
