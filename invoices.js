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

// GET /api/invoices
router.get('/', asyncHandler(async (req, res) => {
  const { customer_id, status, from, to } = req.query;
  let q = `SELECT i.*, c.name AS customer_name FROM invoices i
           JOIN customers c ON c.id=i.customer_id WHERE 1=1`;
  const p = [];
  if (customer_id) { p.push(customer_id); q += ` AND i.customer_id=$${p.length}`; }
  if (status)      { p.push(status);      q += ` AND i.status=$${p.length}`; }
  if (from)        { p.push(from);        q += ` AND i.date>=$${p.length}`; }
  if (to)          { p.push(to);          q += ` AND i.date<=$${p.length}`; }
  q += ' ORDER BY i.date DESC, i.created_at DESC';
  const { rows } = await pool.query(q, p);
  res.json(rows);
}));

// POST /api/invoices
router.post('/',
  [
    body('customer_id').notEmpty(),
    body('date').isDate(),
    body('invoice_number').trim().notEmpty(),
    body('lines').isArray({ min: 1 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { customer_id, date, invoice_number, due_date, reference = '',
      vat_applicable = true, lines } = req.body;

    const subtotal  = lines.reduce((s, l) => s + Number(l.line_total || 0), 0);
    const vatRate   = vat_applicable ? (await pool.query("SELECT value FROM settings WHERE key='vatRate'")).rows[0]?.value / 100 || 0.15 : 0;
    const vat_amount = +(subtotal * vatRate).toFixed(2);
    const total      = +(subtotal + vat_amount).toFixed(2);

    const invoice = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO invoices (customer_id,date,invoice_number,due_date,reference,subtotal,vat_amount,total,vat_applicable,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [customer_id, date, invoice_number, due_date || null, reference, subtotal, vat_amount, total, vat_applicable, req.user.username]
      );
      const inv = rows[0];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO invoice_lines (invoice_id,description,account_code,quantity,unit_price,line_total,line_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [inv.id, l.description || '', l.account_code || '', Number(l.quantity || 1),
           Number(l.unit_price || 0), Number(l.line_total || 0), i]
        );
      }
      return inv;
    });
    await logAudit({ action: 'CREATE', entity: 'invoices', entityId: invoice.id,
      description: `Created invoice ${invoice_number}`, performedBy: req.user.username, ip: req.ip });
    res.status(201).json(invoice);
  })
);

// GET /api/invoices/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows: [inv] } = await pool.query(
    `SELECT i.*, c.name AS customer_name FROM invoices i
     JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [req.params.id]
  );
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_order', [inv.id]
  );
  // Balance = total - sum of receipts
  const { rows: [bal] } = await pool.query(
    "SELECT COALESCE(SUM(amount),0) AS paid FROM receipts WHERE invoice_id=$1", [inv.id]
  );
  res.json({ ...inv, lines, balance: +(inv.total - bal.paid).toFixed(2), paid: +bal.paid });
}));

// PUT /api/invoices/:id (draft only)
router.put('/:id', asyncHandler(async (req, res) => {
  const { rows: [inv] } = await pool.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be edited' });

  const { date, due_date, reference, vat_applicable, lines } = req.body;

  const updated = await withTransaction(async (client) => {
    let { subtotal, vat_amount, total } = inv;
    if (lines) {
      subtotal   = lines.reduce((s, l) => s + Number(l.line_total || 0), 0);
      const rate = (vat_applicable ?? inv.vat_applicable) ? 0.15 : 0;
      vat_amount = +(subtotal * rate).toFixed(2);
      total      = +(subtotal + vat_amount).toFixed(2);
    }
    const { rows } = await client.query(
      `UPDATE invoices SET
         date=COALESCE($1,date), due_date=COALESCE($2,due_date), reference=COALESCE($3,reference),
         vat_applicable=COALESCE($4,vat_applicable), subtotal=$5, vat_amount=$6, total=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [date, due_date, reference, vat_applicable, subtotal, vat_amount, total, inv.id]
    );
    if (lines) {
      await client.query('DELETE FROM invoice_lines WHERE invoice_id=$1', [inv.id]);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO invoice_lines (invoice_id,description,account_code,quantity,unit_price,line_total,line_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [inv.id, l.description || '', l.account_code || '', Number(l.quantity || 1),
           Number(l.unit_price || 0), Number(l.line_total || 0), i]
        );
      }
    }
    return rows[0];
  });
  res.json(updated);
}));

