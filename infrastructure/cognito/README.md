# Cognito role assignment

The SPA lets a visitor choose Customer, Organiser or Event helper when they
register. That choice is stored on the user as the `custom:role` attribute.

**The attribute alone grants nothing.** Roles are Cognito *groups*, and only an
admin caller can grant group membership, so the attribute has to be converted
into a group by something holding AWS credentials. That is what
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

## A note on self-service roles

Anyone who can reach the register form can request Organiser and receive it.
That is acceptable for a demo and not for production, where organiser status
would normally require approval. The shape of that change: keep writing
`custom:role` as a *request*, have this trigger grant only `customer`, and add
an admin action that promotes a user after review. The frontend needs no
changes for that, because it already derives everything from group membership.
