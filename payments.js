'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const { pool, withTransaction } = require('../db');
const { authenticate }          = require('../middleware/auth');
const { asyncHandler }          = require('../middleware/errorHandler');
const { logAudit }              = require('../middleware/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/payments
router.get('/', asyncHandler(async (req, res) => {
  const { supplier_id, from, to } = req.query;
  let q = `SELECT p.*, s.name AS supplier_name, b.name AS bank_name
           FROM payments p
           JOIN suppliers s ON s.id=p.supplier_id
           JOIN bank_accounts b ON b.id=p.bank_id WHERE 1=1`;
  const params = [];
  if (supplier_id) { params.push(supplier_id); q += ` AND p.supplier_id=$${params.length}`; }
  if (from)        { params.push(from);        q += ` AND p.date>=$${params.length}`; }
  if (to)          { params.push(to);          q += ` AND p.date<=$${params.length}`; }
  q += ' ORDER BY p.date DESC';
  const { rows } = await pool.query(q, params);
  res.json(rows);
}));

// POST /api/payments — auto-creates DR AP / CR Bank journal
router.post('/',
  [
    body('reference_number').trim().notEmpty(),
    body('date').isDate(),
    body('supplier_id').notEmpty(),
    body('bank_id').notEmpty(),
    body('amount').isFloat({ min: 0.01 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { reference_number, date, supplier_id, bill_id, bank_id,
      amount, method = 'EFT', reference = '' } = req.body;

    const payment = await withTransaction(async (client) => {
      const { rows: sets } = await client.query("SELECT key, value FROM settings WHERE key='apAcc'");
      const apAcc = sets[0]?.value || '3000';

      const { rows: [bank] } = await client.query('SELECT * FROM bank_accounts WHERE id=$1', [bank_id]);
      if (!bank) throw Object.assign(new Error('Bank account not found'), { status: 404 });

      const { rows: [supp] } = await client.query('SELECT name FROM suppliers WHERE id=$1', [supplier_id]);
      if (!supp) throw Object.assign(new Error('Supplier not found'), { status: 404 });

      // Journal: DR AP / CR Bank
      const { rows: [j] } = await client.query(
        `INSERT INTO journals (date,reference,description,type,status,total_dr,total_cr,posted_by,posted_at,created_by)
         VALUES ($1,$2,$3,'payment','posted',$4,$4,$5,NOW(),$5) RETURNING *`,
        [date, reference_number, `Payment - ${supp.name}`, amount, req.user.username]
      );
      await client.query(
        `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order) VALUES ($1,$2,$3,$4,0,0)`,
        [j.id, apAcc, `Payment to ${supp.name}`, amount]
      );
      await client.query(
        `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order) VALUES ($1,$2,$3,0,$4,1)`,
        [j.id, bank.ledger_account_code, `Payment - ${reference_number}`, amount]
      );

      const { rows } = await client.query(
        `INSERT INTO payments (reference_number,date,supplier_id,bill_id,bank_id,amount,method,reference,journal_id,posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [reference_number, date, supplier_id, bill_id || null, bank_id, amount, method, reference, j.id, req.user.username]
      );
      return rows[0];
    });

    await logAudit({ action: 'CREATE', entity: 'payments', entityId: payment.id,
      description: `Payment ${reference_number} — ${amount}`, performedBy: req.user.username, ip: req.ip });
    res.status(201).json(payment);
  })
);

// GET /api/payments/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, s.name AS supplier_name, b.name AS bank_name
     FROM payments p
     JOIN suppliers s ON s.id=p.supplier_id
     JOIN bank_accounts b ON b.id=p.bank_id
     WHERE p.id=$1`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
  res.json(rows[0]);
}));

// DELETE /api/payments/:id — voids the linked journal
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id=$1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Payment not found' });

  await withTransaction(async (client) => {
    if (p.journal_id) {
      await client.query(
        `UPDATE journals SET status='voided', voided_by=$1, voided_at=NOW(), void_reason='Payment deleted', updated_at=NOW() WHERE id=$2`,
        [req.user.username, p.journal_id]
      );
    }
    await client.query('DELETE FROM payments WHERE id=$1', [p.id]);
  });

  await logAudit({ action: 'DELETE', entity: 'payments', entityId: p.id,
    description: `Deleted payment ${p.reference_number}`, performedBy: req.user.username, ip: req.ip });
  res.json({ message: 'Payment deleted and journal voided' });
}));

module.exports = router;
