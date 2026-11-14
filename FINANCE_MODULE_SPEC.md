# The Eye Financial Management System — Specification

**Status:** Implemented in the copied project; development schema applied
**Scope:** Employee Payroll, School Expenses, and their shared financial ledger

## 1. Executive summary

The proposed system adds two functionally independent modules—Employee Payroll
and School Expenses—on top of one tenant-scoped financial ledger. Each recorded
payment creates exactly one cash movement. Unpaid obligations and estimates are
not cash movements. Historical records are corrected with traceable adjustments
or reversals rather than deletion or overwriting.

The design is incremental: link a payroll profile to an existing teacher where
applicable, and create staff records only for non-teaching employees. No payroll
employee automatically receives an application login. Preserve the existing
fee module and integrate its actual collections into the ledger only in a
separately approved phase.

### Implementation status

- The finance API, admin pages, navigation, shared frontend assets, and focused
  domain tests are implemented in this copied project.
- `migrations/004_finance_management.sql` was applied to the copied project's
  development database after the user independently confirmed its isolation.
  It adds the finance schema and seeds default categories and a cash account.
  Do not rerun it without first checking whether it has already been applied.
- Finance currently supports PKR only. Existing cumulative fee records are not
  automatically posted as finance income.
- Expense payments can store a textual receipt reference; private file upload
  and storage are not implemented. Audit events are recorded, but a full
  audit-history interface is not implemented.

## 2. Existing architecture inspected

The original architecture review below was based on copied-project source and
migration files. The finance migration was subsequently applied to the
user-confirmed development database; no production database was accessed.

### 2.1 Database and configuration

- The application uses PostgreSQL through the `pg` package. [db.js](./db.js)
  creates a pool using `DATABASE_URL`; it requests TLS with certificate
  verification.
