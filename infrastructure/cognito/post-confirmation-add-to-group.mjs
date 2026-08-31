/**
 * Cognito PostConfirmation trigger: put every newly confirmed user into the
 * customer group.
 *
 * NOT DEPLOYED. This file is the handler source only — creating the Lambda, its
 * IAM role and the trigger wiring are deliberate infrastructure changes for a
 * human to review and apply (see README.md in this folder).
 *
 * Why this exists: a browser cannot add a user to a Cognito group. That is the
 * AdminAddUserToGroup admin API, which needs AWS credentials that must never be
 * shipped in a single page app. Privileged groups require a separate approved
 * administrative process.
 *
 * Runtime: nodejs20.x or later (the AWS SDK v3 is on the Lambda image).
 */

import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({});

const DEFAULT_GROUP = 'customer';

export const handler = async (event) => {
  // Only the sign-up confirmation matters; the same trigger also fires for
  // forgot-password confirmations, where there is nothing to do.
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  try {
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        GroupName: DEFAULT_GROUP,
      }),
    );
  } catch (error) {
    // Never fail the trigger: throwing here leaves the user confirmed but
    // unable to complete sign-up. Log it and let them proceed as a customer,
    // which is what an empty group list already means to the app.
    console.error(
      'could not add %s to group %s',
      event.userName,
      DEFAULT_GROUP,
      error,
    );
  }

  return event;
};
