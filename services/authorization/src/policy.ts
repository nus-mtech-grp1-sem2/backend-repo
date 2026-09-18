export const policyVersion = '1';
export const actions = ['event.create', 'event.update', 'event.publish', 'event.cancel', 'event.delete', 'event.team.read', 'event.team.invite', 'event.team.revoke', 'event.team.revoke-organizer', 'ticket.search', 'ticket.checkin', 'ticket.stats.read'] as const;
export type Action = typeof actions[number];
export type Role = 'organizer' | 'event_helper';
export interface Access {
  roles: readonly Role[];
  isOwner: boolean;
}
export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (actions as readonly string[]).includes(value);
}
export function permits(action: Action, access: Access): boolean {
  if (action === 'event.create') return true;
  if (action === 'event.team.revoke-organizer') return access.isOwner && access.roles.includes('organizer');
  if (action.startsWith('ticket.')) return access.roles.some(role => role === 'organizer' || role === 'event_helper');
  return access.roles.includes('organizer');
}