- `.env` contains `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `NEON_BRANCH`.
  Their values are intentionally not included here.
- `NEON_BRANCH` is present, but the backend connection code uses
  `DATABASE_URL`. Local configuration alone does not establish that the URL
  points to an isolated development branch.
- `serverg.js` runs `createTables()` before listening. That startup routine
  issues DDL and includes data-changing statements. Do not start the copied
  backend until its database target is independently verified.
- The finance migration was applied directly to the confirmed development
  target; the normal backend and its startup routine were not run for that
  migration.

**Isolation result:** The user independently confirmed that the copied
project's configured database was development-only before authorizing the
finance implementation. This confirmation is not a general guarantee about
future `.env` contents; independently verify the target before any further
database operation.

To establish isolation later, an authorized operator should:

1. Identify the intended development Neon project and branch independently of
   this checkout.
2. Verify that `DATABASE_URL` in the copied project's runtime environment
   connects to that branch (without exposing credentials in logs or reports).
3. Ensure the copied backend cannot fall back to production credentials and
   review its startup schema bootstrap before running it.
4. Record the verified project/branch identity and the person who approved it.

### 2.2 Tenants, branches, and authorization

- `organizations.school_code` is the tenant identifier. Most tenant-owned
  records use a `tenant_id` column and API handlers commonly scope queries to
  `req.user.tenant_id`.
- `branches.school_id` refers to an organization. Existing `students`,
  `teachers`, `classes`, `admins`, and attendance records have nullable
  `branch_id` values. A null branch is intentional: it supports schools that
  have no branches and represents school-wide scope.
- The authentication middleware puts `tenant_id`, role, and `branch_id` into
  `req.user`. `branchFilter()` is intended to constrain coordinator reads, while
  `requireWritableBranch()` checks certain coordinator writes.
- Existing roles include `super_admin`, `admin`, `coordinator`, `teacher`, and
  `student`. Tenant feature grants in `tenant_features` / `tenant_grants`
  determine whether a module is available to a tenant; they are not a
  per-person finance permission system.
- Finance endpoints must independently enforce tenant ownership and any
  branch scope on every read and write. A UI feature flag or hidden button is
  not authorization.

### 2.3 Teachers, students, and fee management

- `teachers` and `students` use integer primary keys and include tenant
  ownership. Teacher records also contain login-related fields. Teacher
  identity and account fields should remain in the existing teacher system.
- `fee_structures` stores class- or student-level fee settings, and
  `fee_payments` stores a tenant-scoped student/month record with `amount_due`,
  cumulative `amount_paid`, status, and payment details. The current payment
  row is unique by `(student_id, month, tenant_id)`.
- Fee APIs are in `serverg.js` under `/api/fees/...`. Some reads permit teachers;
  payment changes are admin-only. This is existing behavior, not a proposed
  permission grant for the finance system.
- Existing fee payments are not a general immutable payment log: the API can
  update the aggregate monthly record. A future ledger integration must not
  treat an updated cumulative total as a new full payment.

Useful source locations: [serverg.js](./serverg.js),
[authMiddleware.js](./authMiddleware.js), [fees.html](./fees.html), and the
existing files in [migrations/](./migrations/).

## 3. Goals, boundaries, and core terminology

### Goals

1. Manage payroll for teachers and all other school employees.
2. Track fixed recurring, variable recurring, one-time, and scheduled expenses.
3. Keep actual cash movements in a single shared ledger.
4. Report actual income, actual payments, outstanding obligations, and
   estimates separately.
5. Preserve tenant and optional branch ownership and the complete audit trail.

### Out of scope for this specification

- Implementing application code, APIs, screens, migrations, or permissions.
- Replacing or changing the existing fee workflow.
- Automatically deriving pay from attendance in the first version.
- Selecting navigation placement.
- Assuming that any existing role should receive finance access by default.

### Definitions

- **Obligation:** An approved amount owed for a payroll period or bill. It is
  not a cash movement.
- **Estimate/forecast:** A planning value. It is neither an obligation nor a
  cash movement.
- **Payment:** A posted amount paid against an obligation; may be partial.
- **Ledger transaction:** The single immutable cash movement corresponding to
  that payment (or another approved cash event).
- **Outstanding:** Obligation total less posted payments and approved
  obligation reductions, never less an estimate.

## 4. Shared data and database conventions

Use the copied project's existing PostgreSQL database after its development
isolation has been verified. Do not create a database per module.

### Conventions for proposed tables

- Use `BIGINT`/identity or the repository's approved key convention consistently.
- Use `NUMERIC(12,2)` (or a reviewed precision suitable for the tenant's
  currency) for every monetary amount. Do not use floating-point types.
- Store tenant ownership on every tenant-owned finance row.
- Store `branch_id` as nullable. A null branch remains valid and must not be
  converted to a synthetic branch.
- Keep tenant identifier type/length consistent with the final inspected
  schema; source code currently uses both `VARCHAR(10)` tenant columns and a
  `VARCHAR(4)` organization school code.
- Use `created_at`, `created_by`, and, for mutable configuration,
  `updated_at`/`updated_by`. Prefer deactivation/effective dates over deleting
  referenced records.
- Store dates as PostgreSQL `DATE` for business dates and `TIMESTAMPTZ` for
  audit/event timestamps. Define a tenant timezone before generating periods.
- Finance currently restricts monetary records and reporting to PKR. Supporting
  additional currencies requires separate reporting/conversion behavior and is
  not implemented.

### Proposed entity map

```text
organizations (tenant)
  ├── branches (optional)
  ├── staff_members ── optional link to teachers
  │     ├── employee_compensation (effective-dated)
  │     ├── payroll_entries (one employee/period)
  │     ├── payroll_adjustments
  │     └── payroll_payments ── financial_transactions
  ├── expense_categories
  │     ├── recurring_expense_templates (fixed / variable / scheduled)
  │     └── expense_obligations (including one-time)
  │             └── expense_payments ── financial_transactions
  ├── financial_accounts
  └── financial_transactions (shared cash ledger)

