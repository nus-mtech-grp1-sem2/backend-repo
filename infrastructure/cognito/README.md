# Cognito authentication

Cognito verifies identity only. New users are Customers by default.

Organizer and Helper are event-specific roles, assigned through the Event
service's `event_team_memberships` table. The event creator is the owner and
first Organizer; they can invite other Organizers or Helpers by email.

There is no Cognito group setup or PostConfirmation group trigger.
