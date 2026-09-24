import type { Server } from 'node:http';
import type { mock as nodeMock } from 'node:test';

/**
 * Shared setup for service tests that exercise real request handlers without
 * any real infrastructure. Nothing that uses this can reach a database or AWS:
 * the MySQL pool and the Cognito token verifier are replaced with fakes, and the
 * environment points at a host that cannot resolve.
 *
 * Call installOfflineServices() at the top of a test file, before importing the
 * service under test, because the service builds its pool and verifier on import.
 */

export interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface FakeDatabase {
  /** Every statement the service ran, in order. Whitespace is collapsed. */
  readonly calls: RecordedCall[];
  /** Script the fake: the first rule whose pattern matches a statement answers it. An Error is thrown. */
  on(pattern: RegExp, response: unknown): void;
  clearRules(): void;
  /** Forget recorded calls and scripted rules. */
  reset(): void;
}

export interface OfflineOptions {
  /** Environment variables to set on top of the offline defaults, e.g. { DB_NAME: 'checkout' }. */
  readonly env?: Readonly<Record<string, string>>;
  /** The claims a valid bearer token carries. The token "bad" always fails verification. */
  readonly claims: (token: string) => Record<string, unknown>;
}

export function installOfflineServices(mock: typeof nodeMock, options: OfflineOptions): FakeDatabase {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: 'db.invalid',
    DB_PORT: '1',
    DB_NAME: 'test',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_test',
    COGNITO_CLIENT_ID: 'test-client',
    ...options.env,
  });

  const calls: RecordedCall[] = [];
  let rules: { pattern: RegExp; response: unknown }[] = [];

  const run = (sql: string, params: readonly unknown[] = []): [unknown, unknown[]] => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: statement, params });
    const rule = rules.find((candidate) => candidate.pattern.test(statement));
    if (!rule) throw new Error(`Unscripted SQL: ${statement}`);
    if (rule.response instanceof Error) throw rule.response;
    return [rule.response, []];
  };
  const record = (sql: string) => async () => void calls.push({ sql, params: [] });
  const connection = {
    beginTransaction: record('BEGIN'),
    commit: record('COMMIT'),
    rollback: record('ROLLBACK'),
    release: () => undefined,
    query: async (sql: string, params?: readonly unknown[]) => run(sql, params),
    execute: async (sql: string, params?: readonly unknown[]) => run(sql, params),
  };
  const pool = { ...connection, getConnection: async () => connection };

  mock.module('mysql2/promise', { defaultExport: { createPool: () => pool } });
  mock.module('aws-jwt-verify', {
    namedExports: {
      CognitoJwtVerifier: {
        create: () => ({
          verify: async (token: string) => {
            if (token === 'bad') throw new Error('invalid token');
            return options.claims(token);
          },
        }),
      },
    },
  });

  return {
    calls,
    on: (pattern, response) => void rules.push({ pattern, response }),
    clearRules: () => {
      rules = [];
    },
    reset: () => {
      calls.length = 0;
      rules = [];
    },
  };
}

export interface TestServer {
  readonly base: string;
  close(): void;
}

/** Starts an express app on a free local port. */
export async function startServer(app: { listen(port: number): Server }): Promise<TestServer> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => void server.close() };
}
