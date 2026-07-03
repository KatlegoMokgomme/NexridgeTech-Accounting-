'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const { pool }                   = require('../db');
const { authenticate }           = require('../middleware/auth');
const { asyncHandler }           = require('../middleware/errorHandler');
const { logAudit }               = require('../middleware/audit');

const router = express.Router();

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, full_name: user.full_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
}
function signRefresh(userId) {
  return jwt.sign(
    { sub: userId },
    process.env.REFRESH_SECRET,
    { expiresIn: process.env.REFRESH_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/login
router.post('/login',
  [
    body('username').trim().notEmpty().withMessage('Username required'),
    body('password').notEmpty().withMessage('Password required'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, password } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username=$1 AND active=true', [username.toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user.id);
    const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [user.id, refreshToken, expiresAt]
    );

    // Prune expired tokens for this user (housekeeping)
    await pool.query(
      'DELETE FROM refresh_tokens WHERE user_id=$1 AND expires_at < NOW()',
      [user.id]
    );

    await logAudit({ action: 'LOGIN', entity: 'users', entityId: user.id,
      description: `User ${user.username} logged in`, performedBy: user.username,
      ip: req.ip });

    res.json({
      accessToken, refreshToken,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
    });
  })
);

// POST /api/auth/refresh
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

  let payload;
  try {
    payload = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM refresh_tokens WHERE token=$1 AND expires_at > NOW()', [refreshToken]
  );
  if (!rows.length) return res.status(401).json({ error: 'Refresh token revoked or expired' });

  const { rows: users } = await pool.query(
    'SELECT * FROM users WHERE id=$1 AND active=true', [payload.sub]
  );
  if (!users.length) return res.status(401).json({ error: 'User not found' });

  const user        = users[0];
  const accessToken = signAccess(user);
  res.json({ accessToken });
}));

// POST /api/auth/logout
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await pool.query('DELETE FROM refresh_tokens WHERE token=$1', [refreshToken]);
  }
  await logAudit({ action: 'LOGOUT', entity: 'users', entityId: req.user.sub,
    description: `User ${req.user.username} logged out`, performedBy: req.user.username,
    ip: req.ip });
  res.json({ message: 'Logged out successfully' });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, full_name, role, active, created_at FROM users WHERE id=$1',
    [req.user.sub]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

// POST /api/auth/change-password
router.post('/change-password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { currentPassword, newPassword } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.sub]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, user.id]);

    await logAudit({ action: 'CHANGE_PASSWORD', entity: 'users', entityId: user.id,
      description: `User ${user.username} changed password`, performedBy: user.username,
      ip: req.ip });

    res.json({ message: 'Password changed successfully' });
  })
);

module.exports = router;
