import type { Request, Response, NextFunction } from 'express';
import { queryOne } from '../../db/pg-repo.js';
import { canManageUserRole } from '../authority/user-management-policy.js';

/** Run after operatorOrAboveMiddleware; resolve stored roles rather than trusting request bodies. */
export function emailTargetAccess(kind: 'user' | 'invitation') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as any).user;
    if (actor?.role === 'admin') return next();
    if (actor?.role !== 'operator') return res.status(403).json({ error: 'Operator access required' });
    try {
      const id = String(req.params.id);
      if (kind === 'user' && !/^[1-9]\d*$/.test(id)) return res.status(400).json({ error: 'Invalid user id' });
      const target = kind === 'user'
        ? await queryOne<{ role: string }>('SELECT role FROM users WHERE id=$1', [id])
        : await queryOne<{ role: string }>('SELECT role FROM account_email_invitations WHERE id=$1', [id]);
      if (!target) return res.status(404).json({ error: 'Target not found' });
      if (!canManageUserRole(actor.role, target.role)) return res.status(403).json({ error: 'Only admins can manage privileged account email' });
      next();
    } catch { res.status(503).json({ error: 'Email management authority unavailable' }); }
  };
}
