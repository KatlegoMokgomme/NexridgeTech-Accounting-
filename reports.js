'use strict';

const express = require('express');
const { pool }         = require('../db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();
router.use(authenticate);

// Helper: get all account balances (posted journals only) up to a date.
// Drives from journal_lines so accounts used in journals but not yet added
// to the accounts table never silently disappear from reports.
async function accountBalances(asAt) {
  const { rows } = await pool.query(`
    SELECT
      jl.account_code                          AS code,
      COALESCE(a.name, jl.account_code)        AS name,
      COALESCE(a.type, 'UNKNOWN')              AS type,
      COALESCE(a.sub_type, '')                 AS sub_type,
      SUM(jl.debit)                            AS total_dr,
      SUM(jl.credit)                           AS total_cr,
      SUM(jl.debit) - SUM(jl.credit)          AS net
    FROM journal_lines jl
    JOIN journals j ON j.id = jl.journal_id AND j.status = 'posted'
      ${asAt ? 'AND j.date <= $1' : ''}
    LEFT JOIN accounts a ON a.code = jl.account_code
    GROUP BY jl.account_code, a.name, a.type, a.sub_type
    -- Also include active accounts with zero activity so the full CoA is always visible
    UNION ALL
    SELECT
      a.code, a.name, a.type, a.sub_type,
      0 AS total_dr, 0 AS total_cr, 0 AS net
    FROM accounts a
    WHERE a.active = true
      AND a.code NOT IN (
        SELECT DISTINCT jl2.account_code
        FROM journal_lines jl2
        JOIN journals j2 ON j2.id = jl2.journal_id AND j2.status = 'posted'
          ${asAt ? 'AND j2.date <= $1' : ''}
      )
    ORDER BY code
  `, asAt ? [asAt] : []);
  return rows;
}

// GET /api/reports/trial-balance?as_at=YYYY-MM-DD
router.get('/trial-balance', asyncHandler(async (req, res) => {
  const { as_at } = req.query;
  const rows = await accountBalances(as_at);
  const totalDr = rows.reduce((s, r) => s + Number(r.total_dr), 0);
  const totalCr = rows.reduce((s, r) => s + Number(r.total_cr), 0);
  res.json({ as_at: as_at || 'current', accounts: rows, total_dr: +totalDr.toFixed(2), total_cr: +totalCr.toFixed(2) });
}));

// GET /api/reports/income-statement?from=&to=
router.get('/income-statement', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await pool.query(`
    SELECT
      jl.account_code                                          AS code,
      COALESCE(a.name, jl.account_code)                       AS name,
      COALESCE(a.type, 'UNKNOWN')                             AS type,
      COALESCE(a.sub_type, '')                                AS sub_type,
      SUM(jl.credit) - SUM(jl.debit)                         AS balance
    FROM journal_lines jl
    JOIN journals j ON j.id = jl.journal_id AND j.status = 'posted'
      AND ($1::date IS NULL OR j.date >= $1)
      AND ($2::date IS NULL OR j.date <= $2)
    LEFT JOIN accounts a ON a.code = jl.account_code
    WHERE COALESCE(a.type, '') IN ('REVENUE', 'COS', 'EXPENSE')
    GROUP BY jl.account_code, a.name, a.type, a.sub_type
    ORDER BY a.type, jl.account_code
  `, [from || null, to || null]);

  const revenue  = rows.filter(r => r.type === 'REVENUE');
  const cos      = rows.filter(r => r.type === 'COS');
  const expense  = rows.filter(r => r.type === 'EXPENSE');
  const totalRev = revenue.reduce((s, r) => s + Number(r.balance), 0);
  const totalCos = cos.reduce((s, r) => s + Number(r.balance), 0);
  const totalExp = expense.reduce((s, r) => s + Number(r.balance), 0);
  const grossProfit = totalRev - totalCos;
  const netProfit   = grossProfit - totalExp;

  res.json({ from, to, revenue, cos, expense, total_revenue: +totalRev.toFixed(2),
    total_cos: +totalCos.toFixed(2), gross_profit: +grossProfit.toFixed(2),
    total_expenses: +totalExp.toFixed(2), net_profit: +netProfit.toFixed(2) });
}));

