-- Finance Management System schema.
-- Additive only: does not alter existing finance, fee, teacher, student, or
-- authentication records. Run only against the verified development database.
-- Roll back only before finance data has been entered, by dropping these new
-- tables in reverse dependency order. Never run this file from application startup.

BEGIN;

CREATE TABLE employee_categories (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  category_key VARCHAR(100) NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, category_key),
  UNIQUE (id, tenant_id)
);

CREATE TABLE staff_members (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE RESTRICT,
  category_id BIGINT NOT NULL,
  employee_number VARCHAR(50),
  name VARCHAR(150),
  job_title VARCHAR(120),
  phone VARCHAR(50),
  email VARCHAR(200),
  employee_identifier VARCHAR(100),
  joining_date DATE NOT NULL,
  last_working_date DATE,
  employment_type VARCHAR(20) NOT NULL CHECK (employment_type IN ('permanent', 'contract', 'temporary', 'part_time')),
  employment_status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'on_leave', 'left', 'inactive')),
  payment_basis VARCHAR(20) NOT NULL CHECK (payment_basis IN ('monthly', 'daily', 'hourly', 'contract')),
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (teacher_id IS NOT NULL OR NULLIF(BTRIM(name), '') IS NOT NULL),
  CHECK (last_working_date IS NULL OR last_working_date >= joining_date),
  FOREIGN KEY (category_id, tenant_id) REFERENCES employee_categories(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, teacher_id)
);

CREATE UNIQUE INDEX staff_members_employee_number_uq
  ON staff_members(tenant_id, employee_number)
  WHERE employee_number IS NOT NULL;
CREATE INDEX staff_members_tenant_branch_idx ON staff_members(tenant_id, branch_id);
CREATE INDEX staff_members_tenant_status_idx ON staff_members(tenant_id, employment_status);

CREATE TABLE employee_compensation (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  employee_id BIGINT NOT NULL,
  payment_basis VARCHAR(20) NOT NULL CHECK (payment_basis IN ('monthly', 'daily', 'hourly', 'contract')),
  payment_frequency VARCHAR(20) NOT NULL CHECK (payment_frequency IN ('monthly', 'weekly', 'biweekly', 'daily', 'hourly', 'per_contract')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  expected_payment_day SMALLINT CHECK (expected_payment_day BETWEEN 1 AND 31),
  effective_from DATE NOT NULL,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  FOREIGN KEY (employee_id, tenant_id) REFERENCES staff_members(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, employee_id, effective_from),
  UNIQUE (id, tenant_id)
);
CREATE INDEX employee_compensation_lookup_idx
  ON employee_compensation(tenant_id, employee_id, effective_from DESC);

CREATE TABLE payroll_periods (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'closed')),
  created_by INTEGER,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (period_end >= period_start),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX payroll_periods_scope_dates_uq
  ON payroll_periods(tenant_id, COALESCE(branch_id, 0), period_start, period_end);
CREATE INDEX payroll_periods_tenant_dates_idx
  ON payroll_periods(tenant_id, period_start DESC, period_end);

CREATE TABLE payroll_entries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  payroll_period_id BIGINT NOT NULL,
  employee_id BIGINT NOT NULL,
  payment_basis VARCHAR(20) NOT NULL CHECK (payment_basis IN ('monthly', 'daily', 'hourly', 'contract')),
  rate_snapshot NUMERIC(12,2) NOT NULL CHECK (rate_snapshot > 0),
  payable_units NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (payable_units > 0),
  gross_amount NUMERIC(12,2) NOT NULL CHECK (gross_amount >= 0),
  amount_due NUMERIC(12,2) NOT NULL CHECK (amount_due >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_by INTEGER,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payroll_period_id, tenant_id) REFERENCES payroll_periods(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (employee_id, tenant_id) REFERENCES staff_members(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, payroll_period_id, employee_id),
  UNIQUE (id, tenant_id)
);
CREATE INDEX payroll_entries_tenant_status_idx ON payroll_entries(tenant_id, status);
CREATE INDEX payroll_entries_employee_period_idx ON payroll_entries(tenant_id, employee_id, payroll_period_id);