Existing fee_payments ── future, explicitly reconciled income integration
```

For relational integrity, add tenant-aware unique keys and composite foreign
keys where practical (for example `(id, tenant_id)` on referenced parent rows).
Branch-bearing finance rows should reference a branch belonging to the same
tenant, using an appropriate composite key such as `(branch_id, tenant_id)`
against the branch table's branch identifier and `school_id`. Confirm actual
key definitions before migration design. Application filters remain required
even with database constraints.

### Proposed tables and responsibilities

| Table | Responsibility and principal relationships |
|---|---|
| `employee_categories` | Tenant-owned categories, including seeded common categories and administrator-created labels. Unique normalized name per tenant; deactivate rather than delete in-use categories. |
| `staff_members` | Employment/payroll identity. Nullable unique `teacher_id` links an existing teacher; non-teaching staff have no teacher link. Holds employee number, optional staff-only name/contact, job title, branch, joining/leaving dates, employment type, status, and payment basis. Does not hold credentials. |
| `employee_compensation` | Effective-dated rate/basis/frequency history. Foreign key to one staff member and tenant; `effective_from` / optional `effective_to`, amount and currency. No destructive overwrite of a rate used by payroll. |
| `payroll_periods` | Tenant/optional branch payroll period, dates, status, and run metadata. A period can be reopened only through a permissioned, audited process. |
| `payroll_entries` | One obligation per employee and period, with frozen rate, payable quantity, gross, adjustments, advance credits, net obligation, currency, status, and review/approval fields. Unique `(tenant_id, employee_id, period_id)`. |
| `payroll_adjustments` | Approved advance, bonus, allowance, deduction, correction, or settlement item tied to an employee and, where applicable, payroll entry. Preserve type, amount, effective/payroll period, reason, approver, and audit history. |
| `payroll_payments` | Immutable payment events against a payroll entry: amount, date, method, reference, actor, idempotency key, and a unique link to one ledger transaction. Multiple rows support partial payment. |
| `expense_categories` | Tenant-owned editable/deactivatable categories, including the expense type defaults/metadata. |
| `recurring_expense_templates` | Fixed, variable, or scheduled recurrence configuration, expected amount/estimate (where applicable), frequency, due-date rule, effective dates, and active state. A variable template may have no amount. |
| `expense_obligations` | One bill/payable for a fixed recurring period, received variable bill, one-time expense, or scheduled occurrence. Stores expected and actual/approved amount separately, due date, category, branch, source template, status, attachment reference, and audit data. Unique source/template period where applicable. |
| `expense_payments` | Immutable payment events against an obligation, with partial payment support and a unique link to one ledger transaction. |
| `financial_accounts` | Tenant-owned cash/bank accounts, currency, display name, status, and reconciliation metadata. |
| `financial_transactions` | Shared immutable ledger movement: account, tenant, optional branch, signed direction, positive `NUMERIC` amount, currency, date, source kind/id, memo, actor, idempotency key, and optional `reversal_of_id`. Unique idempotency key and unique source-payment association prevent duplicate cash posting. |
| `financial_audit_events` | Append-only audit records for sensitive changes, approvals, edits, and reversals. Capture actor, action, entity, timestamp, reason, and safe before/after values. Avoid storing secrets or receipt contents. |

Use the final names only after reviewing repository conventions and existing
database constraints. This is a logical model; the applied SQL is in
`migrations/004_finance_management.sql`.

## 5. Employee Payroll

### 5.1 Employee records and teacher integration

`staff_members` represents the employment relationship, not another login
identity. For a teacher, set its `teacher_id` to the existing teacher row and
use that row as the canonical source for teacher name and login identity.
Do not copy the password, login ID, or teacher identity into a separate account.
For non-teaching staff, create a staff member without a teacher link and store
their name/contact directly on the staff record.

Enforce one payroll profile per teacher within a tenant. Validate that a linked
teacher belongs to the same tenant; if both records carry branches, validate
that their branch assignments agree. A teacher without a payroll profile
remains an ordinary teacher record.

Employee categories should support Teacher, Peon, Cleaner, Security Guard,
Receptionist, Accountant, Administrative Staff, Driver, Maintenance Worker,
and tenant-defined categories. Job title remains separate from category.
Support permanent, contract, temporary, and part-time employment, plus monthly,
daily, hourly, and fixed-contract payment bases. Employee status and access to
the application are separate concerns. Creating a staff record never creates
an application login.

### 5.2 Effective-dated compensation

Each compensation version has a basis, rate, frequency, currency, effective
date range, and optional expected payment day. Only one applicable active
compensation version should resolve for a given employee and payroll date.

When a rate changes, close the previous version and create a new effective-dated
version. Do not rewrite rates already snapshotted into payroll entries.

Example: Rs. 30,000 through November 30 and Rs. 35,000 from December 1. November
payroll retains Rs. 30,000; December payroll uses Rs. 35,000.

### 5.3 Payroll periods and calculations

Payroll generation is idempotent. For each employee eligible during a period,
create at most one payroll entry under the unique tenant/employee/period key.
Reopening the payroll screen or retrying a request must not produce another
entry. A payroll preview can be recalculated before approval; an approved entry
is changed only through an audited adjustment/reopen workflow.

Snapshot the applied rate, basis, period, quantity, gross, adjustments, advance
credits, and net payable. For monthly employees, use the effective monthly
compensation. For daily/hourly employees, initially require an administrator to
enter/review payable days or hours and apply the stored rate; do not derive
payable units from attendance in the first version. Fixed contract payments
use the agreed contract amount/frequency.

For mid-period joining/leaving, calculate a proposed proration from approved
eligible days and a tenant-approved divisor/calendar rule. Show the formula and
inputs and require administrator review. Do not silently choose between
calendar-day, working-day, or fixed-divisor methods.

### 5.4 Payments, advances, and adjustments

Payroll entries have an obligation amount and cumulative posted-payment amount.
Outstanding is obligation less posted payroll payment amounts, with explicit
approved credits/adjustments applied exactly once.

- A full or partial salary payment inserts one `payroll_payments` event and one
  matching `financial_transactions` cash outflow in the same PostgreSQL
  transaction.
- A salary advance is recorded as a payroll advance payment and cash outflow
  when paid. On the applicable payroll entry it becomes an advance credit,
  reducing the remaining salary payable. Do not create a second cash movement
  when applying that credit.
- Bonuses, allowances, and deductions are payroll adjustments with a reason,
  period, approval, and explicit treatment in the gross/net calculation.
- Final settlement records last working date, prorated earnings, deductions,
  any advances/other outstanding items, approvals, and any final payment.
  Keep the employee and payment history available after leaving.
- Payment method, business date, reference, recording actor, and optional
  receipt reference are recorded for each payment.

## 6. School Expenses

Categories are tenant-owned and can be created, renamed, and deactivated by
authorized users. Do not delete categories referenced by history. Each
obligation keeps a snapshot of its category label or a stable category
reference plus retained category record.

### 6.1 Fixed recurring expenses

Configure name/category, expected amount, frequency, due-date rule, start date,
optional end date, branch, and active state. Generate one obligation per
applicable recurrence period, protected by a unique template/period key.
Repeated page visits and generation retries must be idempotent.

At invoice/payment recording, preserve expected and actual amounts separately.
If the invoice differs, the payable obligation reflects the approved actual
invoice; show the variance without changing previous periods. A stopped
template stops future obligations, not existing obligations or payments.

### 6.2 Variable recurring expenses and estimates

Configure name/category, frequency, expected bill date, start/end dates, and
optional estimate per month. Create an actual obligation only when a bill is
received and reviewed. An estimate alone creates neither an obligation nor a
ledger transaction.

Monthly charts use actual bill amounts grouped by the relevant bill/obligation
period, and should show the number of bills or missing months where relevant.
Provide highest, lowest, average, month-over-month percentage change, yearly
comparison, and historical comparison when records exist. Define how zero or
missing prior-month values affect percentage change; do not render division by
zero as a meaningful percentage. Seasonal increases are informational, not
automatic error flags.

For an estimate of Rs. 50,000 and actual bill of Rs. 58,000, show an Rs. 8,000
variance. Do not add the estimate to actual expenses, outstanding obligations,
or cash movements.

### 6.3 One-time and scheduled expenses

- One-time expenses store name, category, actual obligation amount/date,
  description, optional receipt reference, branch, and payment status. They
  have no recurrence.
- Scheduled expenses store an interval or explicit schedule, expected amount,
  start/end dates, and due-date rule. Generate one obligation for each
  occurrence and prevent duplicate occurrences.
- All four kinds—fixed recurring, variable recurring, one-time, and scheduled—
  use the same obligation/payment/ledger rules.

### 6.4 Status, payments, and corrections

For payroll and expenses, derive status from obligation and posted payment
totals: unpaid (zero paid), partially paid (positive but less than due), paid
(equal to due), and overpaid only if explicitly allowed and represented as a
separate credit/refund decision. Keep status derivable; do not accept a client
status value as authoritative.

Each partial expense payment creates one payment event and one ledger outflow.
Outstanding amount is updated from the obligation and all valid payment events.
Corrections are append-only adjustment or reversal events with reason, actor,
approval, and links to the original. Never silently delete or rewrite a
financial transaction.

Receipt uploads require an approved private storage design: random object keys,
tenant/record authorization on retrieval, size/type validation, and no
publicly guessable URLs. Store a reference and metadata, not file contents, in
the ledger tables.

## 7. Shared financial ledger and calculations

### 7.1 One cash movement per payment

The payroll and expenses modules create domain payment events, but neither
module maintains its own balance. `financial_transactions` is the single source
for actual cash movement. Enforce one-to-one payment-to-ledger linkage and a
unique idempotency/source key.

Payment workflow, in one database transaction:

1. Authenticate and authorize the actor; validate tenant, branch, obligation,
   currency, amount, and remaining payable amount.
2. Lock the obligation/payment-balance row (for example `SELECT ... FOR UPDATE`)
   to prevent concurrent overpayment.
3. Validate a unique idempotency key. A retried request returns the already
   recorded result rather than posting again.
4. Insert the immutable payment event and its corresponding ledger movement.
5. Link both records, update any materialized status/balance if used, and append
   an audit event.
6. Commit. Any failure rolls back every step.

Use database uniqueness constraints as well as application checks. A timeout
after commit must be safe to retry. Cash posting must never be split into two
independent module-specific operations.

### 7.2 Balances and reporting

For the selected tenant/account/currency and reporting date:

```text
Actual cash = opening cash + posted income - posted cash outflows
Outstanding obligations = approved obligations - posted payments - approved credits
Available after obligations = actual cash - outstanding obligations
Forecast = expected future values, reported separately
```

Represent opening cash as an audited opening-balance ledger transaction (or a
reviewed equivalent with a clear effective date). Actual expense totals count
posted ledger outflows, not unpaid bills or estimates. Do not add obligations
to cash expense totals. Avoid double-counting a payroll advance when the
advance is later credited against salary.

If different currencies are approved, report each currency separately unless a
reviewed exchange-rate and conversion policy is implemented.

### 7.3 Income and existing fee integration

The existing fee module remains authoritative for fee setup and collection
workflow. Do not rebuild it or change its tables as part of this design.

In a future, separately approved phase, integrate only verified actual
collections as ledger income. Because current `fee_payments` stores a cumulative
monthly amount that may be overwritten, do not import the current row amount
each time it changes. First add or identify an immutable fee-payment event
source, or perform a controlled baseline/reconciliation and post only
idempotent deltas with an auditable source identifier. Reconcile tenant,
student, period, amount, and payment history. The same collection must not be
posted once from the fee module and again as a manual ledger income.

Any other income source must also be an explicit, authorized ledger event with
source and audit data; it is not inferred from estimates.

## 8. Tenant isolation, branches, and permissions

### 8.1 Data ownership

- Every finance row includes tenant ownership and is filtered by the
  authenticated `req.user.tenant_id`, never a tenant ID trusted from the body.
- Validate every referenced employee, teacher, category, obligation, account,
  branch, and payment under that same tenant.
- Coordinators remain branch-limited only if explicitly authorized for finance;
  every query must apply the authorized branch scope server-side.
- For a tenant with no branches, keep `branch_id = NULL` and allow school-wide
  operation. Do not require a branch to be created.
- For a tenant with branches, determine whether a record is branch-specific or
  school-wide under an approved policy. Do not silently infer branch from
  client data.
- Build tenant-aware unique constraints and composite foreign keys after
  inspecting actual deployed constraints. Keep application-level scope checks
  for defense in depth.

### 8.2 Proposed permission model

The existing system has broad application roles and tenant feature grants, but
the inspected code does not establish fine-grained finance permissions.
Introduce finance-specific server-enforced capabilities only after role
approval. Suggested capabilities:

| Capability | Intended operations |
|---|---|
| `finance.view` | Read authorized dashboard, obligations, and reports. |
| `payroll.manage_employees` | Add/update/deactivate employee payroll profiles and categories. |
| `payroll.manage_compensation` | Create effective-dated rates and review payroll calculations. |
| `payroll.approve` | Approve payroll runs, adjustments, and final settlements. |
| `payroll.pay` | Record payroll payments and advances. |
| `expenses.manage` | Manage categories and recurring/one-time/scheduled obligations. |
| `expenses.pay` | Record expense payments. |
| `finance.reverse` | Approve and post a reversal/correction. |
| `finance.audit` | Read sensitive financial audit history. |

Grant only to explicitly approved users/roles and optionally restrict each grant
to tenant and branch. Do not automatically grant finance access to teachers,
coordinators, or all administrators. Separate entry from approval for material
payments where staffing permits. All authorization checks belong in backend
middleware/service functions; frontend visibility is supplementary.

## 9. Audit, integrity, and lifecycle edge cases

| Case | Required behavior |
|---|---|
| Employee joins mid-month | Calculate using approved proration policy; show formula and require review. |
| Employee leaves mid-month | Stop future payroll after last working date; calculate reviewed final settlement and preserve history. |
| Salary changes | Add a new effective-dated rate; preserve past rates and payroll snapshots. |
| Daily/hourly wages | Record/review payable units and rate; no automatic attendance calculation in V1. |
| Partial salary/expense payment | Add one payment event and matching ledger outflow; compute remaining balance. |
| Advance | Record one cash outflow at payment; apply as a credit to later payroll, never a second outflow. |
| Deduction/bonus/allowance | Record typed, reasoned, approved adjustment and its payroll-period treatment. |
| Duplicate/retried submission | Unique idempotency key and payment-source constraint return the original result. |
| Changed electricity bill | Store actual bill and optional estimate independently; display variance and historical trend. |
| Unpaid internet bill | Keep an obligation and outstanding amount; do not reduce actual cash. |
| Stopped recurring expense | Stop future generation; keep existing obligations and payment history. |
| Deactivated category | Prevent new use where appropriate; keep referenced history readable. |
| Corrected/reversed payment | Append reversal/correction linked to original; preserve both in audit history. |
| Insufficient available cash | Show a warning and require authorized override/approval if policy allows; never fabricate a balance or silently reject without explanation. |
| New month with old obligations | Carry outstanding balances forward; do not duplicate or automatically pay them. |
| Multiple branches | Scope each record and report by tenant and authorized branch; prevent cross-branch references. |
| No branches | Permit null branch values and tenant-wide reporting. |
| Deactivated tenant | Block new financial writes according to tenant lifecycle policy; retain authorized read-only history. |
| Overpayment/refund | Require explicit refund/credit treatment and ledger reversal/inflow; do not silently clamp totals. |
| Concurrent payment attempts | Lock obligation/balance and enforce transactional uniqueness/remaining amount checks. |

## 10. User interface and workflow proposal

Navigation placement is intentionally undecided.

### Employee Payroll screens

1. **Employee directory:** name, employee number, category, job title, branch,
   employment status, payment basis, and outstanding amount. Filter by category,
   branch, and status.
2. **Add/edit employee:** choose an existing teacher to link or enter a
   non-teaching employee; collect employment details without creating login
   credentials.
3. **Employee profile:** compensation timeline, payroll history, adjustments,
   advances, payments, and final settlement.
4. **Payroll overview:** choose period/branch; preview eligible staff, rate,
   payable quantity, gross, credits/deductions, net, and exceptions; generate
   idempotently; review and approve.
5. **Record payment:** amount, date, method, reference, optional receipt, and
   confirmation of remaining amount. Support partial payments.
6. **Outstanding payroll:** unpaid and partial entries with due dates and prior
   payment history.

### School Expenses screens

1. **Expense overview:** paid, outstanding, and upcoming obligations separated
   from estimates.
2. **Category management:** add, edit, or deactivate category/type.
3. **Recurring expenses:** configure fixed recurring and variable recurring
   schedules; display next due period and generation state.
4. **Variable expense history:** category/month selector, actual-versus-estimate
   chart, highest/lowest/average, year comparison, and seasonal history.
5. **One-time and scheduled expenses:** create, review, and track obligations.
6. **Expense detail/payment history:** expected versus actual, due date, partial
   payments, references, receipts, outstanding amount, and corrections.

### Shared financial overview

```text
Period / branch / account / currency filters
  Opening cash | Actual cash | Recorded income | Actual payments
  Outstanding obligations | Available after obligations

