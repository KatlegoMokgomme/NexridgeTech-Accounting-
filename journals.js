'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const { pool, withTransaction } = require('../db');
const { authenticate }          = require('../middleware/auth');
const { asyncHandler }          = require('../middleware/errorHandler');
const { logAudit }              = require('../middleware/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/journals
router.get('/', asyncHandler(async (req, res) => {
  const { status, from, to, type } = req.query;
  let q = 'SELECT * FROM journals WHERE 1=1';
  const p = [];
  if (status) { p.push(status); q += ` AND status=$${p.length}`; }
  if (type)   { p.push(type);   q += ` AND type=$${p.length}`; }
  if (from)   { p.push(from);   q += ` AND date>=$${p.length}`; }
  if (to)     { p.push(to);     q += ` AND date<=$${p.length}`; }
  q += ' ORDER BY date DESC, created_at DESC';
  const { rows } = await pool.query(q, p);
  res.json(rows);
}));

// POST /api/journals
router.post('/',
  [
    body('date').isDate().withMessage('Valid date required'),
    body('reference').trim().notEmpty(),
    body('lines').isArray({ min: 2 }).withMessage('At least 2 lines required'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { date, reference, description = '', type = 'general', lines } = req.body;

    const totalDr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
    const totalCr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    if (Math.abs(totalDr - totalCr) > 0.01) {
      return res.status(400).json({ error: 'Journal does not balance (DR ≠ CR)' });
    }

    const journal = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO journals (date,reference,description,type,total_dr,total_cr,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [date, reference, description, type, totalDr, totalCr, req.user.username]
      );
      const j = rows[0];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [j.id, l.account_code, l.narration || '', Number(l.debit || 0), Number(l.credit || 0), i]
        );
      }
      return j;
    });

    await logAudit({ action: 'CREATE', entity: 'journals', entityId: journal.id,
      description: `Created journal ${journal.reference}`, performedBy: req.user.username, ip: req.ip });
    res.status(201).json(journal);
  })
);

// GET /api/journals/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows: [j] } = await pool.query('SELECT * FROM journals WHERE id=$1', [req.params.id]);
  if (!j) return res.status(404).json({ error: 'Journal not found' });
  const { rows: lines } = await pool.query(
    'SELECT * FROM journal_lines WHERE journal_id=$1 ORDER BY line_order', [j.id]
  );
  res.json({ ...j, lines });
}));

// PUT /api/journals/:id (draft only)
router.put('/:id', asyncHandler(async (req, res) => {
  const { rows: [j] } = await pool.query('SELECT * FROM journals WHERE id=$1', [req.params.id]);
  if (!j) return res.status(404).json({ error: 'Journal not found' });
  if (j.status !== 'draft') return res.status(400).json({ error: 'Only draft journals can be edited' });

  const { date, reference, description, type, lines } = req.body;

  const updated = await withTransaction(async (client) => {
    let totalDr = j.total_dr, totalCr = j.total_cr;
    if (lines) {
      totalDr = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
      totalCr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
      if (Math.abs(totalDr - totalCr) > 0.01) throw Object.assign(new Error('Journal does not balance'), { status: 400 });
    }
    const { rows } = await client.query(
      `UPDATE journals SET
         date=$1, reference=COALESCE($2,reference), description=COALESCE($3,description),
         type=COALESCE($4,type), total_dr=$5, total_cr=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [date || j.date, reference, description, type, totalDr, totalCr, j.id]
    );
    if (lines) {
      await client.query('DELETE FROM journal_lines WHERE journal_id=$1', [j.id]);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [j.id, l.account_code, l.narration || '', Number(l.debit || 0), Number(l.credit || 0), i]
        );
      }
    }
    return rows[0];
  });
  res.json(updated);
}));

// POST /api/journals/:id/post
router.post('/:id/post', asyncHandler(async (req, res) => {
  const { rows: [j] } = await pool.query('SELECT * FROM journals WHERE id=$1', [req.params.id]);
  if (!j) return res.status(404).json({ error: 'Journal not found' });
  if (j.status !== 'draft') return res.status(400).json({ error: 'Journal is not in draft status' });

  const { rows } = await pool.query(
    `UPDATE journals SET status='posted', posted_by=$1, posted_at=NOW(), updated_at=NOW()
     WHERE id=$2 RETURNING *`,
    [req.user.username, j.id]
  );
  await logAudit({ action: 'POST', entity: 'journals', entityId: j.id,
    description: `Posted journal ${j.reference}`, performedBy: req.user.username, ip: req.ip });
  res.json(rows[0]);
}));

// POST /api/journals/:id/void
router.post('/:id/void', asyncHandler(async (req, res) => {
  const { rows: [j] } = await pool.query('SELECT * FROM journals WHERE id=$1', [req.params.id]);
  if (!j) return res.status(404).json({ error: 'Journal not found' });
  if (j.status === 'voided') return res.status(400).json({ error: 'Journal already voided' });

  const { void_reason = '' } = req.body;
  const { rows } = await pool.query(
    `UPDATE journals SET status='voided', voided_by=$1, voided_at=NOW(), void_reason=$2, updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [req.user.username, void_reason, j.id]
  );
  await logAudit({ action: 'VOID', entity: 'journals', entityId: j.id,
    description: `Voided journal ${j.reference}`, performedBy: req.user.username, ip: req.ip });
  res.json(rows[0]);
}));

// POST /api/journals/:id/reverse — create a mirrored reversal journal (draft)
router.post('/:id/reverse', asyncHandler(async (req, res) => {
  const { rows: [j] } = await pool.query('SELECT * FROM journals WHERE id=$1', [req.params.id]);
  if (!j) return res.status(404).json({ error: 'Journal not found' });
  if (j.status !== 'posted') return res.status(400).json({ error: 'Only posted journals can be reversed' });

  const { rows: lines } = await pool.query(
    'SELECT * FROM journal_lines WHERE journal_id=$1 ORDER BY line_order', [j.id]
  );

  const { date, reason = '' } = req.body;
  const reversalDate = date || new Date().toISOString().slice(0, 10);

  const reversal = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO journals (date,reference,description,type,total_dr,total_cr,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        reversalDate,
        `REV-${j.reference}`,
        `Reversal of ${j.reference}${reason ? ' — ' + reason : ''}`,
        j.type,
        j.total_dr,
        j.total_cr,
        req.user.username,
      ]
    );
    const rev = rows[0];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // Swap debit and credit
      await client.query(
        `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rev.id, l.account_code, `[Reversal] ${l.narration}`, l.credit, l.debit, i]
      );
    }
    return rev;
  });

  await logAudit({ action: 'REVERSE', entity: 'journals', entityId: j.id,
    description: `Created reversal ${reversal.reference} for ${j.reference}`,
    performedBy: req.user.username, ip: req.ip });

  res.status(201).json(reversal);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows: [j] } = await pool.query('SELECT * FROM journals WHERE id=$1', [req.params.id]);
  if (!j) return res.status(404).json({ error: 'Journal not found' });
  if (j.status !== 'draft') return res.status(400).json({ error: 'Only draft journals can be deleted' });
  await pool.query('DELETE FROM journals WHERE id=$1', [j.id]);
  res.json({ message: 'Journal deleted' });
}));

module.exports = router;
