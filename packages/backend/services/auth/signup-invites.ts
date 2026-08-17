/**
 * signup-invites.ts — 초대 코드 기반 셀프서비스 회원가입 흐름.
 *
 * Owns: signup_invite_codes + users.approval_status lifecycle.
 * Public API: invite code CRUD, public signup request, admin approval/rejection.
 * See: workspace/decisions/2026-06-18-invite-code-signup-admin-approval.md
 */
import crypto from 'crypto';
import { query, queryOne, execute, transaction } from '../../db/pg-repo.js';
import { VALID_ROLES } from '../damage-control.js';
import {
  USERNAME_RE,
  InvalidUsernameError,
  UsernameTakenError,
  autoJoinDefaultProjects,
  encryptPassword,
  invalidateAuthCache,
} from './auth.js';

export const APPROVAL_STATUSES = new Set(['active', 'pending', 'rejected', 'suspended']);
export const INVITE_ASSIGNABLE_ROLES = new Set(['viewer', 'guest', 'member', 'operator', 'customer_manager']);

export interface SignupInviteCodeRow {
  id: number;
  code: string;
  label: string | null;
  default_role: string;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  disabled: number;
  created_by: number | null;
  created_at: string;
}

export interface SignupRequestInput {
  inviteCode: string;
  username: string;
  password: string;
  displayName: string;
  affiliation?: string | null;
  approvalMode?: 'auto' | 'manual';
}

export class InvalidInviteCodeError extends Error {
  constructor(message = 'Invalid invite code') {
    super(message);
    this.name = 'InvalidInviteCodeError';
  }
}

export class SignupPendingApprovalError extends Error {
  constructor() {
    super('Account is pending admin approval');
    this.name = 'SignupPendingApprovalError';
  }
}

export class SignupRejectedError extends Error {
  constructor() {
    super('Account was rejected by an admin');
    this.name = 'SignupRejectedError';
  }
}

export class SignupSuspendedError extends Error {
  constructor() {
    super('Account is suspended');
    this.name = 'SignupSuspendedError';
  }
}

function normalizeCode(code: string): string {
  return code.trim();
}

function normalizeCodeKey(code: string): string {
  return normalizeCode(code).toLowerCase();
}

function isInviteUsable(invite: SignupInviteCodeRow | undefined): invite is SignupInviteCodeRow {
  if (!invite) return false;
  if (Number(invite.disabled) === 1) return false;
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return false;
  if (invite.max_uses !== null && Number(invite.used_count) >= Number(invite.max_uses)) return false;
  return true;
}

function assertInviteRole(role: string) {
  if (!INVITE_ASSIGNABLE_ROLES.has(role)) {
    throw new Error(`Invalid invite role: ${role}. Invite codes cannot grant admin.`);
  }
}

export function recommendInviteCode(label?: string | null): string {
  const seed = (label || 'tower')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18) || 'tower';
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${seed}-${suffix}`;
}

export async function listSignupInviteCodes() {
  const rows = await query<any>(
    `SELECT ic.*,
            u.username AS created_by_username,
            COUNT(su.id) FILTER (WHERE su.signup_invite_code_id = ic.id) AS signup_count,
            COUNT(su.id) FILTER (WHERE su.signup_invite_code_id = ic.id AND su.approval_status = 'pending') AS pending_count,
            COUNT(su.id) FILTER (WHERE su.signup_invite_code_id = ic.id AND su.approval_status = 'active') AS active_count
       FROM signup_invite_codes ic
       LEFT JOIN users u ON u.id = ic.created_by
       LEFT JOIN users su ON su.signup_invite_code_id = ic.id
      GROUP BY ic.id, u.username
      ORDER BY ic.created_at DESC, ic.id DESC`,
  );
  return rows.map((r) => ({
    ...r,
    disabled: Number(r.disabled) === 1,
    used_count: Number(r.used_count ?? 0),
    signup_count: Number(r.signup_count ?? 0),
    pending_count: Number(r.pending_count ?? 0),
    active_count: Number(r.active_count ?? 0),
  }));
}

export async function createSignupInviteCode(input: {
  code?: string | null;
  label?: string | null;
  defaultRole?: string | null;
  maxUses?: number | null;
  expiresAt?: string | null;
  createdBy?: number | null;
}) {
  const code = normalizeCode(input.code || recommendInviteCode(input.label));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,39}$/.test(code)) {
    throw new Error('Invite code must be 3-40 chars: letters, digits, dot, underscore, hyphen');
  }
  const role = input.defaultRole || 'member';
  assertInviteRole(role);
  const maxUses = input.maxUses === undefined || input.maxUses === null || Number(input.maxUses) <= 0
    ? null
    : Math.floor(Number(input.maxUses));
  const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;

  const row = await queryOne<SignupInviteCodeRow>(
    `INSERT INTO signup_invite_codes (code, label, default_role, max_uses, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [code, input.label ?? '', role, maxUses, expiresAt, input.createdBy ?? null],
  );
  return row!;
}

