# Cognito authentication

Cognito verifies identity only. New users are Customers by default.

Organizer and Helper are event-specific roles, assigned through the Event
service's `event_team_memberships` table. The event creator is the owner and
first Organizer; they can invite other Organizers or Helpers by email.

There is no Cognito group setup or PostConfirmation group trigger.

---

## Migrating existing `customers` rows into Cognito

`customers` already holds a username/password for every existing account.
[`migrate-user.mjs`](./migrate-user.mjs) is a **User Migration** trigger that
authenticates against that row and lets Cognito create the matching Cognito
user the first time each legacy user signs in — after that, Cognito owns the
credential and the trigger is never called again for that user.

`admin_ind` / `operator_ind` on the row decide the `custom:role` attribute the
migrated user starts with (`organiser`, `event-helper`, or `customer` when
both are `N`). Event-level privileges still require an accepted membership in
the Event service.

Nothing here is deployed. The steps below are for a human to review and apply.

### Prerequisites

1. **Confirm the password hash algorithm.** `migrate-user.mjs` assumes
   `password_hash` is a bcrypt hash (`bcryptjs.compare`, which reads standard
   bcrypt hashes). If the existing app hashed passwords a different way
   (scrypt, PBKDF2, a legacy PHP/`crypt()` format, etc.), swap the comparison
   function before deploying — do **not** deploy this against real accounts
   without verifying that first, since every mismatch permanently locks that
   user out of migration until they use "forgot password".
2. **User pool has a Migration Lambda trigger slot** — configure it under
   "Extensions" in the user pool.

### Network access

The MySQL container runs inside the ECS VPC and only accepts connections from
the `ecs_tasks` security group (self-referencing ingress in
`infrastructure/terraform/security_groups.tf`) — there is no public endpoint.
This Lambda must therefore run **inside that VPC**, in the same private
subnets as the ECS tasks, with a security group allowed to reach MySQL on
3306. That is a networking change and needs the same review as any other VPC
change — see the `aws-terraform-change` skill before touching
`infrastructure/terraform/`.

### Deploying the trigger

1. Bundle `migrate-user.mjs` with its `node_modules` (`npm install` in this
   folder) into the Lambda deployment package — `mysql2` and `bcryptjs` are
   not part of the Lambda base image.
2. Create the Lambda (Node.js 20+), placed in the ECS VPC's private subnets,
   attached to a security group permitted to reach MySQL on 3306 (either add
   it to `aws_security_group.ecs_tasks` or create a narrower one just for
   this function — prefer the narrower one, since this Lambda otherwise has
   no need to reach any other ECS task).
3. Give the function's execution role:
   - `AWSLambdaVPCAccessExecutionRole` (needed for any Lambda placed in a VPC —
     creates/manages the ENI).
   - Read access to wherever the DB credentials are stored — reuse
     `aws_secretsmanager_secret.mysql` in `infrastructure/terraform/secrets.tf`
     rather than duplicating the password anywhere new.
4. Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` as the
   function's environment variables (pull `DB_USER`/`DB_PASSWORD` from the
   same secret above).
5. User pool → Extensions → Add Lambda trigger → **Migration** → select the
   function. Cognito adds the `lambda:InvokeFunction` permission for you.

### After it is live

Existing users sign in exactly as before — same email, same password, same
`/login` form in the SPA. The only visible change is that Cognito now
recognizes them from their very first post-cutover sign-in onward. Consider,
once you are confident the cutover is stable, nulling out `password_hash` for
migrated rows so the SQL credential can no longer be used as a second way in —
do this deliberately and only after confirming migrated users can sign in and
recover their password through Cognito, since it is not easily reversible.
