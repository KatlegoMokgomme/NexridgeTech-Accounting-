# NRT Finance API

Enterprise double-entry accounting REST API built with **Node.js**, **Express**, and **PostgreSQL**.

Covers the full AR/AP cycle, bank reconciliation, fixed assets, VAT, and eight financial reports — all behind JWT authentication with role-based access control.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Authentication](#authentication)
- [Roles & Permissions](#roles--permissions)
- [API Reference](#api-reference)
  - [Health](#health)
  - [Auth](#auth)
  - [Users](#users)
  - [Chart of Accounts](#chart-of-accounts)
  - [Journals](#journals)
  - [Customers](#customers)
  - [Invoices](#invoices)
  - [Receipts](#receipts)
  - [Suppliers](#suppliers)
  - [Bills (AP)](#bills-ap)
  - [Payments](#payments)
  - [Bank Accounts](#bank-accounts)
  - [Bank Transactions](#bank-transactions)
  - [Fixed Assets](#fixed-assets)
  - [Financial Reports](#financial-reports)
  - [Settings](#settings)
  - [Audit Log](#audit-log)
- [Auto-Journal Logic](#auto-journal-logic)
- [Default Chart of Accounts](#default-chart-of-accounts)
- [Default Settings](#default-settings)
- [Project Structure](#project-structure)
- [Error Handling](#error-handling)
- [Production Notes](#production-notes)

---

## Quick Start

### Option A — Automated setup (recommended)

```bash
git clone <repo-url> nrt-api && cd nrt-api
chmod +x setup.sh
./setup.sh
```

`setup.sh` will:
1. Verify Node.js ≥ 18
2. Run `npm ci`
3. Generate `.env` with fresh random JWT secrets (prompts for DB password)
4. Create the PostgreSQL role and database if reachable as a superuser
5. Apply `schema.sql` (tables, indexes, seeds)

Then start the server:

```bash
npm run dev    # development — auto-reload with nodemon
npm start      # production
```

### Option B — Manual setup

```bash
# 1. Install dependencies
npm ci

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in DB_PASSWORD, JWT_SECRET, REFRESH_SECRET

# 3. Create the PostgreSQL database (as a superuser)
psql -U postgres -c "CREATE USER nrt_user WITH PASSWORD 'yourpass' CREATEDB;"
psql -U postgres -c "CREATE DATABASE nrt_finance OWNER nrt_user;"

# 4. Apply the schema
psql -U nrt_user -d nrt_finance -f schema.sql

# 5. Start
npm run dev
```

**Health check:** `GET http://localhost:3000/health`  
**Default admin:** `admin` / `Admin@123` — change this immediately after first login.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in every value before starting.

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | `development` \| `production` \| `test` | `development` |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_NAME` | Database name | `nrt_finance` |
| `DB_USER` | Database user | `nrt_user` |
| `DB_PASSWORD` | Database password | — |
| `DB_SSL` | Enable SSL (`true`/`false`) | `false` |
| `JWT_SECRET` | Access-token signing secret (min 32 chars) | — |
| `JWT_EXPIRES_IN` | Access token lifetime | `15m` |
| `REFRESH_SECRET` | Refresh-token signing secret (different from JWT_SECRET) | — |
| `REFRESH_EXPIRES_IN` | Refresh token lifetime | `7d` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | `*` |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit window in ms | `900000` |
| `RATE_LIMIT_MAX` | Max requests per window per IP on `/api/*` | `300` |
| `AUTH_RATE_LIMIT_MAX` | Stricter limit on `/api/auth/login` | `20` |

Generate strong secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Authentication

All `/api/*` routes except `POST /api/auth/login` require a Bearer token:

```
Authorization: Bearer <accessToken>
```

**Token flow:**

```
1. POST /api/auth/login       → { accessToken (15 min), refreshToken (7 days) }
2. Access token expires       → POST /api/auth/refresh  { refreshToken }  → { accessToken }
3. Done for the day           → POST /api/auth/logout   { refreshToken }
```

Refresh tokens are stored in the database. They are revoked on logout and on user deactivation. Expired tokens for a user are pruned automatically on each new login.

---

## Roles & Permissions

| Role | Description |
|---|---|
| `admin` | Full access including user management and settings changes |
| `accountant` | Full access to all financial data; cannot manage users or change settings |
| `user` | Read-only; can view their own profile |

Role is encoded in the JWT payload and enforced per-route. Attempts to call an admin-only route with a lower role return `403 Forbidden`.

---

## API Reference

All request and response bodies are JSON. Timestamps are ISO 8601. UUIDs are used for all primary keys.

### Health

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Returns `{ status, db, ts }`. Status is `ok` when DB is reachable, `degraded` otherwise. |

---

### Auth

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | None | Login → `{ accessToken, refreshToken, user }` |
| POST | `/api/auth/refresh` | None | Exchange refresh token → `{ accessToken }` |
| POST | `/api/auth/logout` | Bearer | Revoke refresh token |
| GET | `/api/auth/me` | Bearer | Current user profile (no password hash) |
| POST | `/api/auth/change-password` | Bearer | Change own password |

**Login body:**
```json
{ "username": "admin", "password": "Admin@123" }
```

**Change password body:**
```json
{ "currentPassword": "Admin@123", "newPassword": "NewPass99!" }
```

---

### Users

All routes require Bearer token. Write operations require `admin` role.

| Method | Endpoint | Role | Description |
|---|---|---|---|
| GET | `/api/users` | admin | List all users. Filter: `?active=true&role=accountant` |
| POST | `/api/users` | admin | Create user |
| GET | `/api/users/:id` | admin or self | Get user by ID |
| PUT | `/api/users/:id` | admin | Update `full_name`, `role`, `active` |
| DELETE | `/api/users/:id` | admin | Deactivate user (soft delete, revokes tokens). Cannot deactivate yourself. |
| POST | `/api/users/:id/reset-password` | admin | Set new password, revokes all existing tokens |

**Create / reset body:**
```json
{
  "username": "jane",
  "password": "Secure99!",
  "full_name": "Jane Smith",
  "role": "accountant"
}
```

**Roles accepted:** `admin`, `accountant`, `user`

---

### Chart of Accounts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/accounts` | List accounts. Filter: `?type=ASSET&active=true` |
| POST | `/api/accounts` | Create account |
| GET | `/api/accounts/:id` | Get account by ID |
| PUT | `/api/accounts/:id` | Update account |
| DELETE | `/api/accounts/:id` | Deactivate account (soft delete) |
| GET | `/api/accounts/:code/ledger` | Posted journal lines for this account code. Filter: `?from=&to=` |

**Account types:** `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `COS`, `EXPENSE`

**Create body:**
```json
{
  "code": "6200",
  "name": "Subscription Revenue",
  "type": "REVENUE",
  "sub_type": "Recurring",
  "description": "Monthly SaaS subscriptions"
}
```

---

### Journals

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/journals` | List journals. Filter: `?status=posted&type=general&from=&to=` |
| POST | `/api/journals` | Create journal (validates DR = CR) |
| GET | `/api/journals/:id` | Get journal with its lines |
| PUT | `/api/journals/:id` | Update draft journal |
| POST | `/api/journals/:id/post` | Post draft journal |
| POST | `/api/journals/:id/void` | Void any non-voided journal |
| POST | `/api/journals/:id/reverse` | Create a mirrored reversal draft from a posted journal |
| DELETE | `/api/journals/:id` | Delete draft journal |

**Journal statuses:** `draft` → `posted` → `voided`

Only `draft` journals can be edited or deleted. Only `posted` journals can be reversed.

**Create body:**
```json
{
  "date": "2026-07-01",
  "reference": "JNL-001",
  "description": "Opening entry",
  "type": "general",
  "lines": [
    { "account_code": "1000", "debit": 50000, "credit": 0, "narration": "Cash at bank" },
    { "account_code": "4000", "debit": 0, "credit": 50000, "narration": "Share capital" }
  ]
}
```

The API rejects the journal if `SUM(debit) ≠ SUM(credit)`.

**Reverse body (optional):**
```json
{ "date": "2026-08-01", "reason": "Posted in wrong period" }
```

---

### Customers

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/customers` | List customers. Filter: `?active=true&search=acme` |
| POST | `/api/customers` | Create customer |
| GET | `/api/customers/:id` | Get customer |
| PUT | `/api/customers/:id` | Update customer |
| DELETE | `/api/customers/:id` | Deactivate customer |
| GET | `/api/customers/:id/invoices` | All invoices for this customer |
| GET | `/api/customers/:id/receipts` | All receipts for this customer |

**Create body:**
```json
{
  "code": "CUST001",
  "name": "Acme Corp",
  "contact": "John Doe",
  "email": "john@acme.com",
  "phone": "+27 11 000 0000",
  "vat_number": "4120123456",
  "payment_terms": 30,
  "credit_limit": 100000,
  "address": "1 Main St, Johannesburg"
}
```

---

### Invoices

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/invoices` | List invoices. Filter: `?customer_id=&status=posted&from=&to=` |
| POST | `/api/invoices` | Create invoice (draft) |
| GET | `/api/invoices/:id` | Get invoice with lines, `balance`, and `paid` amount |
| PUT | `/api/invoices/:id` | Update draft invoice |
| POST | `/api/invoices/:id/post` | Post invoice → auto-creates DR AR / CR Revenue + VAT journal |
| POST | `/api/invoices/:id/void` | Void invoice (also voids linked journal) |
| DELETE | `/api/invoices/:id` | Delete draft invoice |

**Invoice statuses:** `draft` → `posted` → `voided`

**Create body:**
```json
{
  "customer_id": "<uuid>",
  "date": "2026-07-01",
  "invoice_number": "INV-001",
  "due_date": "2026-07-31",
  "reference": "PO-999",
  "vat_applicable": true,
  "lines": [
    {
      "description": "Consulting services",
      "account_code": "6000",
      "quantity": 2,
      "unit_price": 5000,
      "line_total": 10000
    }
  ]
}
```

VAT is calculated automatically from the `vatRate` setting (default 15%). `line_total` must equal `quantity × unit_price`.

The `GET /:id` response includes computed fields:
```json
{
  "total": 11500,
  "paid": 11500,
  "balance": 0,
  "lines": [...]
}
```

---

### Receipts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/receipts` | List receipts. Filter: `?customer_id=&from=&to=` |
| POST | `/api/receipts` | Create receipt → auto-creates DR Bank / CR AR journal (posted immediately) |
| GET | `/api/receipts/:id` | Get receipt |
| DELETE | `/api/receipts/:id` | Delete receipt and void its journal |

**Create body:**
```json
{
  "reference_number": "REC-001",
  "date": "2026-07-15",
  "customer_id": "<uuid>",
  "invoice_id": "<uuid>",
  "bank_id": "<uuid>",
  "amount": 11500,
  "method": "EFT",
  "reference": "Ref on bank statement"
}
```

`invoice_id` is optional but should be provided when paying a specific invoice so the balance is tracked correctly.

---

### Suppliers

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/suppliers` | List suppliers. Filter: `?active=true&search=depot` |
| POST | `/api/suppliers` | Create supplier |
| GET | `/api/suppliers/:id` | Get supplier |
| PUT | `/api/suppliers/:id` | Update supplier |
| DELETE | `/api/suppliers/:id` | Deactivate supplier |
| GET | `/api/suppliers/:id/bills` | All bills for this supplier |

---

### Bills (AP)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/bills` | List bills. Filter: `?supplier_id=&status=draft&from=&to=` |
| POST | `/api/bills` | Create bill (draft) |
| GET | `/api/bills/:id` | Get bill with lines, `balance`, and `paid` amount |
| PUT | `/api/bills/:id` | Update draft bill |
| POST | `/api/bills/:id/post` | Post bill → auto-creates DR Expense + VAT / CR AP journal |
| POST | `/api/bills/:id/void` | Void bill (also voids linked journal) |
| DELETE | `/api/bills/:id` | Delete draft bill |

Structure mirrors invoices. `vat_applicable` and `lines[].account_code` work the same way.

---

### Payments

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/payments` | List payments. Filter: `?supplier_id=&from=&to=` |
| POST | `/api/payments` | Create payment → auto-creates DR AP / CR Bank journal (posted immediately) |
| GET | `/api/payments/:id` | Get payment |
| DELETE | `/api/payments/:id` | Delete payment and void its journal |

**Create body:**
```json
{
  "reference_number": "PAY-001",
  "date": "2026-07-20",
  "supplier_id": "<uuid>",
  "bill_id": "<uuid>",
  "bank_id": "<uuid>",
  "amount": 9200,
  "method": "EFT",
  "reference": "Internet banking ref"
}
```

---

### Bank Accounts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/banks` | List bank accounts with live balance |
| POST | `/api/banks` | Create bank account |
| GET | `/api/banks/:id` | Get bank account with live balance |
| PUT | `/api/banks/:id` | Update bank account |
| DELETE | `/api/banks/:id` | Delete bank account (only if no transactions) |
| GET | `/api/banks/:id/statement` | Transactions with running balance. Filter: `?from=&to=` |

**Create body:**
```json
{
  "name": "FNB Business Cheque",
  "bank": "First National Bank",
  "account_number": "62012345678",
  "branch_code": "250655",
  "account_type": "Cheque",
  "ledger_account_code": "1000",
  "opening_balance": 50000
}
```

`ledger_account_code` must match an account code in the chart of accounts. The live balance is `opening_balance + SUM(credits) − SUM(debits)` across all linked bank transactions.

---

### Bank Transactions

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/bank-transactions` | List transactions. Filter: `?bank_id=&reconciled=false&from=&to=` |
| POST | `/api/bank-transactions` | Create transaction (optionally auto-creates journal) |
| GET | `/api/bank-transactions/:id` | Get transaction |
| PATCH | `/api/bank-transactions/:id/reconcile` | Toggle reconciled flag |
| PATCH | `/api/bank-transactions/reconcile-bulk` | Bulk set reconciled on a list of IDs |
| DELETE | `/api/bank-transactions/:id` | Delete unreconciled transaction |

**Create body:**
```json
{
  "bank_id": "<uuid>",
  "date": "2026-07-01",
  "description": "Interest received",
  "amount": 1250,
  "type": "credit",
  "contra_account_code": "6100",
  "reference_number": "STMT-REF",
  "create_journal": true
}
```

Set `create_journal: true` and provide `contra_account_code` to have the API automatically post a balanced journal alongside the transaction.

**Bulk reconcile body:**
```json
{ "ids": ["<uuid>", "<uuid>"], "reconciled": true }
```

---

### Fixed Assets

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/assets` | List assets. Filter: `?status=active` |
| POST | `/api/assets` | Create asset |
| GET | `/api/assets/:id` | Get asset with depreciation history, `accumulated_depreciation`, and `net_book_value` |
| PUT | `/api/assets/:id` | Update asset |
| DELETE | `/api/assets/:id` | Mark asset as `disposed` |
| POST | `/api/assets/:id/depreciate` | Run a depreciation period → posts DR Dep Expense / CR Accum. Dep journal |
| GET | `/api/assets/:id/schedule` | Projected remaining depreciation schedule |

**Create body:**
```json
{
  "code": "VEH001",
  "name": "Company Vehicle",
  "category": "Motor Vehicles",
  "acquisition_date": "2025-01-01",
  "cost": 250000,
  "residual_value": 25000,
  "depreciation_method": "SL",
  "useful_life_years": 5,
  "ledger_account_code": "1500"
}
```

**Depreciation methods:**
- `SL` — Straight Line: `(cost − residual) ÷ useful_life_years ÷ 12` per month
- `DB` — Declining Balance: rate calculated as `1 − (residual/cost)^(1/years)`, applied to book value

**Depreciate body:**
```json
{ "period_end": "2026-06-30" }
```

Each call posts one period. Call once per month (or quarter). The schedule endpoint shows how many periods remain.

---

### Financial Reports

All report endpoints are `GET` and require a Bearer token.

| Endpoint | Query Params | Description |
|---|---|---|
| `/api/reports/trial-balance` | `as_at` | Debit/credit totals per account up to a date |
| `/api/reports/income-statement` | `from`, `to` | Revenue, COS, expenses, gross profit, net profit |
| `/api/reports/balance-sheet` | `as_at` | Assets, liabilities, equity as at a date |
| `/api/reports/general-ledger` | `from`, `to`, `account_code` | All posted journal lines, optionally filtered to one account |
| `/api/reports/ar-aging` | `as_at` | Outstanding invoices bucketed: current / 1–30 / 31–60 / 61–90 / 90+ days |
| `/api/reports/ap-aging` | `as_at` | Outstanding bills bucketed the same way |
| `/api/reports/vat` | `from`, `to` | Output VAT, input VAT, net VAT payable |
| `/api/reports/cash-flow` | `from`, `to` | Cash receipts, cash payments, net cash flow |

**Date format:** `YYYY-MM-DD`. All dates are optional — omitting them returns all-time data.

**Example — trial balance:**
```
GET /api/reports/trial-balance?as_at=2026-06-30
```
```json
{
  "as_at": "2026-06-30",
  "total_dr": 185000.00,
  "total_cr": 185000.00,
  "accounts": [
    { "code": "1000", "name": "Bank / Cash", "type": "ASSET", "total_dr": 150000, "total_cr": 0, "net": 150000 },
    ...
  ]
}
```

---

### Settings

Company-wide configuration stored in the database. All reads are open to any authenticated user; writes require `admin`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/settings` | All settings as `{ key: value }` object |
| GET | `/api/settings/:key` | Single setting |
| PUT | `/api/settings` | Update one or more settings (admin only) |

**Update body:**
```json
{
  "companyName": "NRT Finance Ltd",
  "vatRate": "15",
  "currencySymbol": "R"
}
```

---

### Audit Log

Immutable append-only log. Every create, update, delete, post, void, login, and logout is recorded automatically.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/audit` | Query log. Filter: `?from=&to=&action=LOGIN&entity=invoices&performed_by=admin` |
| GET | `/api/audit/:id` | Single audit entry |

Results default to the most recent 200 entries (max 1000 per request).

---

## Auto-Journal Logic

When you post an invoice, bill, receipt, payment, or depreciation run, the API creates and immediately posts a balanced journal automatically. You never need to create these journals manually.

| Transaction | Debit (DR) | Credit (CR) |
|---|---|---|
| Post Invoice | Accounts Receivable (`arAcc`) | Revenue line accounts + Output VAT (`vatOut`) |
| Post Bill | Expense line accounts + Input VAT (`vatIn`) | Accounts Payable (`apAcc`) |
| Create Receipt | Bank (`ledger_account_code`) | Accounts Receivable (`arAcc`) |
| Create Payment | Accounts Payable (`apAcc`) | Bank (`ledger_account_code`) |
| Run Depreciation | Depreciation Expense (`7100`) | Accum. Depreciation (`1600`) |

The account codes used for AR, AP, VAT, and revenue are read from **Settings** at the time of posting, so you can redirect them without touching code.

---

## Default Chart of Accounts

Seeded automatically by `schema.sql`. You can add, rename, or deactivate accounts via the `/api/accounts` endpoints.

| Code | Name | Type |
|---|---|---|
| 1000 | Bank / Cash | ASSET |
| 1100 | Accounts Receivable | ASSET |
| 1200 | Inventory | ASSET |
| 1300 | Prepaid Expenses | ASSET |
| 1400 | VAT Input (Claimable) | ASSET |
| 1500 | Fixed Assets – Cost | ASSET |
| 1600 | Accum. Depreciation | ASSET |
| 3000 | Accounts Payable | LIABILITY |
| 3100 | VAT Output (Payable) | LIABILITY |
| 3200 | Income Tax Payable | LIABILITY |
| 3300 | Accrued Expenses | LIABILITY |
| 3900 | Long-Term Loan | LIABILITY |
| 4000 | Share Capital | EQUITY |
| 4100 | Retained Earnings | EQUITY |
| 5000 | Cost of Goods Sold | COS |
| 6000 | Sales Revenue | REVENUE |
| 6100 | Other Income | REVENUE |
| 7000 | Salaries & Wages | EXPENSE |
| 7010 | Rent | EXPENSE |
| 7020 | Utilities | EXPENSE |
| 7030 | Office Supplies | EXPENSE |
| 7040 | Travel & Entertainment | EXPENSE |
| 7050 | Marketing & Advertising | EXPENSE |
| 7060 | Professional Fees | EXPENSE |
| 7070 | Insurance | EXPENSE |
| 7080 | Telephone & Internet | EXPENSE |
| 7090 | Bank Charges | EXPENSE |
| 7100 | Depreciation Expense | EXPENSE |
| 7110 | Interest Expense | EXPENSE |
| 7900 | Miscellaneous Expense | EXPENSE |

---

## Default Settings

| Key | Default Value | Description |
|---|---|---|
| `companyName` | NexridgeTech IT Solutions | Used in reports |
| `regNo` | _(empty)_ | Company registration number |
| `vatNo` | _(empty)_ | VAT registration number |
| `address` | _(empty)_ | Company address |
| `vatRate` | `15` | VAT percentage applied to invoices and bills |
| `terms` | `30` | Default payment terms in days |
| `arAcc` | `1100` | Accounts Receivable account code |
| `apAcc` | `3000` | Accounts Payable account code |
| `revAcc` | `6000` | Default revenue account code |
| `vatOut` | `3100` | Output VAT account code |
| `vatIn` | `1400` | Input VAT account code |
| `bankAcc` | `1000` | Default bank/cash account code |
| `currencySymbol` | `R` | Display currency symbol |
| `financialYearStart` | `03-01` | Financial year start (MM-DD) |

---

## Project Structure

```
nrt-api/
├── server.js                   # Entry point — Express app, middleware, route mounting
├── schema.sql                  # PostgreSQL DDL + seed data (run once on a fresh DB)
├── setup.sh                    # First-time install script
├── .env.example                # Environment variable template
├── package.json
└── src/
    ├── db/
    │   └── index.js            # pg connection pool + withTransaction() helper
    ├── middleware/
    │   ├── auth.js             # JWT authenticate() + requireRole()
    │   ├── audit.js            # logAudit() — non-blocking audit writer
    │   └── errorHandler.js     # asyncHandler wrapper + global error handler
    └── routes/
        ├── auth.js             # Login, refresh, logout, me, change-password
        ├── users.js            # User management (admin)
        ├── accounts.js         # Chart of accounts + ledger
        ├── journals.js         # Manual journals + post/void/reverse
        ├── customers.js        # AR customers
        ├── invoices.js         # AR invoices + auto-journal on post
        ├── receipts.js         # Cash receipts + auto-journal
        ├── suppliers.js        # AP suppliers
        ├── bills.js            # AP bills + auto-journal on post
        ├── payments.js         # AP payments + auto-journal
        ├── banks.js            # Bank accounts + statement
        ├── bankTransactions.js # Bank transactions + reconciliation
        ├── assets.js           # Fixed assets + depreciation
        ├── reports.js          # Eight financial reports
        ├── settings.js         # Company settings
        └── audit.js            # Audit log queries
```

---

## Error Handling

All errors return JSON in a consistent shape:

```json
{ "error": "Human-readable message" }
```

Validation errors (from `express-validator`) return:

```json
{
  "errors": [
    { "msg": "Valid date required", "path": "date", "location": "body" }
  ]
}
```

| HTTP Status | Meaning |
|---|---|
| `200` | Success |
| `201` | Resource created |
| `400` | Bad request (invalid input, business rule violation) |
| `401` | Missing or invalid/expired token |
| `403` | Authenticated but insufficient role |
| `404` | Resource not found |
| `409` | Conflict (duplicate unique value) |
| `503` | Database unavailable (health check only) |

---

## Production Notes

**Secrets** — Use environment variable injection (Docker secrets, AWS Parameter Store, etc.). Never commit `.env`.

**SSL** — Set `DB_SSL=true` when connecting to managed Postgres (Neon, Supabase, RDS). Add `NODE_TLS_REJECT_UNAUTHORIZED=0` only if using a self-signed cert in a trusted environment.

**CORS** — Set `ALLOWED_ORIGINS` to your frontend domain(s) only. Do not leave it as `*` in production.

**Process manager** — Run behind `pm2` or as a systemd service. The server does not daemonize itself.

**Rate limits** — The defaults (300 req / 15 min globally, 20 req / 15 min on login) are suitable for a single-tenant internal app. Adjust `RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_MAX` for higher-traffic deployments.

**Reverse proxy** — When running behind nginx or a load balancer, add `app.set('trust proxy', 1)` to `server.js` so that `req.ip` reflects the real client IP in rate limiting and audit logs.

**Database backups** — `schema.sql` is idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) and safe to re-run. Schedule `pg_dump` at least daily.

**Admin password** — The seed creates `admin` / `Admin@123`. Reset it immediately:
```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin@123"}' \
  | jq -r '.accessToken'

# Then:
curl -X POST http://localhost:3000/api/auth/change-password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"Admin@123","newPassword":"YourStrongPassword!"}'
```