CREATE TABLE payroll_adjustments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  payroll_entry_id BIGINT NOT NULL,
  adjustment_type VARCHAR(20) NOT NULL CHECK (adjustment_type IN ('bonus', 'allowance', 'deduction')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payroll_entry_id, tenant_id) REFERENCES payroll_entries(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX payroll_adjustments_entry_idx ON payroll_adjustments(tenant_id, payroll_entry_id);

CREATE TABLE payroll_advances (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  employee_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  payment_date DATE NOT NULL,
  payment_method VARCHAR(40) NOT NULL,
  reference VARCHAR(120),
  notes TEXT,
  idempotency_key VARCHAR(100) NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id, tenant_id) REFERENCES staff_members(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (id, tenant_id)
);
CREATE INDEX payroll_advances_employee_idx ON payroll_advances(tenant_id, employee_id, payment_date);

CREATE TABLE payroll_advance_allocations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  advance_id BIGINT NOT NULL,
  payroll_entry_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (advance_id, tenant_id) REFERENCES payroll_advances(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (payroll_entry_id, tenant_id) REFERENCES payroll_entries(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, advance_id, payroll_entry_id)
);
CREATE INDEX payroll_advance_allocations_entry_idx
  ON payroll_advance_allocations(tenant_id, payroll_entry_id);

CREATE TABLE expense_categories (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  category_key VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, category_key),
  UNIQUE (id, tenant_id)
);

CREATE TABLE recurring_expense_templates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  category_id BIGINT NOT NULL,
  name VARCHAR(160) NOT NULL,
  expense_type VARCHAR(24) NOT NULL CHECK (expense_type IN ('fixed_recurring', 'variable_recurring', 'scheduled')),
  frequency VARCHAR(16) NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  expected_amount NUMERIC(12,2) CHECK (expected_amount IS NULL OR expected_amount >= 0),
  due_day SMALLINT NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 31),
  start_date DATE NOT NULL,
  end_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (expense_type <> 'fixed_recurring' OR expected_amount IS NOT NULL),
  FOREIGN KEY (category_id, tenant_id) REFERENCES expense_categories(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (id, tenant_id)
);
CREATE INDEX recurring_expense_templates_due_idx
  ON recurring_expense_templates(tenant_id, is_active, start_date, end_date);

CREATE TABLE expense_estimates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  template_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id, tenant_id) REFERENCES recurring_expense_templates(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, template_id, period_start)
);

CREATE TABLE expense_obligations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  category_id BIGINT NOT NULL,
  template_id BIGINT,
  expense_type VARCHAR(24) NOT NULL CHECK (expense_type IN ('fixed_recurring', 'variable_recurring', 'one_time', 'scheduled')),
  name VARCHAR(160) NOT NULL,
  description TEXT,
  period_start DATE,
  due_date DATE,
  expected_amount NUMERIC(12,2) CHECK (expected_amount IS NULL OR expected_amount >= 0),
  amount_due NUMERIC(12,2) NOT NULL CHECK (amount_due >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  receipt_reference TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id, tenant_id) REFERENCES expense_categories(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id, tenant_id) REFERENCES recurring_expense_templates(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX expense_obligations_template_period_uq
  ON expense_obligations(tenant_id, template_id, period_start)
  WHERE template_id IS NOT NULL;
CREATE INDEX expense_obligations_tenant_due_idx
  ON expense_obligations(tenant_id, due_date DESC);
CREATE INDEX expense_obligations_tenant_category_idx
  ON expense_obligations(tenant_id, category_id, period_start);

CREATE TABLE finance_accounts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  opening_balance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE payroll_payments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  payroll_entry_id BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  payment_date DATE NOT NULL,
  payment_method VARCHAR(40) NOT NULL,
  reference VARCHAR(120),
  idempotency_key VARCHAR(100) NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payroll_entry_id, tenant_id) REFERENCES payroll_entries(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, tenant_id) REFERENCES finance_accounts(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (id, tenant_id)
);
CREATE INDEX payroll_payments_entry_idx ON payroll_payments(tenant_id, payroll_entry_id, payment_date);