// GET /api/reports/balance-sheet?as_at=
router.get('/balance-sheet', asyncHandler(async (req, res) => {
  const { as_at } = req.query;
  const rows = await accountBalances(as_at);

  const assets      = rows.filter(r => r.type === 'ASSET');
  const liabilities = rows.filter(r => r.type === 'LIABILITY');
  const equity      = rows.filter(r => r.type === 'EQUITY');

  // Net profit from income statement is part of retained earnings
  const { rows: pl } = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN a.type='REVENUE' THEN jl.credit - jl.debit
                             WHEN a.type IN ('COS','EXPENSE') THEN jl.debit - jl.credit
                             ELSE 0 END), 0) AS net_profit
    FROM journal_lines jl
    JOIN journals j ON j.id=jl.journal_id AND j.status='posted' ${as_at ? 'AND j.date<=$1' : ''}
    JOIN accounts a ON a.code=jl.account_code
    WHERE a.type IN ('REVENUE','COS','EXPENSE')
  `, as_at ? [as_at] : []);

  const totalAssets      = assets.reduce((s, r) => s + Number(r.net), 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + Number(r.net), 0);
  const totalEquity      = equity.reduce((s, r) => s + Number(r.net), 0);
  const netProfit        = Number(pl[0].net_profit);

  res.json({
    as_at, assets, liabilities, equity,
    total_assets: +totalAssets.toFixed(2),
    total_liabilities: +(-totalLiabilities).toFixed(2),
    total_equity: +(-totalEquity + netProfit).toFixed(2),
    net_profit: +netProfit.toFixed(2),
  });
}));

// GET /api/reports/general-ledger?from=&to=&account_code=
router.get('/general-ledger', asyncHandler(async (req, res) => {
  const { from, to, account_code } = req.query;
  let q = `
    SELECT jl.*, j.date, j.reference, j.description AS journal_description, j.type AS journal_type,
           COALESCE(a.name, jl.account_code) AS account_name,
           COALESCE(a.type, 'UNKNOWN')       AS account_type
    FROM journal_lines jl
    JOIN journals j ON j.id=jl.journal_id AND j.status='posted'
    LEFT JOIN accounts a ON a.code=jl.account_code
    WHERE 1=1
  `;
  const p = [];
  if (account_code) { p.push(account_code); q += ` AND jl.account_code=$${p.length}`; }
  if (from)         { p.push(from);         q += ` AND j.date>=$${p.length}`; }
  if (to)           { p.push(to);           q += ` AND j.date<=$${p.length}`; }
  q += ' ORDER BY jl.account_code, j.date, jl.line_order';
  const { rows } = await pool.query(q, p);
  res.json({ from, to, account_code, lines: rows });
}));

// GET /api/reports/ar-aging?as_at=
router.get('/ar-aging', asyncHandler(async (req, res) => {
  const { as_at = new Date().toISOString().slice(0, 10) } = req.query;
  const { rows } = await pool.query(`
    SELECT
      c.id, c.code, c.name,
      SUM(CASE WHEN $1::date - i.due_date <= 0  THEN i.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS current,
      SUM(CASE WHEN $1::date - i.due_date BETWEEN 1 AND 30  THEN i.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS "1_30",
      SUM(CASE WHEN $1::date - i.due_date BETWEEN 31 AND 60 THEN i.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS "31_60",
      SUM(CASE WHEN $1::date - i.due_date BETWEEN 61 AND 90 THEN i.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS "61_90",
      SUM(CASE WHEN $1::date - i.due_date > 90             THEN i.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS over_90,
      SUM(i.total - COALESCE(paid.total_paid,0)) AS total_outstanding
    FROM invoices i
    JOIN customers c ON c.id=i.customer_id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount) AS total_paid FROM receipts GROUP BY invoice_id
    ) paid ON paid.invoice_id=i.id
    WHERE i.status='posted' AND i.date <= $1
    GROUP BY c.id, c.code, c.name
    HAVING SUM(i.total - COALESCE(paid.total_paid,0)) > 0
    ORDER BY c.name
  `, [as_at]);
  res.json({ as_at, aging: rows });
}));

// GET /api/reports/ap-aging?as_at=
router.get('/ap-aging', asyncHandler(async (req, res) => {
  const { as_at = new Date().toISOString().slice(0, 10) } = req.query;
  const { rows } = await pool.query(`
    SELECT
      s.id, s.code, s.name,
      SUM(CASE WHEN $1::date - b.due_date <= 0  THEN b.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS current,
      SUM(CASE WHEN $1::date - b.due_date BETWEEN 1 AND 30  THEN b.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS "1_30",
      SUM(CASE WHEN $1::date - b.due_date BETWEEN 31 AND 60 THEN b.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS "31_60",
      SUM(CASE WHEN $1::date - b.due_date BETWEEN 61 AND 90 THEN b.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS "61_90",
      SUM(CASE WHEN $1::date - b.due_date > 90             THEN b.total - COALESCE(paid.total_paid,0) ELSE 0 END) AS over_90,
      SUM(b.total - COALESCE(paid.total_paid,0)) AS total_outstanding
    FROM bills b
    JOIN suppliers s ON s.id=b.supplier_id
    LEFT JOIN (
      SELECT bill_id, SUM(amount) AS total_paid FROM payments GROUP BY bill_id
    ) paid ON paid.bill_id=b.id
    WHERE b.status='posted' AND b.date <= $1
    GROUP BY s.id, s.code, s.name
    HAVING SUM(b.total - COALESCE(paid.total_paid,0)) > 0
    ORDER BY s.name
  `, [as_at]);
  res.json({ as_at, aging: rows });
}));

// GET /api/reports/vat?from=&to=
router.get('/vat', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const { rows: sets } = await pool.query("SELECT key, value FROM settings WHERE key IN ('vatOut','vatIn','vatRate')");
  const s = Object.fromEntries(sets.map(r => [r.key, r.value]));

  const { rows: outRows } = await pool.query(`
    SELECT COALESCE(SUM(jl.credit),0) AS output_vat
    FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id AND j.status='posted'
    WHERE jl.account_code=$1 AND ($2::date IS NULL OR j.date>=$2) AND ($3::date IS NULL OR j.date<=$3)
  `, [s.vatOut || '3100', from || null, to || null]);

  const { rows: inRows } = await pool.query(`
    SELECT COALESCE(SUM(jl.debit),0) AS input_vat
    FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id AND j.status='posted'
    WHERE jl.account_code=$1 AND ($2::date IS NULL OR j.date>=$2) AND ($3::date IS NULL OR j.date<=$3)
  `, [s.vatIn || '1400', from || null, to || null]);

  const outputVat = Number(outRows[0].output_vat);
  const inputVat  = Number(inRows[0].input_vat);
  const netVat    = outputVat - inputVat;

  res.json({ from, to, vat_rate: s.vatRate, output_vat: +outputVat.toFixed(2),
    input_vat: +inputVat.toFixed(2), net_vat_payable: +netVat.toFixed(2) });
}));

// GET /api/reports/cash-flow?from=&to=
router.get('/cash-flow', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const { rows: receiptsRows } = await pool.query(`
    SELECT COALESCE(SUM(amount),0) AS total
    FROM receipts
    WHERE ($1::date IS NULL OR date>=$1) AND ($2::date IS NULL OR date<=$2)
  `, [from || null, to || null]);

  const { rows: paymentsRows } = await pool.query(`
    SELECT COALESCE(SUM(amount),0) AS total
    FROM payments
    WHERE ($1::date IS NULL OR date>=$1) AND ($2::date IS NULL OR date<=$2)
  `, [from || null, to || null]);

  const cashIn  = Number(receiptsRows[0].total);
  const cashOut = Number(paymentsRows[0].total);

  res.json({ from, to, cash_receipts: +cashIn.toFixed(2), cash_payments: +cashOut.toFixed(2),
    net_cash_flow: +(cashIn - cashOut).toFixed(2) });
}));

module.exports = router;
