'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');

const { pool, withTransaction } = require('../db');
const { authenticate }          = require('../middleware/auth');
const { asyncHandler }          = require('../middleware/errorHandler');
const { logAudit }              = require('../middleware/audit');

const router = express.Router();
router.use(authenticate);

async function getSettings(client) {
  const { rows } = await client.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// GET /api/bills
router.get('/', asyncHandler(async (req, res) => {
  const { supplier_id, status, from, to } = req.query;
  let q = `SELECT b.*, s.name AS supplier_name FROM bills b
           JOIN suppliers s ON s.id=b.supplier_id WHERE 1=1`;
  const p = [];
  if (supplier_id) { p.push(supplier_id); q += ` AND b.supplier_id=$${p.length}`; }
  if (status)      { p.push(status);      q += ` AND b.status=$${p.length}`; }
  if (from)        { p.push(from);        q += ` AND b.date>=$${p.length}`; }
  if (to)          { p.push(to);          q += ` AND b.date<=$${p.length}`; }
  q += ' ORDER BY b.date DESC';
  const { rows } = await pool.query(q, p);
  res.json(rows);
}));

// POST /api/bills
router.post('/',
  [
    body('supplier_id').notEmpty(),
    body('date').isDate(),
    body('bill_number').trim().notEmpty(),
    body('lines').isArray({ min: 1 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { supplier_id, date, bill_number, due_date, reference = '',
      vat_applicable = true, lines } = req.body;

    const subtotal   = lines.reduce((s, l) => s + Number(l.line_total || 0), 0);
    const vatRate    = vat_applicable ? (await pool.query("SELECT value FROM settings WHERE key='vatRate'")).rows[0]?.value / 100 || 0.15 : 0;
    const vat_amount = +(subtotal * vatRate).toFixed(2);
    const total      = +(subtotal + vat_amount).toFixed(2);

    const bill = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO bills (supplier_id,date,bill_number,due_date,reference,subtotal,vat_amount,total,vat_applicable,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [supplier_id, date, bill_number, due_date || null, reference, subtotal, vat_amount, total, vat_applicable, req.user.username]
      );
      const b = rows[0];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO bill_lines (bill_id,description,account_code,quantity,unit_price,line_total,line_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [b.id, l.description || '', l.account_code || '', Number(l.quantity || 1),
           Number(l.unit_price || 0), Number(l.line_total || 0), i]
        );
      }
      return b;
    });
    await logAudit({ action: 'CREATE', entity: 'bills', entityId: bill.id,
      description: `Created bill ${bill_number}`, performedBy: req.user.username, ip: req.ip });
    res.status(201).json(bill);
  })
);

// GET /api/bills/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows: [bill] } = await pool.query(
    `SELECT b.*, s.name AS supplier_name FROM bills b
     JOIN suppliers s ON s.id=b.supplier_id WHERE b.id=$1`, [req.params.id]
  );
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const { rows: lines } = await pool.query(
    'SELECT * FROM bill_lines WHERE bill_id=$1 ORDER BY line_order', [bill.id]
  );
  const { rows: [bal] } = await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE bill_id=$1", [bill.id]
  );
  res.json({ ...bill, lines, balance: +(bill.total - bal.paid).toFixed(2), paid: +bal.paid });
}));

