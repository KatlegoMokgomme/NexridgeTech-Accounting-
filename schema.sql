-- ══════════════════════════════════════════════════════════════════
--  NRT Finance — PostgreSQL Schema
--  Run this against your nrt_finance database if starting fresh.
--  If your DB already exists, verify column names match these
--  definitions — update the route queries if anything differs.
-- ══════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ── Users & Auth ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(100),
  role          VARCHAR(20) NOT NULL DEFAULT 'user',  -- admin | accountant | user
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT        UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Chart of Accounts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(10) UNIQUE NOT NULL,
  name        VARCHAR(150) NOT NULL,
  type        VARCHAR(20) NOT NULL,   -- ASSET | LIABILITY | EQUITY | REVENUE | COS | EXPENSE
  sub_type    VARCHAR(50)  DEFAULT '',
  description TEXT         DEFAULT '',
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Journals ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journals (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE         NOT NULL,
  reference   VARCHAR(50)  NOT NULL,
  description TEXT         DEFAULT '',
  type        VARCHAR(30)  NOT NULL DEFAULT 'general',
  status      VARCHAR(20)  NOT NULL DEFAULT 'draft',  -- draft | posted | voided
  total_dr    NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_cr    NUMERIC(15,2) NOT NULL DEFAULT 0,
  posted_by   VARCHAR(100),
  posted_at   TIMESTAMPTZ,
  voided_by   VARCHAR(100),
  voided_at   TIMESTAMPTZ,
  void_reason TEXT,
  created_by  VARCHAR(100),
  journal_id  UUID,        -- self-ref for reversal links (optional)
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id   UUID          NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_code VARCHAR(10)   NOT NULL,
  narration    TEXT          DEFAULT '',
  debit        NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit       NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_order   INTEGER       NOT NULL DEFAULT 0
);