CREATE TABLE expense_payments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  obligation_id BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  payment_date DATE NOT NULL,
  payment_method VARCHAR(40) NOT NULL,
  reference VARCHAR(120),
  idempotency_key VARCHAR(100) NOT NULL,
  receipt_reference TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (obligation_id, tenant_id) REFERENCES expense_obligations(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, tenant_id) REFERENCES finance_accounts(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (id, tenant_id)
);
CREATE INDEX expense_payments_obligation_idx ON expense_payments(tenant_id, obligation_id, payment_date);

CREATE TABLE financial_transactions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  account_id BIGINT NOT NULL,
  transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('income', 'expense', 'opening_balance', 'reversal')),
  direction VARCHAR(3) NOT NULL CHECK (direction IN ('in', 'out')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  transaction_date DATE NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(100) NOT NULL,
  idempotency_key VARCHAR(100) NOT NULL,
  payment_method VARCHAR(40),
  reference VARCHAR(120),
  memo TEXT,
  reversal_of_id BIGINT REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id, tenant_id) REFERENCES finance_accounts(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, source_type, source_id),
  CHECK (
    (transaction_type = 'income' AND direction = 'in') OR
    (transaction_type = 'expense' AND direction = 'out') OR
    (transaction_type = 'opening_balance' AND direction = 'in') OR
    transaction_type = 'reversal'
  ),
  CHECK ((transaction_type = 'reversal') = (reversal_of_id IS NOT NULL))
);
CREATE UNIQUE INDEX financial_transactions_one_reversal_uq
  ON financial_transactions(reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
CREATE INDEX financial_transactions_account_date_idx
  ON financial_transactions(tenant_id, account_id, transaction_date);
CREATE INDEX financial_transactions_tenant_type_date_idx
  ON financial_transactions(tenant_id, transaction_type, transaction_date);

CREATE TABLE financial_audit_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE RESTRICT,
  actor_id INTEGER NOT NULL,
  actor_role VARCHAR(30) NOT NULL,
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id BIGINT,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX financial_audit_events_tenant_date_idx
  ON financial_audit_events(tenant_id, created_at DESC);
CREATE INDEX financial_audit_events_entity_idx
  ON financial_audit_events(tenant_id, entity_type, entity_id);

INSERT INTO employee_categories (tenant_id, name, category_key, is_system)
SELECT o.school_code, category.name, category.category_key, true
FROM organizations o
CROSS JOIN (VALUES
  ('Teacher', 'teacher'),
  ('Peon', 'peon'),
  ('Cleaner', 'cleaner'),
  ('Security Guard', 'security_guard'),
  ('Receptionist', 'receptionist'),
  ('Accountant', 'accountant'),
  ('Administrative Staff', 'administrative_staff'),
  ('Driver', 'driver'),
  ('Maintenance Worker', 'maintenance_worker'),
  ('Other', 'other')
) AS category(name, category_key)
ON CONFLICT (tenant_id, category_key) DO NOTHING;

INSERT INTO expense_categories (tenant_id, name, category_key)
SELECT o.school_code, category.name, category.category_key
FROM organizations o
CROSS JOIN (VALUES
  ('Electricity', 'electricity'),
  ('Internet', 'internet'),
  ('Water', 'water'),
  ('Rent', 'rent'),
  ('Fuel', 'fuel'),
  ('Maintenance', 'maintenance'),
  ('Stationery', 'stationery'),
  ('Cleaning', 'cleaning'),
  ('Security', 'security'),
  ('Transport', 'transport'),
  ('Furniture', 'furniture'),
  ('Equipment', 'equipment'),
  ('Other', 'other')
) AS category(name, category_key)
ON CONFLICT (tenant_id, category_key) DO NOTHING;

INSERT INTO finance_accounts (tenant_id, name, currency)
SELECT school_code, 'Main Cash', 'PKR'
FROM organizations
ON CONFLICT (tenant_id, name) DO NOTHING;

COMMIT;