Payroll: expected | approved | paid | outstanding
Expenses: fixed | variable actuals | one-time/scheduled | estimates (separate)
History: ledger activity, category/employee breakdown, audit/reversal links
```

The dashboard uses posted ledger transactions for cash/income/paid expense
totals and approved obligations for outstanding amounts. Estimates appear in a
separate forecast panel. Reports support monthly, quarterly, yearly, and custom
date ranges, plus category, employee, branch, and payment-status filters, all
within the caller's authorized tenant/branch scope.

## 11. Additive migration and deployment safety

The additive finance migration has been applied to the confirmed development
database. The copied backend's normal startup routine was not used to apply it.
Before any further database operation or production deployment:

1. Re-verify the intended database target independently.
2. Inspect the target schema, constraints, indexes, data volume, and
   actual tenant/branch key types using read-only queries only after
   authorization and isolation confirmation.
3. Review the existing startup `createTables()` behavior. Because it performs
   DDL and data updates, treat application startup as a potentially
   data-mutating operation; do not use it as a substitute for reviewed
   migrations.
4. Confirm the finance migration's applied state before considering any
   migration execution. Avoid destructive changes and avoid modifying fee
   records.
5. Test any further migration and application behavior against development data and
   separate tenant/branch fixtures. Verify rollback/recovery procedures.
6. Review and approve the exact migration and application diff before any
   production action. Back up production and define a restore plan first.
7. Apply only approved schema migrations and verified application changes to
   production. Never copy the development database over production or overwrite
   existing records.

## 12. Implementation roadmap

This was the original sequence for implementation. The finance foundation and
payroll/expense workflows are now present in the copied project; fee-income
integration and the future improvements below remain separate work.

| Phase | Deliverable | Depends on |
|---|---|---|
| 1. Architecture and schema approval | Confirm tenant/branch constraints, currency, payroll proration, permissions, audit and reversal policy. | None |
| 2. Development isolation | Verify copied backend target and startup behavior; establish development-only credentials. | Phase 1; must precede all runtime/database work |
| 3. Ledger foundation | Accounts/opening balances, immutable transactions, idempotency, audit events, transaction utilities, and tenant/branch checks. | Phases 1–2 |
| 4. Employee records | Categories and staff profiles, safe existing-teacher linkage, lifecycle/status. | Phases 1–3 |
| 5. Compensation and payroll processing | Effective-dated rates, payroll periods/entries, monthly and manual quantity calculations, approval. | Phases 3–4 |
| 6. Payroll payment and adjustment | Partial payments, advances, allowances, bonuses, deductions, final settlements, atomic ledger posting. | Phases 3–5 |
| 7. Expense categories and templates | Custom categories and fixed/variable/scheduled configuration. | Phases 1–3 |
| 8. Expense obligations | Recurring generation, actual variable bills, estimates, one-time and scheduled obligations. | Phases 3, 7 |
| 9. Expense payments | Partial payment workflow, receipts, atomic ledger posting, reversals. | Phases 3, 8 |
| 10. Financial overview | Cash, income, payments, obligations, and after-obligation balances. | Phases 3, 6, 9 |
| 11. Reports and charts | Filters, monthly variable expense charts, comparisons, audit-accessible reports. | Phases 6, 9, 10 |
| 12. Existing fee income integration | Reconcile source events and post idempotent fee income without changing fee workflow. | Phase 3 and separate approval; requires a reliable immutable collection source |

### Essential first version

- Verified isolated development environment.
- Tenant/branch-safe shared ledger and audit trail.
- Teacher-linked and non-teaching staff profiles without automatic logins.
- Effective-dated compensation and manually reviewed payroll quantities.
- Idempotent payroll periods, partial payments, advances, and adjustments.
- All four expense types, recurring obligation deduplication, and partial payments.
- Correct separation of cash, obligations, and estimates.
- Core overview and payment history.

### Future improvements

- Attendance-derived wages after a separate policy and integration review.
- Advanced reconciliation, bank imports, budgeting, and forecasting.
- More advanced approval workflows and segregation-of-duties rules.
- Fee-income integration after the existing cumulative fee record has a reliable,
  auditable payment-event source.

## 13. Decisions for future changes or production deployment

1. What reporting timezone and payroll proration policy should apply if those
   behaviors are expanded beyond the current implementation?
2. Should finance access remain admin-only, or should coordinators receive
   branch-scoped permissions?
3. What cash-account opening-balance cutover and insufficient-cash approval
   policy should apply to a production rollout?
4. What immutable source will represent existing fee collections for future
   income integration?
5. Which independently verified production target and deployment/recovery
   procedure will be authorized? Do not infer this from the copied project's
   development configuration.

## 14. Final verification checklist

- [x] Finance application code, APIs, admin pages, and navigation were added to
      the copied project.
- [x] Payroll covers teachers and non-teaching staff.
- [x] Existing teachers are linked rather than unnecessarily duplicated.
- [x] Employee records do not automatically require login accounts.
- [x] School expenses cover fixed recurring, variable recurring, one-time, and scheduled expenses.
- [x] Variable expenses include monthly historical charts and comparisons.
- [x] Fixed expenses generate deduplicated recurring obligations and retain payment history.
- [x] Both modules use a shared ledger with atomic, idempotent cash posting.
- [x] Tenant ownership and nullable branch behavior are addressed.
- [x] Development database isolation was independently confirmed by the user
      before the finance migration was applied.
- [x] Existing fee management is preserved; future integration is separately scoped.
- [x] Financial history is preserved through append-only corrections/reversals.
- [x] The finance migration was applied to the confirmed development database;
      no production database was accessed and no deployment occurred.
- [x] All 56 unit tests pass; the read-only finance API smoke test passed for
      overview, accounts, transactions, employees, payroll, advances, expense
      templates, obligations, and analytics.
- [x] The pre-existing worktree change to `admin.html` was left untouched.