-- ── Banking (Moved Up) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(100)  NOT NULL,
  bank                VARCHAR(100)  DEFAULT '',
  account_number      VARCHAR(50)   DEFAULT '',
  branch_code         VARCHAR(20)   DEFAULT '',
  account_type        VARCHAR(50)   DEFAULT '',
  ledger_account_code VARCHAR(10)   NOT NULL,
  opening_balance     NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id             UUID          NOT NULL REFERENCES bank_accounts(id),
  date                DATE          NOT NULL,
  description         TEXT          NOT NULL,
  amount              NUMERIC(15,2) NOT NULL,
  type                VARCHAR(10)   NOT NULL,    -- credit | debit
  contra_account_code VARCHAR(10)   DEFAULT '',
  reference           TEXT          DEFAULT '',
  reference_number    VARCHAR(50)   DEFAULT '',
  reconciled          BOOLEAN       NOT NULL DEFAULT FALSE,
  reconciled_by       VARCHAR(100),
  reconciled_at       TIMESTAMPTZ,
  journal_id          UUID          REFERENCES journals(id),
  posted_by           VARCHAR(100),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Customers (AR) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(20)  UNIQUE NOT NULL,
  name          VARCHAR(150) NOT NULL,
  contact       VARCHAR(100) DEFAULT '',
  email         VARCHAR(150) DEFAULT '',
  phone         VARCHAR(30)  DEFAULT '',
  vat_number    VARCHAR(30)  DEFAULT '',
  payment_terms INTEGER      NOT NULL DEFAULT 30,
  credit_limit  NUMERIC(15,2) NOT NULL DEFAULT 0,
  address       TEXT         DEFAULT '',
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID          NOT NULL REFERENCES customers(id),
  date           DATE          NOT NULL,
  invoice_number VARCHAR(30)   UNIQUE NOT NULL,
  due_date       DATE,
  reference      VARCHAR(100)  DEFAULT '',
  subtotal       NUMERIC(15,2) NOT NULL DEFAULT 0,
  vat_amount     NUMERIC(15,2) NOT NULL DEFAULT 0,
  total          NUMERIC(15,2) NOT NULL DEFAULT 0,
  vat_applicable BOOLEAN       NOT NULL DEFAULT TRUE,
  status         VARCHAR(20)   NOT NULL DEFAULT 'draft',  -- draft | posted | voided
  journal_id     UUID          REFERENCES journals(id),
  posted_by      VARCHAR(100),
  posted_at      TIMESTAMPTZ,
  created_by     VARCHAR(100),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   UUID          NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description  TEXT          DEFAULT '',
  account_code VARCHAR(10)   DEFAULT '',
  quantity     NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit_price   NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_order   INTEGER       NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS receipts (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number VARCHAR(30)   UNIQUE NOT NULL,
  date             DATE          NOT NULL,
  customer_id      UUID          NOT NULL REFERENCES customers(id),
  invoice_id       UUID          REFERENCES invoices(id),
  bank_id          UUID          NOT NULL REFERENCES bank_accounts(id),
  amount           NUMERIC(15,2) NOT NULL,
  method           VARCHAR(50)   DEFAULT 'EFT',
  reference        TEXT          DEFAULT '',
  journal_id       UUID          REFERENCES journals(id),
  posted_by        VARCHAR(100),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Suppliers (AP) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(20)  UNIQUE NOT NULL,
  name          VARCHAR(150) NOT NULL,
  contact       VARCHAR(100) DEFAULT '',
  email         VARCHAR(150) DEFAULT '',
  phone         VARCHAR(30)  DEFAULT '',
  vat_number    VARCHAR(30)  DEFAULT '',
  payment_terms INTEGER      NOT NULL DEFAULT 30,
  address       TEXT         DEFAULT '',
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bills (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    UUID          NOT NULL REFERENCES suppliers(id),
  date           DATE          NOT NULL,
  bill_number    VARCHAR(30)   UNIQUE NOT NULL,
  due_date       DATE,
  reference      VARCHAR(100)  DEFAULT '',
  subtotal       NUMERIC(15,2) NOT NULL DEFAULT 0,
  vat_amount     NUMERIC(15,2) NOT NULL DEFAULT 0,
  total          NUMERIC(15,2) NOT NULL DEFAULT 0,
  vat_applicable BOOLEAN       NOT NULL DEFAULT TRUE,
  status         VARCHAR(20)   NOT NULL DEFAULT 'draft',  -- draft | posted | voided
  journal_id     UUID          REFERENCES journals(id),
  posted_by      VARCHAR(100),
  posted_at      TIMESTAMPTZ,
  created_by     VARCHAR(100),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bill_lines (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id      UUID          NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  description  TEXT          DEFAULT '',
  account_code VARCHAR(10)   DEFAULT '',
  quantity     NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit_price   NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_order   INTEGER       NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number VARCHAR(30)   UNIQUE NOT NULL,
  date             DATE          NOT NULL,
  supplier_id      UUID          NOT NULL REFERENCES suppliers(id),
  bill_id          UUID          REFERENCES bills(id),
  bank_id          UUID          NOT NULL REFERENCES bank_accounts(id),
  amount           NUMERIC(15,2) NOT NULL,
  method           VARCHAR(50)   DEFAULT 'EFT',
  reference        TEXT          DEFAULT '',
  journal_id       UUID          REFERENCES journals(id),
  posted_by        VARCHAR(100),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Fixed Assets ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  code                VARCHAR(20)   UNIQUE NOT NULL,
  name                VARCHAR(150)  NOT NULL,
  category            VARCHAR(50)   DEFAULT '',
  acquisition_date    DATE          NOT NULL,
  cost                NUMERIC(15,2) NOT NULL,
  residual_value      NUMERIC(15,2) NOT NULL DEFAULT 0,
  depreciation_method VARCHAR(10)   NOT NULL DEFAULT 'SL',   -- SL | DB
  useful_life_years   INTEGER       NOT NULL,
  ledger_account_code VARCHAR(10)   DEFAULT '',
  status              VARCHAR(20)   NOT NULL DEFAULT 'active',  -- active | disposed
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asset_depreciation (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id   UUID          NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  period_end DATE          NOT NULL,
  amount     NUMERIC(15,2) NOT NULL,
  method     VARCHAR(10)   NOT NULL,
  journal_id UUID          REFERENCES journals(id),
  posted_by  VARCHAR(100),
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Settings ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(50)  PRIMARY KEY,
  value      TEXT         NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Default settings
INSERT INTO settings (key, value) VALUES
  ('companyName',        'NexridgeTech IT Solutions'),
  ('regNo',              ''),
  ('vatNo',              ''),
  ('address',            ''),
  ('vatRate',            '15'),
  ('terms',              '30'),
  ('arAcc',              '1100'),
  ('apAcc',              '3000'),
  ('revAcc',             '6000'),
  ('vatOut',             '3100'),
  ('vatIn',              '1400'),
  ('bankAcc',            '1000'),
  ('currencySymbol',     'R'),
  ('financialYearStart', '03-01')
ON CONFLICT (key) DO NOTHING;

-- ── Audit Log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  action       VARCHAR(50)  NOT NULL,
  entity       VARCHAR(50),
  entity_id    UUID,
  description  TEXT,
  performed_by VARCHAR(100),
  performed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ip_address   VARCHAR(50)
);

-- ── Indexes (performance) ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_journals_date       ON journals(date);
CREATE INDEX IF NOT EXISTS idx_journals_status     ON journals(status);
CREATE INDEX IF NOT EXISTS idx_journal_lines_jid   ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_acc   ON journal_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_invoices_customer   ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_date       ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_bills_supplier      ON bills(supplier_id);
CREATE INDEX IF NOT EXISTS idx_bills_status        ON bills(status);
CREATE INDEX IF NOT EXISTS idx_btx_bank            ON bank_transactions(bank_id);
CREATE INDEX IF NOT EXISTS idx_btx_date            ON bank_transactions(date);
CREATE INDEX IF NOT EXISTS idx_btx_reconciled      ON bank_transactions(reconciled);
CREATE INDEX IF NOT EXISTS idx_audit_entity        ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_performed_at  ON audit_log(performed_at);

-- ── Seed: default admin user ─────────────────────────────────────
-- Password: Admin@123 (bcrypt hash — change immediately after first login)
INSERT INTO users (username, password_hash, full_name, role) VALUES (
  'admin',
  '$2a$12$J8075m7R0XoPtMuaUlj9feP5GmiKp.fY15UVWhgl1fQn0zfoh.Cpq',
  'System Administrator',
  'admin'
) ON CONFLICT (username) DO NOTHING;
-- ── Seed: Default Chart of Accounts ──────────────────────────────
INSERT INTO accounts (code, name, type, sub_type) VALUES
  -- Assets
  ('1000', 'Bank / Cash',               'ASSET',     'Current'),
  ('1100', 'Accounts Receivable',        'ASSET',     'Current'),
  ('1200', 'Inventory',                  'ASSET',     'Current'),
  ('1300', 'Prepaid Expenses',           'ASSET',     'Current'),
  ('1400', 'VAT Input (Claimable)',      'ASSET',     'Current'),
  ('1500', 'Fixed Assets – Cost',        'ASSET',     'Non-Current'),
  ('1600', 'Accum. Depreciation',        'ASSET',     'Non-Current'),
  -- Liabilities
  ('3000', 'Accounts Payable',           'LIABILITY', 'Current'),
  ('3100', 'VAT Output (Payable)',       'LIABILITY', 'Current'),
  ('3200', 'Income Tax Payable',         'LIABILITY', 'Current'),
  ('3300', 'Accrued Expenses',           'LIABILITY', 'Current'),
  ('3900', 'Long-Term Loan',             'LIABILITY', 'Non-Current'),
  -- Equity
  ('4000', 'Share Capital',              'EQUITY',    ''),
  ('4100', 'Retained Earnings',          'EQUITY',    ''),
  -- Revenue
  ('6000', 'Sales Revenue',             'REVENUE',   ''),
  ('6100', 'Other Income',              'REVENUE',   ''),
  -- Cost of Sales
  ('5000', 'Cost of Goods Sold',        'COS',       ''),
  -- Expenses
  ('7000', 'Salaries & Wages',          'EXPENSE',   'Staff'),
  ('7010', 'Rent',                      'EXPENSE',   'Occupancy'),
  ('7020', 'Utilities',                 'EXPENSE',   'Occupancy'),
  ('7030', 'Office Supplies',           'EXPENSE',   'Admin'),
  ('7040', 'Travel & Entertainment',    'EXPENSE',   'Admin'),
  ('7050', 'Marketing & Advertising',   'EXPENSE',   'Admin'),
  ('7060', 'Professional Fees',         'EXPENSE',   'Admin'),
  ('7070', 'Insurance',                 'EXPENSE',   'Admin'),
  ('7080', 'Telephone & Internet',      'EXPENSE',   'Admin'),
  ('7090', 'Bank Charges',              'EXPENSE',   'Finance'),
  ('7100', 'Depreciation Expense',      'EXPENSE',   'Non-Cash'),
  ('7110', 'Interest Expense',          'EXPENSE',   'Finance'),
  ('7900', 'Miscellaneous Expense',     'EXPENSE',   'Admin')
ON CONFLICT (code) DO NOTHING;
