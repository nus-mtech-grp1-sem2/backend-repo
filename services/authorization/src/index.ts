import 'dotenv/config';
import mysql from 'mysql2/promise';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createApp, InvalidCallerToken } from './app.js';
import { JwtParseError, JwtInvalidSignatureError, JwtInvalidSignatureAlgorithmError, JwtInvalidClaimError, JwtWithoutValidKidError } from 'aws-jwt-verify/error';
import type { Role } from './policy.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
const workloadToken = required('AUTHORIZATION_SERVICE_TOKEN');
if (workloadToken.length < 32) throw new Error('AUTHORIZATION_SERVICE_TOKEN must contain at least 32 characters');
const verifier = CognitoJwtVerifier.create({ userPoolId: required('COGNITO_USER_POOL_ID'), clientId: required('COGNITO_CLIENT_ID'), tokenUse: 'access' });
const pool = mysql.createPool({
  host: required('DB_HOST'), port: Number(process.env.DB_PORT ?? 3306),
  user: required('DB_USER'), password: required('DB_PASSWORD'), database: 'authorization',
  connectionLimit: 10, connectTimeout: 3000, waitForConnections: true, queueLimit: 20,
  ...(process.env.DB_SSL === 'false' ? {} : { ssl: { rejectUnauthorized: true } }),
});
const app = createApp({
  workloadToken,
  verify: async token => {
    try { const claims = await verifier.verify(token); return { sub: claims.sub }; }
    catch (error) {
      if (error instanceof JwtParseError || error instanceof JwtInvalidSignatureError || error instanceof JwtInvalidSignatureAlgorithmError || error instanceof JwtInvalidClaimError || error instanceof JwtWithoutValidKidError) throw new InvalidCallerToken();
      throw error; // JWKS/network failures are unavailable decisions, never an authentication denial.
    }
  },
  access: async (sub, eventId) => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>({
      sql: `SELECT a.role, a.is_owner FROM event_role_assignments a JOIN users u ON u.user_id = a.user_id
            WHERE u.cognito_sub = ? AND u.issuer = ? AND a.event_id = ? AND a.status = 'ACTIVE'`,
      values: [sub, `https://cognito-idp.${required('COGNITO_USER_POOL_ID').split('_')[0]}.amazonaws.com/${required('COGNITO_USER_POOL_ID')}`, eventId],
      timeout: 400,
    });
    return { roles: rows.map(row => row.role as Role), isOwner: rows.some(row => Boolean(row.is_owner)) };
  },
});
const server = app.listen(Number(process.env.PORT ?? 3008), process.env.HOST ?? '127.0.0.1', () => console.info('authorization service listening'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const timer = setTimeout(() => process.exit(1), 5000); timer.unref();
    server.close(() => { void pool.end().then(() => { clearTimeout(timer); }).catch(error => { console.error('database shutdown failed', error); process.exitCode = 1; }); });
  });
}