// POST /api/invoices/:id/post — creates DR AR / CR Revenue + VAT journal
router.post('/:id/post', asyncHandler(async (req, res) => {
  const { rows: [inv] } = await pool.query(
    `SELECT i.*, c.name AS customer_name FROM invoices i
     JOIN customers c ON c.id=i.customer_id WHERE i.id=$1`, [req.params.id]
  );
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'Invoice already posted or voided' });

  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_order', [inv.id]
  );

  const result = await withTransaction(async (client) => {
    const s = await getSettings(client);
    const arAcc  = s.arAcc  || '1100';
    const revAcc = s.revAcc || '6000';
    const vatOut = s.vatOut || '3100';

    // pg returns NUMERIC as strings — coerce everything to Number first
    const invTotal  = Number(inv.total);
    const invVat    = Number(inv.vat_amount);

    const journalLines = [];
    // DR Accounts Receivable (total)
    journalLines.push({ account_code: arAcc, debit: invTotal, credit: 0, narration: `AR - ${inv.invoice_number}` });
    // CR Revenue per line
    for (const l of lines) {
      const acc = l.account_code || revAcc;
      journalLines.push({ account_code: acc, debit: 0, credit: Number(l.line_total), narration: l.description });
    }
    // CR VAT Output
    if (invVat > 0) {
      journalLines.push({ account_code: vatOut, debit: 0, credit: invVat, narration: 'Output VAT' });
    }

    const totalDr = journalLines.reduce((sum, l) => sum + l.debit,  0);
    const totalCr = journalLines.reduce((sum, l) => sum + l.credit, 0);

    const { rows: [j] } = await client.query(
      `INSERT INTO journals (date,reference,description,type,status,total_dr,total_cr,posted_by,posted_at,created_by)
       VALUES ($1,$2,$3,'invoice','posted',$4,$5,$6,NOW(),$6) RETURNING *`,
      [inv.date, inv.invoice_number, `Invoice - ${inv.customer_name}`, totalDr, totalCr, req.user.username]
    );
    for (let i = 0; i < journalLines.length; i++) {
      const l = journalLines[i];
      await client.query(
        `INSERT INTO journal_lines (journal_id,account_code,narration,debit,credit,line_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [j.id, l.account_code, l.narration, l.debit, l.credit, i]
      );
    }
    const { rows } = await client.query(
      `UPDATE invoices SET status='posted', journal_id=$1, posted_by=$2, posted_at=NOW(), updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [j.id, req.user.username, inv.id]
    );
    return rows[0];
  });

  await logAudit({ action: 'POST', entity: 'invoices', entityId: inv.id,
    description: `Posted invoice ${inv.invoice_number}`, performedBy: req.user.username, ip: req.ip });
  res.json(result);
}));

// POST /api/invoices/:id/void
router.post('/:id/void', asyncHandler(async (req, res) => {
  const { rows: [inv] } = await pool.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status === 'voided') return res.status(400).json({ error: 'Already voided' });

  await withTransaction(async (client) => {
    if (inv.journal_id) {
      await client.query(
        `UPDATE journals SET status='voided', voided_by=$1, voided_at=NOW(), void_reason='Invoice voided', updated_at=NOW() WHERE id=$2`,
        [req.user.username, inv.journal_id]
      );
    }
    await client.query(
      `UPDATE invoices SET status='voided', updated_at=NOW() WHERE id=$1`, [inv.id]
    );
  });
  res.json({ message: 'Invoice voided' });
}));

// DELETE /api/invoices/:id (draft only)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { rows: [inv] } = await pool.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be deleted' });
  await pool.query('DELETE FROM invoices WHERE id=$1', [inv.id]);
  res.json({ message: 'Invoice deleted' });
}));

module.exports = router;
