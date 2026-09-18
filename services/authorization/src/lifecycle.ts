import type { Pool } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

// Internal foundation; public mutation adapters are introduced in the cutover PR.
// Caller must be derived from a verified token, never a request body's actor field.
export async function acceptInvitation(pool: Pool, invitationId: number, actorSub: string, issuer: string, requestId: string): Promise<boolean> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT i.* FROM event_role_invitations i JOIN users u ON u.user_id=i.user_id
       WHERE i.invitation_id=? AND u.cognito_sub=? AND u.issuer=? FOR UPDATE`, [invitationId, actorSub, issuer]);
    const invitation = rows[0];
    if (!invitation || !['PENDING', 'ACCEPTED'].includes(invitation.status)) { await connection.rollback(); return false; }
    if (invitation.status === 'ACCEPTED') { await connection.commit(); return true; }
    await connection.execute(
      `INSERT INTO event_role_assignments (user_id,event_id,role,granted_by_sub) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE status='ACTIVE', revoked_at=NULL, revoked_by_sub=NULL,
       granted_by_sub=VALUES(granted_by_sub), granted_at=CURRENT_TIMESTAMP, version=version+1`,
      [invitation.user_id, invitation.event_id, invitation.role, invitation.invited_by_sub]);
    await connection.execute("UPDATE event_role_invitations SET status='ACCEPTED', responded_at=CURRENT_TIMESTAMP WHERE invitation_id=?", [invitationId]);
    await connection.execute(
      `INSERT INTO audit_records (request_id,actor_sub,event_id,target_user_id,action,old_state,new_state) VALUES (?,?,?,?,?,?,?)`,
      [requestId, actorSub, invitation.event_id, invitation.user_id, 'invitation.accept', JSON.stringify({ status: 'PENDING' }), JSON.stringify({ status: 'ACCEPTED', role: invitation.role })]);
    await connection.commit(); return true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function revokeAssignment(pool: Pool, assignmentId: number, actorSub: string, issuer: string, requestId: string): Promise<boolean> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Lock all event organiser rows plus target in a consistent order so concurrent
    // revocation cannot make the authority check and mutation disagree.
    const [targets] = await connection.query<RowDataPacket[]>('SELECT event_id FROM event_role_assignments WHERE assignment_id=?', [assignmentId]);
    if (!targets[0]) { await connection.rollback(); return false; }
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT a.*,u.cognito_sub,u.issuer FROM event_role_assignments a JOIN users u ON u.user_id=a.user_id
       WHERE a.event_id=? ORDER BY a.assignment_id FOR UPDATE`, [targets[0].event_id]);
    const target = rows.find(row => String(row.assignment_id) === String(assignmentId));
    const actor = rows.find(row => row.cognito_sub === actorSub && row.issuer === issuer && row.role === 'organizer' && row.status === 'ACTIVE');
    if (!target || !actor || target.cognito_sub === actorSub || target.is_owner || (target.role === 'organizer' && !actor.is_owner)) {
      await connection.rollback(); return false;
    }
    if (target.status === 'REVOKED') { await connection.commit(); return true; }
    const [result] = await connection.execute<ResultSetHeader>(
      "UPDATE event_role_assignments SET status='REVOKED', revoked_by_sub=?, revoked_at=CURRENT_TIMESTAMP, version=version+1 WHERE assignment_id=? AND status='ACTIVE'",
      [actorSub, assignmentId]);
    if (result.affectedRows !== 1) throw new Error('Assignment changed during revocation');
    await connection.execute(
      'INSERT INTO audit_records (request_id,actor_sub,event_id,target_user_id,action,old_state,new_state) VALUES (?,?,?,?,?,?,?)',
      [requestId, actorSub, target.event_id, target.user_id, 'assignment.revoke', JSON.stringify({ status: 'ACTIVE', role: target.role }), JSON.stringify({ status: 'REVOKED', role: target.role })]);
    await connection.commit(); return true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export async function rejectInvitation(pool: Pool, invitationId: number, actorSub: string, issuer: string, requestId: string): Promise<boolean> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT i.* FROM event_role_invitations i JOIN users u ON u.user_id=i.user_id
       WHERE i.invitation_id=? AND u.cognito_sub=? AND u.issuer=? FOR UPDATE`, [invitationId, actorSub, issuer]);
    const invitation = rows[0];
    if (!invitation || !['PENDING', 'REJECTED'].includes(invitation.status)) { await connection.rollback(); return false; }
    if (invitation.status === 'REJECTED') { await connection.commit(); return true; }
    await connection.execute("UPDATE event_role_invitations SET status='REJECTED', responded_at=CURRENT_TIMESTAMP WHERE invitation_id=?", [invitationId]);
    await connection.execute(
      'INSERT INTO audit_records (request_id,actor_sub,event_id,target_user_id,action,old_state,new_state) VALUES (?,?,?,?,?,?,?)',
      [requestId, actorSub, invitation.event_id, invitation.user_id, 'invitation.reject', JSON.stringify({ status: 'PENDING' }), JSON.stringify({ status: 'REJECTED' })]);
    await connection.commit(); return true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
