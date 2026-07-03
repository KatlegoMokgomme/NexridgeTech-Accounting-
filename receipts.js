'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const { pool, withTransaction } = require('../db');
const { authenticate }          = require('../middleware/auth');
const { asyncHandler }          = require('../middleware/errorHandler');
const { logAudit }              = require('../middleware/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/receipts
router.get('/', asyncHandler(async (req, res) => {
  const { customer_id, from, to } = req.query;
  let q = `SELECT r.*, c.name AS customer_name, b.name AS bank_name
           FROM receipts r
           JOIN customers c ON c.id=r.customer_id
           JOIN bank_accounts b ON b.id=r.bank_id WHERE 1=1`;
  const p = [];
  if (customer_id) { p.push(customer_id); q += ` AND r.customer_id=$${p.length}`; }
  if (from)        { p.push(from);        q += ` AND r.date>=$${p.length}`; }
  if (to)          { p.push(to);          q += ` AND r.date<=$${p.length}`; }
  q += ' ORDER BY r.date DESC, r.created_at DESC';
  const { rows } = await pool.query(q, p);
  res.json(rows);
}));

// POST /api/receipts — auto-creates DR Bank / CR AR journal
router.post('/',
  [
    body('reference_number').trim().notEmpty(),
    body('date').isDate(),
    body('customer_id').notEmpty(),
    body('bank_id').notEmpty(),
    body('amount').isFloat({ min: 0.01 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { reference_number, date, customer_id, invoice_id, bank_id,
      amount, method = 'EFT', reference = '' } = req.body;

    const receipt = await withTransaction(async (client) => {
      // Get AR account and bank's ledger account
      const { rows: sets } = await client.query("SELECT key, value FROM settings WHERE key IN ('arAcc')");
      const settings = Object.fromEntries(sets.map(r => [r.key, r.value]));
      const arAcc = settings.arAcc || '1100';

      const { rows: [bank] } = await client.query(
        'SELECT * FROM bank_accounts WHERE id=$1', [bank_id]
      );
      if (!bank) throw Object.assign(new Error('Bank account not found'), { status: 404 });

      const { rows: [cust] } = await client.query('SELECT name FROM customers WHERE id=$1', [customer_id]);
      if (!cust) throw Object.assign(new Error('Customer not found'), { status: 404 });

      // Create journal
      const { rows: [j] } = await client.query(
        `INSERT INTO journals (date,reference,description,type,status,total_dr,total_cr,posted_by,posted_at,created_by)
         VALUES ($1,$2,$3,'receipt','posted',$4,$4,$5,NOW(),$5) RETURNING *`,
        [date, reference_number, `Receipt - ${cust.name}`, amount, req.user.username]
      );
      await client.query(
        `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order) VALUES ($1,$2,$3,$4,0,0)`,
        [j.id, bank.ledger_account_code, `Receipt from ${cust.name}`, amount]
      );
      await client.query(
        `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order) VALUES ($1,$2,$3,0,$4,1)`,
        [j.id, arAcc, `Receipt - ${reference_number}`, amount]
      );

      // Create receipt record
      const { rows } = await client.query(
        `INSERT INTO receipts (reference_number,date,customer_id,invoice_id,bank_id,amount,method,reference,journal_id,posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [reference_number, date, customer_id, invoice_id || null, bank_id, amount, method, reference, j.id, req.user.username]
      );
      return rows[0];
    });

    await logAudit({ action: 'CREATE', entity: 'receipts', entityId: receipt.id,
      description: `Receipt ${reference_number} — ${amount}`, performedBy: req.user.username, ip: req.ip });
    res.status(201).json(receipt);
  })
);

// GET /api/receipts/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, c.name AS customer_name, b.name AS bank_name
     FROM receipts r
     JOIN customers c ON c.id=r.customer_id
     JOIN bank_accounts b ON b.id=r.bank_id
     WHERE r.id=$1`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Receipt not found' });
  res.json(rows[0]);
}));

// DELETE /api/receipts/:id — voids the linked journal
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows: [r] } = await pool.query('SELECT * FROM receipts WHERE id=$1', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });

  await withTransaction(async (client) => {
    if (r.journal_id) {
      await client.query(
        `UPDATE journals SET status='voided', voided_by=$1, voided_at=NOW(), void_reason='Receipt deleted', updated_at=NOW() WHERE id=$2`,
        [req.user.username, r.journal_id]
      );
    }
    await client.query('DELETE FROM receipts WHERE id=$1', [r.id]);
  });

  await logAudit({ action: 'DELETE', entity: 'receipts', entityId: r.id,
    description: `Deleted receipt ${r.reference_number}`, performedBy: req.user.username, ip: req.ip });
  res.json({ message: 'Receipt deleted and journal voided' });
}));

module.exports = router;
