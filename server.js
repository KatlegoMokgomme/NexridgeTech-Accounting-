'use strict';

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

// ── Routes ────────────────────────────────────────────────────────
const authRoutes     = require('./src/routes/auth');
const userRoutes     = require('./src/routes/users');
const accountRoutes  = require('./src/routes/accounts');
const journalRoutes  = require('./src/routes/journals');
const customerRoutes = require('./src/routes/customers');
const invoiceRoutes  = require('./src/routes/invoices');
const receiptRoutes  = require('./src/routes/receipts');
const supplierRoutes = require('./src/routes/suppliers');
const billRoutes     = require('./src/routes/bills');
const paymentRoutes  = require('./src/routes/payments');
const bankRoutes     = require('./src/routes/banks');
const bankTxRoutes   = require('./src/routes/bankTransactions');
const assetRoutes    = require('./src/routes/assets');
const reportRoutes   = require('./src/routes/reports');
const settingsRoutes = require('./src/routes/settings');
const auditRoutes    = require('./src/routes/audit');

const { errorHandler } = require('./src/middleware/errorHandler');

const app = express();

// ── Security ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin        : process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : '*',
  methods       : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ─────────────────────────────────────────────────
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
app.use('/api/', rateLimit({
  windowMs, max: Number(process.env.RATE_LIMIT_MAX) || 300,
  standardHeaders: true, legacyHeaders: false,
}));
app.use('/api/auth/login', rateLimit({
  windowMs, max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  message: { error: 'Too many login attempts. Please try again later.' },
}));

// ── Body parsing ──────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ───────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') app.use(morgan('combined'));

// ── Health check ──────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const { pool } = require('./src/db');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected' });
  }
});

// ── API routes ────────────────────────────────────────────────────
app.use('/api/auth',              authRoutes);
app.use('/api/users',             userRoutes);
app.use('/api/accounts',          accountRoutes);
app.use('/api/journals',          journalRoutes);
app.use('/api/customers',         customerRoutes);
app.use('/api/invoices',          invoiceRoutes);
app.use('/api/receipts',          receiptRoutes);
app.use('/api/suppliers',         supplierRoutes);
app.use('/api/bills',             billRoutes);
app.use('/api/payments',          paymentRoutes);
app.use('/api/banks',             bankRoutes);
app.use('/api/bank-transactions', bankTxRoutes);
app.use('/api/assets',            assetRoutes);
app.use('/api/reports',           reportRoutes);
app.use('/api/settings',          settingsRoutes);
app.use('/api/audit',             auditRoutes);

// ── 404 ───────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ──────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () =>
    console.log(`🚀  NRT Finance API  →  http://localhost:${PORT}  [${process.env.NODE_ENV || 'development'}]`)
  );
}

module.exports = app;
