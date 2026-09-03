# Cognito Managed Login and customer assignment

The Angular SPA authenticates through Cognito Managed Login using OAuth 2.0
Authorization Code with PKCE. Cognito owns registration, email confirmation,
password recovery, and credential handling. The SPA app client must not have a
client secret.

## App client configuration

Configure the existing app client with the authorization code grant and the
`openid`, `email`, and `phone` scopes.

Allowed callback URLs:

```text
http://localhost:4200/
https://d84l1y8p4kdic.cloudfront.net
```

Allowed sign-out URLs:

```text
http://localhost:4200/
https://d84l1y8p4kdic.cloudfront.net
```

The configured Cognito domain is:

```text
ap-southeast-1cgmx4fpo2.auth.ap-southeast-1.amazoncognito.com
```

These identifiers and URLs are public application configuration, not secrets.

## Role model

Every self-registered user receives the `customer` Cognito group. The browser
cannot request `organiser` or `event-helper`; those privileged groups require a
separate approved administrative process. Frontend route guards are a usability
control only—protected backend operations must validate the access token and
authorize its `cognito:groups` claim.

## Primary assignment: PostConfirmation trigger

[`post-confirmation-add-to-group.mjs`](./post-confirmation-add-to-group.mjs)
assigns `customer` after sign-up confirmation. Deploy it as a Node.js 20+ Lambda
and attach it to `PostConfirmation_ConfirmSignUp`.

Its execution role needs only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "cognito-idp:AdminAddUserToGroup",
      "Resource": "arn:aws:cognito-idp:ap-southeast-1:<account-id>:userpool/ap-southeast-1_cgmx4fpO2"
    }
  ]
}
```

Nothing in this directory deploys the Lambda or changes the live user pool.

## Recovery assignment: Auth service

`POST /api/auth/roles/sync` is an idempotent recovery path. If a valid caller
has no group, it adds only `customer`; it never grants a privileged group. The
ECS task role is restricted to `AdminAddUserToGroup` on this user pool.

Use the non-mutating endpoint to test authentication:

```http
GET /api/auth/me
Authorization: Bearer <Cognito access token>
```

It returns the verified `username`, `sub`, and `groups`. Missing, expired, ID,
wrong-client, or wrong-pool tokens return `401`.
