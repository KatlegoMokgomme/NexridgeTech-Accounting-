'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');

const { pool }                       = require('../db');
const { authenticate, requireRole }  = require('../middleware/auth');
const { asyncHandler }               = require('../middleware/errorHandler');
const { logAudit }                   = require('../middleware/audit');

const router = express.Router();
router.use(authenticate);

const SAFE_COLS = 'id, username, full_name, role, active, created_at, updated_at';

// GET /api/users  (admin only)
router.get('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { active, role } = req.query;
  let q = `SELECT ${SAFE_COLS} FROM users WHERE 1=1`;
  const p = [];
  if (active !== undefined) { p.push(active === 'true'); q += ` AND active=$${p.length}`; }
  if (role)                 { p.push(role);               q += ` AND role=$${p.length}`; }
  q += ' ORDER BY username';
  const { rows } = await pool.query(q, p);
  res.json(rows);
}));

// POST /api/users  (admin only)
router.post('/',
  requireRole('admin'),
  [
    body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('full_name').trim().notEmpty().withMessage('Full name required'),
    body('role').isIn(['admin', 'accountant', 'user']).withMessage('Role must be admin | accountant | user'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, password, full_name, role } = req.body;
    const hash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4)
       RETURNING ${SAFE_COLS}`,
      [username.toLowerCase().trim(), hash, full_name.trim(), role]
    );

    await logAudit({ action: 'CREATE_USER', entity: 'users', entityId: rows[0].id,
      description: `Admin created user ${username}`, performedBy: req.user.username, ip: req.ip });

    res.status(201).json(rows[0]);
  })
);

// GET /api/users/:id  (admin, or the user themselves)
router.get('/:id', asyncHandler(async (req, res) => {
  const isSelf  = req.user.sub === req.params.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Insufficient permissions' });

  const { rows } = await pool.query(
    `SELECT ${SAFE_COLS} FROM users WHERE id=$1`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

// PUT /api/users/:id  (admin only — for role/name; users change their own pw via /auth/change-password)
router.put('/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { full_name, role, active } = req.body;

    if (role && !['admin', 'accountant', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin | accountant | user' });
    }

    const { rows } = await pool.query(
      `UPDATE users SET
         full_name  = COALESCE($1, full_name),
         role       = COALESCE($2, role),
         active     = COALESCE($3, active),
         updated_at = NOW()
       WHERE id=$4
       RETURNING ${SAFE_COLS}`,
      [full_name, role, active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await logAudit({ action: 'UPDATE_USER', entity: 'users', entityId: rows[0].id,
      description: `Updated user ${rows[0].username}`, performedBy: req.user.username, ip: req.ip });

    res.json(rows[0]);
  })
);

// DELETE /api/users/:id  (admin only — soft deactivate, cannot deactivate yourself)
router.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  if (req.user.sub === req.params.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }
  const { rows } = await pool.query(
    `UPDATE users SET active=false, updated_at=NOW() WHERE id=$1 RETURNING ${SAFE_COLS}`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  // Revoke all refresh tokens for this user
  await pool.query('DELETE FROM refresh_tokens WHERE user_id=$1', [req.params.id]);

  await logAudit({ action: 'DEACTIVATE_USER', entity: 'users', entityId: rows[0].id,
    description: `Deactivated user ${rows[0].username}`, performedBy: req.user.username, ip: req.ip });

  res.json({ message: 'User deactivated', user: rows[0] });
}));

// POST /api/users/:id/reset-password  (admin only)
router.post('/:id/reset-password',
  requireRole('admin'),
  [body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const hash = await bcrypt.hash(req.body.newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2',
      [hash, req.params.id]
    );
    // Revoke all existing refresh tokens to force re-login
    await pool.query('DELETE FROM refresh_tokens WHERE user_id=$1', [req.params.id]);

    await logAudit({ action: 'RESET_PASSWORD', entity: 'users', entityId: rows[0].id,
      description: `Admin reset password for ${rows[0].username}`, performedBy: req.user.username, ip: req.ip });

    res.json({ message: 'Password reset successfully' });
  })
);

module.exports = router;
