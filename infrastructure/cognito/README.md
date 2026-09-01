# Cognito role assignment

The SPA registers every visitor as a customer. Elevated organiser and event
helper access is granted separately by an administrator.

Roles are Cognito *groups*, and only an admin caller can grant group membership.
The PostConfirmation trigger grants the `customer` group using AWS credentials.
That is what
[`post-confirmation-add-to-group.mjs`](./post-confirmation-add-to-group.mjs)
does, running as a PostConfirmation trigger on the user pool.

Nothing here is deployed. The steps below are for a human to review and apply.

## Prerequisites in the user pool

1. **Custom attribute** — Sign-up experience → Custom attributes → add `role`,
   type String, **mutable**. Cognito exposes it as `custom:role`.
   Custom attributes cannot be renamed or deleted afterwards.
2. **App client write permission** — the app client must be allowed to *write*
   `custom:role`, or `SignUp` fails with an attribute error. Read permission is
   also needed for the value to appear in the id token.
3. **Groups** — create `customer`, `organiser` and `event-helper`, spelled
   exactly like that.

## Deploying the trigger

1. Create a Lambda (Node.js 20+) from the handler file.
2. Give its execution role permission to add users to groups in this pool only:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "cognito-idp:AdminAddUserToGroup",
         "Resource": "arn:aws:cognito-idp:ap-southeast-1:<account-id>:userpool/<pool-id>"
       }
     ]
   }
   ```

   Scope `Resource` to the one pool — a wildcard would let this function grant
   membership in any pool in the account.
3. User pool → Extensions → Add Lambda trigger → **Post confirmation** → select
   the function. Cognito adds the `lambda:InvokeFunction` permission for you.

## After it is live

Set `trustSelfDeclaredRole: false` in the frontend's `app.config.ts`. Until then
the SPA falls back to the self-asserted `custom:role` attribute so the three
roles can be demonstrated, which is a development convenience and not a
security boundary. With the flag off, the frontend trusts only real group
membership — matching what the backend services must enforce.

## Elevated roles

New registrations always start as customers. Add a separate administrator
workflow to promote approved users to the `organiser` or `event-helper` group.
The frontend derives access from Cognito group membership.

---

## Migrating existing `customers` rows into Cognito

`customers` already holds a username/password for every existing account.
[`migrate-user.mjs`](./migrate-user.mjs) is a **User Migration** trigger that
authenticates against that row and lets Cognito create the matching Cognito
user the first time each legacy user signs in — after that, Cognito owns the
credential and the trigger is never called again for that user.

`admin_ind` / `operator_ind` on the row decide the `custom:role` attribute the
migrated user starts with (`organiser`, `event-helper`, or `customer` when
both are `N`). Nothing else needs to change: the existing PostConfirmation
trigger and the auth service's `/roles/sync` endpoint already turn
`custom:role` into real group membership on next sign-in.

Nothing here is deployed. The steps below are for a human to review and apply.

### Prerequisites

1. **Confirm the password hash algorithm.** `migrate-user.mjs` assumes
   `password_hash` is a bcrypt hash (`bcryptjs.compare`, which reads standard
   bcrypt hashes). If the existing app hashed passwords a different way
   (scrypt, PBKDF2, a legacy PHP/`crypt()` format, etc.), swap the comparison
   function before deploying — do **not** deploy this against real accounts
   without verifying that first, since every mismatch permanently locks that
   user out of migration until they use "forgot password".
2. **User pool has a Migration Lambda trigger slot** — same "Extensions" tab
   as the PostConfirmation trigger.
3. **Groups exist** — `customer`, `organiser`, `event-helper` (see above).

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