export async function updateSignupInviteCode(id: number, input: {
  label?: string | null;
  defaultRole?: string | null;
  maxUses?: number | null;
  expiresAt?: string | null;
  disabled?: boolean;
}) {
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (input.label !== undefined) { sets.push(`label = $${i++}`); vals.push(input.label ?? ''); }
  if (input.defaultRole !== undefined) {
    const role = input.defaultRole || 'member';
    assertInviteRole(role);
    sets.push(`default_role = $${i++}`);
    vals.push(role);
  }
  if (input.maxUses !== undefined) {
    sets.push(`max_uses = $${i++}`);
    vals.push(input.maxUses === null || Number(input.maxUses) <= 0 ? null : Math.floor(Number(input.maxUses)));
  }
  if (input.expiresAt !== undefined) {
    sets.push(`expires_at = $${i++}`);
    vals.push(input.expiresAt ? new Date(input.expiresAt).toISOString() : null);
  }
  if (input.disabled !== undefined) {
    sets.push(`disabled = $${i++}`);
    vals.push(input.disabled ? 1 : 0);
  }
  if (sets.length === 0) return null;
  vals.push(id);
  const row = await queryOne<SignupInviteCodeRow>(
    `UPDATE signup_invite_codes SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals,
  );
  return row ?? null;
}

/**
 * Retire an invite code without deleting its signup provenance.
 *
 * Historical codes must remain joinable from users.signup_invite_code_id so
 * admins can audit and control everyone who entered through that code.
 */
export async function deleteSignupInviteCode(id: number): Promise<boolean> {
  const result = await execute(
    'UPDATE signup_invite_codes SET disabled = 1 WHERE id = $1',
    [id],
  );
  return result.changes > 0;
}

export async function requestSignup(input: SignupRequestInput) {
  const username = input.username.trim();
  const displayName = input.displayName.trim();
  const affiliation = input.affiliation?.trim() || null;
  const inviteCode = normalizeCode(input.inviteCode);
  if (!inviteCode) throw new InvalidInviteCodeError('Invite code is required');
  if (!USERNAME_RE.test(username)) throw new InvalidUsernameError(username);
  if (!displayName) throw new Error('Display name is required');
  if (!input.password || input.password.length < 8) throw new Error('Password must be at least 8 characters');

  const encrypted = encryptPassword(input.password);
  const approvalMode = input.approvalMode === 'manual' ? 'manual' : 'auto';
  const approvalStatus = approvalMode === 'manual' ? 'pending' : 'active';

  const user = await transaction(async (client) => {
    const inviteRes = await client.query<SignupInviteCodeRow>(
      `SELECT *
         FROM signup_invite_codes
        WHERE lower(code) = $1
        FOR UPDATE`,
      [normalizeCodeKey(inviteCode)],
    );
    const invite = inviteRes.rows[0];
    if (!isInviteUsable(invite)) throw new InvalidInviteCodeError();

    const conflict = await client.query<{ id: number }>('SELECT id FROM users WHERE username = $1', [username]);
    if (conflict.rows[0]) throw new UsernameTakenError(username);

    const userRes = await client.query<{ id: number; username: string; role: string; approval_status: string }>(
      `INSERT INTO users (
         username, password_hash, role, display_name, affiliation,
         approval_status, signup_invite_code_id, approved_at, password_changed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 = 'active' THEN NOW() ELSE NULL END, NOW())
       RETURNING id, username, role, approval_status`,
      [username, encrypted, invite.default_role, displayName, affiliation, approvalStatus, invite.id],
    );
    await client.query(
      'UPDATE signup_invite_codes SET used_count = used_count + 1 WHERE id = $1',
      [invite.id],
    );
    return userRes.rows[0];
  });

  if (approvalStatus === 'active') {
    await autoJoinDefaultProjects(user.id, username, user.role);
  }
  return user;
}

export async function approveSignupUser(userId: number, approvedBy: number) {
  const row = await queryOne<{ id: number; username: string; role: string; approval_status: string }>(
    `UPDATE users
        SET approval_status = 'active',
            approved_by = $2,
            approved_at = NOW(),
            rejected_by = NULL,
            rejected_at = NULL,
            rejection_reason = NULL
      WHERE id = $1 AND disabled = 0 AND approval_status = 'pending'
      RETURNING id, username, role, approval_status`,
    [userId, approvedBy],
  );
  if (row) {
    invalidateAuthCache(userId);
    await autoJoinDefaultProjects(row.id, row.username, row.role);
  }
  return row ?? null;
}

export async function rejectSignupUser(userId: number, rejectedBy: number, reason?: string | null) {
  const row = await queryOne<{ id: number; username: string; approval_status: string }>(
    `UPDATE users
        SET approval_status = 'rejected',
            rejected_by = $2,
            rejected_at = NOW(),
            rejection_reason = $3
      WHERE id = $1 AND disabled = 0 AND approval_status = 'pending'
      RETURNING id, username, approval_status`,
    [userId, rejectedBy, reason ?? null],
  );
  if (row) invalidateAuthCache(userId);
  return row ?? null;
}

export async function assertValidRoleForApprovalStatus(role: string) {
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
}