// PUT /api/bills/:id (draft only)
router.put('/:id', asyncHandler(async (req, res) => {
  const { rows: [bill] } = await pool.query('SELECT * FROM bills WHERE id=$1', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'draft') return res.status(400).json({ error: 'Only draft bills can be edited' });

  const { date, due_date, reference, vat_applicable, lines } = req.body;
  const updated = await withTransaction(async (client) => {
    let { subtotal, vat_amount, total } = bill;
    if (lines) {
      subtotal   = lines.reduce((s, l) => s + Number(l.line_total || 0), 0);
      const rate = (vat_applicable ?? bill.vat_applicable) ? 0.15 : 0;
      vat_amount = +(subtotal * rate).toFixed(2);
      total      = +(subtotal + vat_amount).toFixed(2);
    }
    const { rows } = await client.query(
      `UPDATE bills SET date=COALESCE($1,date), due_date=COALESCE($2,due_date), reference=COALESCE($3,reference),
         vat_applicable=COALESCE($4,vat_applicable), subtotal=$5, vat_amount=$6, total=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [date, due_date, reference, vat_applicable, subtotal, vat_amount, total, bill.id]
    );
    if (lines) {
      await client.query('DELETE FROM bill_lines WHERE bill_id=$1', [bill.id]);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO bill_lines (bill_id,description,account_code,quantity,unit_price,line_total,line_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [bill.id, l.description || '', l.account_code || '', Number(l.quantity || 1),
           Number(l.unit_price || 0), Number(l.line_total || 0), i]
        );
      }
    }
    return rows[0];
  });
  res.json(updated);
}));

// POST /api/bills/:id/post — DR Expense + Input VAT / CR Accounts Payable
router.post('/:id/post', asyncHandler(async (req, res) => {
  const { rows: [bill] } = await pool.query(
    `SELECT b.*, s.name AS supplier_name FROM bills b
     JOIN suppliers s ON s.id=b.supplier_id WHERE b.id=$1`, [req.params.id]
  );
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'draft') return res.status(400).json({ error: 'Bill already posted or voided' });

  const { rows: lines } = await pool.query(
    'SELECT * FROM bill_lines WHERE bill_id=$1 ORDER BY line_order', [bill.id]
  );

  const result = await withTransaction(async (client) => {
    const s = await getSettings(client);
    const apAcc = s.apAcc || '3000';
    const vatIn = s.vatIn || '1400';

    // pg returns NUMERIC as strings — coerce everything to Number first
    const billTotal = Number(bill.total);
    const billVat   = Number(bill.vat_amount);

    const journalLines = [];
    // DR Expense per line
    for (const l of lines) {
      journalLines.push({ account_code: l.account_code || '5000', debit: Number(l.line_total), credit: 0, narration: l.description });
    }
    // DR Input VAT
    if (billVat > 0) {
      journalLines.push({ account_code: vatIn, debit: billVat, credit: 0, narration: 'Input VAT' });
    }
    // CR Accounts Payable
    journalLines.push({ account_code: apAcc, debit: 0, credit: billTotal, narration: `AP - ${bill.bill_number}` });

    const totalDr = journalLines.reduce((sum, l) => sum + l.debit,  0);
    const totalCr = journalLines.reduce((sum, l) => sum + l.credit, 0);

    const { rows: [j] } = await client.query(
      `INSERT INTO journals (date,reference,description,type,status,total_dr,total_cr,posted_by,posted_at,created_by)
       VALUES ($1,$2,$3,'bill','posted',$4,$5,$6,NOW(),$6) RETURNING *`,
      [bill.date, bill.bill_number, `Bill - ${bill.supplier_name}`, totalDr, totalCr, req.user.username]
    );
    for (let i = 0; i < journalLines.length; i++) {
      const l = journalLines[i];
      await client.query(
        `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [j.id, l.account_code, l.narration, l.debit, l.credit, i]
      );
    }
    const { rows } = await client.query(
      `UPDATE bills SET status='posted', journal_id=$1, posted_by=$2, posted_at=NOW(), updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [j.id, req.user.username, bill.id]
    );
    return rows[0];
  });

  await logAudit({ action: 'POST', entity: 'bills', entityId: bill.id,
    description: `Posted bill ${bill.bill_number}`, performedBy: req.user.username, ip: req.ip });
  res.json(result);
}));

// POST /api/bills/:id/void
router.post('/:id/void', asyncHandler(async (req, res) => {
  const { rows: [bill] } = await pool.query('SELECT * FROM bills WHERE id=$1', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status === 'voided') return res.status(400).json({ error: 'Already voided' });
  await withTransaction(async (client) => {
    if (bill.journal_id) {
      await client.query(
        `UPDATE journals SET status='voided', voided_by=$1, voided_at=NOW(), void_reason='Bill voided', updated_at=NOW() WHERE id=$2`,
        [req.user.username, bill.journal_id]
      );
    }
    await client.query(`UPDATE bills SET status='voided', updated_at=NOW() WHERE id=$1`, [bill.id]);
  });
  res.json({ message: 'Bill voided' });
}));

// DELETE /api/bills/:id (draft only)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows: [bill] } = await pool.query('SELECT * FROM bills WHERE id=$1', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'draft') return res.status(400).json({ error: 'Only draft bills can be deleted' });
  await pool.query('DELETE FROM bills WHERE id=$1', [bill.id]);
  res.json({ message: 'Bill deleted' });
}));

module.exports = router;
