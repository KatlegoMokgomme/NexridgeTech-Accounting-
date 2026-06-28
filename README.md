[README.md](https://github.com/user-attachments/files/29441852/README.md)
# NRT Finance — REST API Server

Node.js + Express REST API for the NRT Enterprise Finance system.  
JWT authentication · PostgreSQL · Full double-entry accounting logic.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env

# 3. Apply schema (only if your DB doesn't already exist)
psql -U nrt_user -d nrt_finance -f schema.sql

# 4. Run in development (auto-reload)
npm run dev

# 5. Production
npm start
```

Server starts on **http://localhost:3000**  
Health check: **GET /health**

---

## Environment Variables

| Variable               | Description                                  | Default       |
|------------------------|----------------------------------------------|---------------|
| `PORT`                 | Server port                                  | `3000`        |
| `NODE_ENV`             | `development` / `production`                 | `development` |
| `DB_HOST`              | PostgreSQL host                              | `localhost`   |
| `DB_PORT`              | PostgreSQL port                              | `5432`        |
| `DB_NAME`              | Database name                                | `nrt_finance` |
| `DB_USER`              | Database user                                | `nrt_user`    |
| `DB_PASSWORD`          | Database password                            | —             |
| `DB_SSL`               | Enable SSL (`true`/`false`)                  | `false`       |
| `JWT_SECRET`           | Secret for access tokens (min 32 chars)      | —             |
| `JWT_EXPIRES_IN`       | Access token lifetime                        | `15m`         |
| `REFRESH_SECRET`       | Secret for refresh tokens                    | —             |
| `REFRESH_EXPIRES_IN`   | Refresh token lifetime                       | `7d`          |
| `ALLOWED_ORIGINS`      | Comma-separated CORS origins                 | `*`           |

---

## Authentication

All `/api/*` routes (except `/api/auth/login`) require a Bearer token:

```
Authorization: Bearer <accessToken>
```

**Flow:**
1. `POST /api/auth/login` → receive `accessToken` (15 min) + `refreshToken` (7 days)
2. When access token expires → `POST /api/auth/refresh` with `refreshToken`
3. `POST /api/auth/logout` to revoke session

**Default admin credentials** (change immediately):
- Username: `admin`
- Password: `Admin@123`

---

## API Endpoint Reference

### Auth
| Method | Endpoint                    | Description               |
|--------|-----------------------------|---------------------------|
| POST   | `/api/auth/login`           | Login → tokens            |
| POST   | `/api/auth/refresh`         | Refresh access token      |
| POST   | `/api/auth/logout`          | Revoke session            |
| GET    | `/api/auth/me`              | Current user profile      |
| POST   | `/api/auth/change-password` | Change password           |

### Chart of Accounts
| Method | Endpoint                        | Description               |
|--------|---------------------------------|---------------------------|
| GET    | `/api/accounts`                 | List (filter: type,active)|
| POST   | `/api/accounts`                 | Create account            |
| GET    | `/api/accounts/:id`             | Get account               |
| PUT    | `/api/accounts/:id`             | Update account            |
| DELETE | `/api/accounts/:id`             | Deactivate account        |
| GET    | `/api/accounts/:code/ledger`    | Account ledger            |

### Journals
| Method | Endpoint                        | Description               |
|--------|---------------------------------|---------------------------|
| GET    | `/api/journals`                 | List (filter: status,date)|
| POST   | `/api/journals`                 | Create journal            |
| GET    | `/api/journals/:id`             | Get with lines            |
| PUT    | `/api/journals/:id`             | Update (draft only)       |
| POST   | `/api/journals/:id/post`        | Post journal              |
| POST   | `/api/journals/:id/void`        | Void journal              |
| DELETE | `/api/journals/:id`             | Delete (draft only)       |

### Customers
| Method | Endpoint                        | Description               |
|--------|---------------------------------|---------------------------|
| GET    | `/api/customers`                | List                      |
| POST   | `/api/customers`                | Create customer           |
| GET    | `/api/customers/:id`            | Get customer              |
| PUT    | `/api/customers/:id`            | Update customer           |
| DELETE | `/api/customers/:id`            | Deactivate customer       |
| GET    | `/api/customers/:id/invoices`   | Customer invoices         |
| GET    | `/api/customers/:id/receipts`   | Customer receipts         |

### Invoices
| Method | Endpoint                        | Description                     |
|--------|---------------------------------|---------------------------------|
| GET    | `/api/invoices`                 | List (filter: customer,status)  |
| POST   | `/api/invoices`                 | Create invoice                  |
| GET    | `/api/invoices/:id`             | Get with lines + balance        |
| PUT    | `/api/invoices/:id`             | Update (draft only)             |
| POST   | `/api/invoices/:id/post`        | Post → auto-creates DR/CR journal|
| POST   | `/api/invoices/:id/void`        | Void invoice                    |
| DELETE | `/api/invoices/:id`             | Delete (draft only)             |

### Receipts
| Method | Endpoint                  | Description                        |
|--------|---------------------------|------------------------------------|
| GET    | `/api/receipts`           | List                               |
| POST   | `/api/receipts`           | Create → auto-creates DR Bank journal|
| GET    | `/api/receipts/:id`       | Get receipt                        |
| DELETE | `/api/receipts/:id`       | Delete (voids journal)             |

### Suppliers
| Method | Endpoint                  | Description               |
|--------|---------------------------|---------------------------|
| GET    | `/api/suppliers`          | List                      |
| POST   | `/api/suppliers`          | Create supplier           |
| GET    | `/api/suppliers/:id`      | Get supplier              |
| PUT    | `/api/suppliers/:id`      | Update supplier           |
| DELETE | `/api/suppliers/:id`      | Deactivate supplier       |
| GET    | `/api/suppliers/:id/bills`| Supplier bills            |

### Bills (AP)
| Method | Endpoint                  | Description                      |
|--------|---------------------------|----------------------------------|
| GET    | `/api/bills`              | List (filter: supplier,status)   |
| POST   | `/api/bills`              | Create bill                      |
| GET    | `/api/bills/:id`          | Get with lines + balance         |
| PUT    | `/api/bills/:id`          | Update (draft only)              |
| POST   | `/api/bills/:id/post`     | Post → auto-creates DR Exp journal|
| POST   | `/api/bills/:id/void`     | Void bill                        |
| DELETE | `/api/bills/:id`          | Delete (draft only)              |

### Payments
| Method | Endpoint                  | Description                         |
|--------|---------------------------|-------------------------------------|
| GET    | `/api/payments`           | List                                |
| POST   | `/api/payments`           | Create → auto-creates DR AP journal |
| GET    | `/api/payments/:id`       | Get payment                         |
| DELETE | `/api/payments/:id`       | Delete (voids journal)              |

### Bank Accounts
| Method | Endpoint                       | Description               |
|--------|--------------------------------|---------------------------|
| GET    | `/api/banks`                   | List with balances        |
| POST   | `/api/banks`                   | Create bank account       |
| GET    | `/api/banks/:id`               | Get with balance          |
| PUT    | `/api/banks/:id`               | Update bank account       |
| DELETE | `/api/banks/:id`               | Delete (no transactions)  |
| GET    | `/api/banks/:id/statement`     | Bank statement + running balance |

### Bank Transactions
| Method | Endpoint                                   | Description               |
|--------|--------------------------------------------|---------------------------|
| GET    | `/api/bank-transactions`                   | List (filter: bank,recon) |
| POST   | `/api/bank-transactions`                   | Create + optional journal |
| GET    | `/api/bank-transactions/:id`               | Get transaction           |
| PATCH  | `/api/bank-transactions/:id/reconcile`     | Toggle reconciled         |
| PATCH  | `/api/bank-transactions/reconcile-bulk`    | Bulk reconcile            |
| DELETE | `/api/bank-transactions/:id`               | Delete (not reconciled)   |

### Fixed Assets
| Method | Endpoint                       | Description                  |
|--------|--------------------------------|------------------------------|
| GET    | `/api/assets`                  | List (filter: status)        |
| POST   | `/api/assets`                  | Create asset                 |
| GET    | `/api/assets/:id`              | Get with depreciation history|
| PUT    | `/api/assets/:id`              | Update asset                 |
| DELETE | `/api/assets/:id`              | Mark as disposed             |
| POST   | `/api/assets/:id/depreciate`   | Post depreciation run        |
| GET    | `/api/assets/:id/schedule`     | Projected depreciation schedule|

### Financial Reports
| Method | Endpoint                              | Query Params             |
|--------|---------------------------------------|--------------------------|
| GET    | `/api/reports/trial-balance`          | `as_at`                  |
| GET    | `/api/reports/income-statement`       | `from`, `to`             |
| GET    | `/api/reports/balance-sheet`          | `as_at`                  |
| GET    | `/api/reports/general-ledger`         | `from`, `to`, `account_code` |
| GET    | `/api/reports/ar-aging`               | `as_at`                  |
| GET    | `/api/reports/ap-aging`               | `as_at`                  |
| GET    | `/api/reports/vat`                    | `from`, `to`             |
| GET    | `/api/reports/cash-flow`              | `from`, `to`             |

### Settings
| Method | Endpoint             | Description                   |
|--------|----------------------|-------------------------------|
| GET    | `/api/settings`      | All company settings          |
| PUT    | `/api/settings`      | Update settings (admin only)  |
| GET    | `/api/settings/:key` | Single setting value          |

### Audit Log
| Method | Endpoint          | Query Params                           |
|--------|-------------------|----------------------------------------|
| GET    | `/api/audit`      | `from`,`to`,`action`,`entity`,`performed_by` |
| GET    | `/api/audit/:id`  | Single audit entry                     |

---

## Auto-Journal Logic

| Action            | Debit (DR)                   | Credit (CR)               |
|-------------------|------------------------------|---------------------------|
| Post Invoice      | Accounts Receivable (arAcc)  | Revenue + Output VAT      |
| Post Bill         | Expense + Input VAT          | Accounts Payable (apAcc)  |
| Post Receipt      | Bank (ledger_account_code)   | Accounts Receivable       |
| Post Payment      | Accounts Payable             | Bank (ledger_account_code)|
| Post Depreciation | Depreciation Expense (7100)  | Acc. Depreciation (1600)  |

Account codes are read from **Settings** (`arAcc`, `apAcc`, `vatOut`, `vatIn`, `revAcc`).

---

## Project Structure

```
nrt-api/
├── server.js              # Entry point — all routes mounted here
├── schema.sql             # PostgreSQL DDL (verify against your existing DB)
├── .env.example
├── package.json
└── src/
    ├── db/
    │   └── index.js       # pg Pool + withTransaction helper
    ├── middleware/
    │   ├── auth.js        # JWT verify + requireRole()
    │   ├── audit.js       # logAudit() helper
    │   └── errorHandler.js# Global error handler + asyncHandler
    └── routes/
        ├── auth.js
        ├── accounts.js
        ├── journals.js
        ├── customers.js
        ├── invoices.js
        ├── receipts.js
        ├── suppliers.js
        ├── bills.js
        ├── payments.js
        ├── banks.js
        ├── bankTransactions.js
        ├── assets.js
        ├── reports.js
        ├── settings.js
        └── audit.js
```
