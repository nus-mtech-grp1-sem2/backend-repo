/**
 * Cognito User Migration trigger: authenticates a legacy `customers` row and
 * lets Cognito silently create the matching Cognito user on first login.
 *
 * NOT DEPLOYED. This file is the handler source only — creating the Lambda,
 * its IAM role, VPC wiring and the trigger config are deliberate
 * infrastructure changes for a human to review and apply (see README.md).
 *
 * Why this exists: `customers` already holds a username/password pair for
 * every existing account. Rather than run that as a second, parallel login
 * system, this trigger fires the *one* time each legacy user signs in after
 * cutover — Cognito calls it with the credentials the user just typed, and if
 * this handler confirms them against the SQL row, Cognito creates the user in
 * the pool and never calls this trigger for that user again.
 *
 * `admin_ind` / `operator_ind` on the row decide the role Cognito starts the
 * user with, via the `custom:role` attribute — the same attribute the
 * existing PostConfirmation flow and the auth service's `/roles/sync`
 * endpoint already know how to turn into group membership. No changes are
 * needed to that flow for a migrated user to end up in the right group.
 *
 * Runtime: nodejs20.x or later, deployed with its own `node_modules`
 * (mysql2 + bcryptjs are not part of the Lambda base image).
 */

import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

let pool;

/** One pooled connection reused across warm invocations, not per-call. */
function db() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 3306),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectionLimit: 2, // a migration trigger runs rarely per user; keep it small
      ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

/** Role Cognito should start the migrated user with. */
function roleFromIndicators(row) {
  if (row.admin_ind === 'Y') {
    return 'organiser';
  }
  if (row.operator_ind === 'Y') {
    return 'event-helper';
  }
  return 'customer';
}

async function findCustomer(email) {
  const [rows] = await db().query(
    'SELECT customer_id, email, password_hash, first_name, last_name, admin_ind, operator_ind ' +
      'FROM customers WHERE email = ? AND status = ? LIMIT 1',
    [email, 'active'],
  );
  return rows[0] ?? null;
}

function userAttributesFor(row) {
  return {
    email: row.email,
    email_verified: 'true',
    given_name: row.first_name,
    family_name: row.last_name,
    'custom:role': roleFromIndicators(row),
  };
}

export const handler = async (event) => {
  if (event.triggerSource === 'UserMigration_Authentication') {
    const email = event.userName;
    const password = event.request.password;
    const row = await findCustomer(email);

    // Cognito requires a thrown error to reject the sign-in; it must not
    // reveal which of email/password was wrong, same as the SQL-only login
    // did before.
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new Error('Bad credentials');
    }

    event.response.userAttributes = userAttributesFor(row);
    event.response.finalUserStatus = 'CONFIRMED';
    event.response.messageAction = 'SUPPRESS';
    return event;
  }

  if (event.triggerSource === 'UserMigration_ForgotPassword') {
    // Cognito calls this before it will let an unmigrated user reset a
    // password; it needs the user to exist, not the password checked.
    const row = await findCustomer(event.userName);
    if (!row) {
      throw new Error('Bad credentials');
    }

    event.response.userAttributes = userAttributesFor(row);
    event.response.finalUserStatus = 'CONFIRMED';
    event.response.messageAction = 'SUPPRESS';
    return event;
  }

  return event;
};
