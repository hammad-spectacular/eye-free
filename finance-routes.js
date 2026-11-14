'use strict'

const express = require('express')
const {
  normalizeAmount,
  amountToCents,
  centsToAmount,
  calculateGross,
  normalizeCategoryKey,
  isIsoDate,
  monthBounds,
  dueDateInMonth,
  recurrenceMatches
} = require('./finance-domain')

const EMPLOYEE_CATEGORIES = [
  ['Teacher', 'teacher'],
  ['Peon', 'peon'],
  ['Cleaner', 'cleaner'],
  ['Security Guard', 'security_guard'],
  ['Receptionist', 'receptionist'],
  ['Accountant', 'accountant'],
  ['Administrative Staff', 'administrative_staff'],
  ['Driver', 'driver'],
  ['Maintenance Worker', 'maintenance_worker'],
  ['Other', 'other']
]

const EXPENSE_CATEGORIES = [
  ['Electricity', 'electricity'],
  ['Internet', 'internet'],
  ['Water', 'water'],
  ['Rent', 'rent'],
  ['Fuel', 'fuel'],
  ['Maintenance', 'maintenance'],
  ['Stationery', 'stationery'],
  ['Cleaning', 'cleaning'],
  ['Security', 'security'],
  ['Transport', 'transport'],
  ['Furniture', 'furniture'],
  ['Equipment', 'equipment'],
  ['Other', 'other']
]

class FinanceError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function fail(status, message) {
  throw new FinanceError(status, message)
}

function positiveId(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(400, label + ' must be a positive integer.')
  return parsed
}

function requiredText(value, label, max = 160) {
  const text = String(value == null ? '' : value).trim()
  if (!text || text.length > max) fail(400, label + ' is required and must be ' + max + ' characters or fewer.')
  return text
}

function optionalText(value, max = 500) {
  const text = String(value == null ? '' : value).trim()
  if (text.length > max) fail(400, 'Text exceeds the maximum length of ' + max + ' characters.')
  return text || null
}

function validDate(value, label) {
  if (!isIsoDate(value)) fail(400, label + ' must be a valid YYYY-MM-DD date.')
  return value
}

function validAmount(value, label, { allowZero = false } = {}) {
  const amount = normalizeAmount(value, { allowZero })
  if (amount === null) fail(400, label + ' must be a valid ' + (allowZero ? 'non-negative' : 'positive') + ' amount with up to two decimals.')
  return amount
}

function validCurrency(value) {
  const currency = String(value || 'PKR').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) fail(400, 'Currency must be a three-letter code.')
  if (currency !== 'PKR') fail(400, 'Only PKR is currently supported for school finance.')
  return currency
}

function validMethod(value) {
  const method = String(value || '').trim().toLowerCase()
  if (!['cash', 'bank_transfer', 'cheque', 'card', 'other'].includes(method)) {
    fail(400, 'Choose a supported payment method.')
  }
  return method
}

function validEnum(value, allowed, label) {
  const text = String(value || '').trim().toLowerCase()
  if (!allowed.includes(text)) fail(400, label + ' is invalid.')
  return text
}

function validBoolean(value, label) {
  if (typeof value !== 'boolean') fail(400, label + ' must be true or false.')
  return value
}

function userTenant(req) {
  const tenantId = String(req.user && req.user.tenant_id || '').trim()
  if (!tenantId || tenantId.length > 10) fail(403, 'A valid school tenant is required.')
  return tenantId
}

function createFinanceRouter({ pool, requireAuth }) {
  if (!pool || typeof requireAuth !== 'function') throw new TypeError('Finance router requires the application pool and authentication middleware.')

  const router = express.Router()
  router.use(requireAuth(['admin']))
  router.use(async (req, res, next) => {
    try {
      userTenant(req)
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const result = await pool.query(
          'SELECT status FROM organizations WHERE school_code = $1',
          [req.user.tenant_id]
        )
        if (!result.rows.length) return res.status(403).json({ error: 'School tenant was not found.' })
        if (result.rows[0].status !== 'active') {
          return res.status(403).json({ error: 'This school is inactive. Financial records are read-only.' })
        }
      }
      next()
    } catch (error) {
      next(error)
    }
  })

  const route = handler => async (req, res, next) => {
    try {
      await handler(req, res)
    } catch (error) {
      next(error)
    }
  }

  async function transaction(handler) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(rollbackError => {
        console.error('Finance transaction rollback failed:', rollbackError.code || rollbackError.message)
      })
      throw error
    } finally {
      client.release()
    }
  }

  async function audit(client, req, tenantId, action, entityType, entityId, details, reason = null) {
    await client.query(
      `INSERT INTO financial_audit_events
         (tenant_id, actor_id, actor_role, action, entity_type, entity_id, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        tenantId,
        req.user.user_id,
        req.user.role,
        action,
        entityType,
        entityId == null ? null : String(entityId),
        reason,
        JSON.stringify(details || {})
      ]
    )
  }

  function branchFilter(req, requested) {
    if (req.user.branch_id != null) return positiveId(req.user.branch_id, 'Branch')
    if (requested === undefined || requested === null || requested === '' || requested === 'all') return null
    return positiveId(requested, 'Branch')
  }

  async function resolveBranch(client, req, requested) {
    const branchId = branchFilter(req, requested)
    if (branchId == null) return null
    const result = await client.query(
      'SELECT id, status FROM branches WHERE id = $1 AND school_id = $2',
      [branchId, req.user.tenant_id]
    )
    if (!result.rows.length) fail(400, 'The selected branch does not belong to this school.')
    if (result.rows[0].status !== 'active') fail(409, 'The selected branch is inactive and cannot receive new financial records.')
    return branchId
  }

  function addBranchWhere(req, requested, alias, params) {
    const branchId = branchFilter(req, requested)
    if (branchId == null) return ''
    params.push(branchId)
    return ' AND ' + alias + '.branch_id = $' + params.length
  }

  async function ensureTenantDefaults(client, req) {
    const tenantId = req.user.tenant_id
    const org = await client.query('SELECT status FROM organizations WHERE school_code = $1', [tenantId])
    if (!org.rows.length || org.rows[0].status !== 'active') return

    for (const [name, key] of EMPLOYEE_CATEGORIES) {
      await client.query(
        `INSERT INTO employee_categories (tenant_id, name, category_key, is_system)
         VALUES ($1, $2, $3, true) ON CONFLICT (tenant_id, category_key) DO NOTHING`,
        [tenantId, name, key]
      )
    }
    for (const [name, key] of EXPENSE_CATEGORIES) {
      await client.query(
        `INSERT INTO expense_categories (tenant_id, name, category_key)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, category_key) DO NOTHING`,
        [tenantId, name, key]
      )
    }
    await client.query(
      `INSERT INTO finance_accounts (tenant_id, name, currency)
       VALUES ($1, 'Main Cash', 'PKR') ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId]
    )
  }

  async function assertCategory(client, table, id, tenantId) {
    const result = await client.query(
      `SELECT id, is_active FROM ${table} WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    )
    if (!result.rows.length) fail(404, 'Category was not found for this school.')
    if (!result.rows[0].is_active) fail(409, 'Inactive categories cannot be assigned to new records.')
  }

  async function assertCurrencyAccount(client, req, accountId, currency, recordBranch) {
    const result = await client.query(
      `SELECT id, branch_id, currency
       FROM finance_accounts
       WHERE id = $1 AND tenant_id = $2 AND is_active = true
       FOR UPDATE`,
      [accountId, req.user.tenant_id]
    )
    const account = result.rows[0]
    if (!account) fail(404, 'Active financial account was not found for this school.')
    if (account.currency.trim() !== currency) fail(400, 'Payment currency must match the selected account.')
    if (account.branch_id != null && (recordBranch == null || Number(account.branch_id) !== Number(recordBranch))) {
      fail(400, 'The financial account belongs to a different branch.')
    }
    return account
  }

  async function calculatePaid(client, paymentTable, paymentForeignKey, parentId, tenantId) {
    const result = await client.query(
      `SELECT COALESCE(SUM(p.amount), 0)::numeric(12,2) AS paid
       FROM ${paymentTable} p
       JOIN financial_transactions tx
         ON tx.tenant_id = p.tenant_id
        AND tx.source_type = $3
        AND tx.source_id = p.id::text
       WHERE p.tenant_id = $1
         AND p.${paymentForeignKey} = $2
         AND NOT EXISTS (
           SELECT 1 FROM financial_transactions reversal
           WHERE reversal.reversal_of_id = tx.id
         )`,
      [tenantId, parentId, paymentTable === 'payroll_payments' ? 'payroll_payment' : 'expense_payment']
    )
    return result.rows[0].paid
  }

  async function getPayrollEntries(client, tenantId, { periodId, month, branchId } = {}) {
    const params = [tenantId]
    let where = 'pe.tenant_id = $1'
    if (periodId != null) {
      params.push(periodId)
      where += ' AND pe.payroll_period_id = $' + params.length
    }
    if (month) {
      params.push(month + '-01')
      where += ` AND pp.period_start >= $${params.length}::date
                 AND pp.period_start < ($${params.length}::date + INTERVAL '1 month')`
    }
    if (branchId != null) {
      params.push(branchId)
      where += ' AND COALESCE(pp.branch_id, s.branch_id) = $' + params.length
    }
    const result = await client.query(
      `SELECT pe.id, pe.payroll_period_id, pe.employee_id, pe.payment_basis,
              pe.rate_snapshot, pe.payable_units, pe.gross_amount, pe.amount_due,
              pe.currency, pe.due_date, pe.status, pp.period_start, pp.period_end,
              COALESCE(pp.branch_id,s.branch_id) AS branch_id, s.employee_number, s.teacher_id, s.name AS staff_name,
              COALESCE(t.name, s.name) AS employee_name,
              COALESCE(adj.total, 0)::numeric(12,2) AS adjustments_total,
              COALESCE(adv.total, 0)::numeric(12,2) AS advance_credit,
              COALESCE(pay.paid, 0)::numeric(12,2) AS amount_paid,
              GREATEST(pe.amount_due - COALESCE(pay.paid, 0), 0)::numeric(12,2) AS outstanding,
              CASE
                WHEN COALESCE(pay.paid, 0) = 0 THEN 'unpaid'
                WHEN COALESCE(pay.paid, 0) < pe.amount_due THEN 'partially_paid'
                ELSE 'paid'
              END AS payment_status
       FROM payroll_entries pe
       JOIN payroll_periods pp ON pp.id = pe.payroll_period_id AND pp.tenant_id = pe.tenant_id
       JOIN staff_members s ON s.id = pe.employee_id AND s.tenant_id = pe.tenant_id
       LEFT JOIN teachers t ON t.id = s.teacher_id AND t.tenant_id = s.tenant_id
       LEFT JOIN LATERAL (
         SELECT SUM(CASE WHEN a.adjustment_type = 'deduction' THEN -a.amount ELSE a.amount END) AS total
         FROM payroll_adjustments a WHERE a.tenant_id = pe.tenant_id AND a.payroll_entry_id = pe.id
       ) adj ON true
       LEFT JOIN LATERAL (
         SELECT SUM(a.amount) AS total FROM payroll_advance_allocations a
         WHERE a.tenant_id = pe.tenant_id AND a.payroll_entry_id = pe.id
       ) adv ON true
       LEFT JOIN LATERAL (
         SELECT SUM(p.amount) AS paid
         FROM payroll_payments p
         JOIN financial_transactions tx ON tx.tenant_id = p.tenant_id
           AND tx.source_type = 'payroll_payment' AND tx.source_id = p.id::text
         WHERE p.tenant_id = pe.tenant_id AND p.payroll_entry_id = pe.id
           AND NOT EXISTS (SELECT 1 FROM financial_transactions rev WHERE rev.reversal_of_id = tx.id)
       ) pay ON true
       WHERE ${where}
       ORDER BY pp.period_start DESC, employee_name`,
      params
    )
    return result.rows
  }

  async function getExpenseObligations(client, tenantId, { month, categoryId, status, branchId } = {}) {
    const params = [tenantId]
    let where = 'o.tenant_id = $1'
    if (month) {
      params.push(month + '-01')
      where += ` AND COALESCE(o.period_start,o.due_date,o.created_at::date) >= $${params.length}::date
                   AND COALESCE(o.period_start,o.due_date,o.created_at::date) < ($${params.length}::date + INTERVAL '1 month')`
    }
    if (categoryId != null) {
      params.push(categoryId)
      where += ' AND o.category_id = $' + params.length
    }
    if (branchId != null) {
      params.push(branchId)
      where += ' AND o.branch_id = $' + params.length
    }
    if (status && status !== 'all') {
      if (!['unpaid', 'partially_paid', 'paid'].includes(status)) fail(400, 'Payment status filter is invalid.')
      where += ` AND CASE
        WHEN COALESCE(pay.paid, 0) = 0 THEN 'unpaid'
        WHEN COALESCE(pay.paid, 0) < o.amount_due THEN 'partially_paid'
        ELSE 'paid'
      END = '${status}'`
    }
    const result = await client.query(
      `SELECT o.*, c.name AS category_name,
              COALESCE(pay.paid, 0)::numeric(12,2) AS amount_paid,
              GREATEST(o.amount_due - COALESCE(pay.paid, 0), 0)::numeric(12,2) AS outstanding,
              CASE
                WHEN COALESCE(pay.paid, 0) = 0 THEN 'unpaid'
                WHEN COALESCE(pay.paid, 0) < o.amount_due THEN 'partially_paid'
                ELSE 'paid'
              END AS payment_status,
              est.amount AS estimate_amount
       FROM expense_obligations o
       JOIN expense_categories c ON c.id = o.category_id AND c.tenant_id = o.tenant_id
       LEFT JOIN LATERAL (
         SELECT SUM(p.amount) AS paid
         FROM expense_payments p
         JOIN financial_transactions tx ON tx.tenant_id = p.tenant_id
           AND tx.source_type = 'expense_payment' AND tx.source_id = p.id::text
         WHERE p.tenant_id = o.tenant_id AND p.obligation_id = o.id
           AND NOT EXISTS (SELECT 1 FROM financial_transactions rev WHERE rev.reversal_of_id = tx.id)
       ) pay ON true
       LEFT JOIN expense_estimates est ON est.tenant_id = o.tenant_id
         AND est.template_id = o.template_id AND est.period_start = o.period_start
       WHERE ${where}
       ORDER BY COALESCE(o.due_date, o.period_start, o.created_at::date) DESC, o.id DESC`,
      params
    )
    return result.rows
  }

  async function postPayment(req, kind, parentId) {
    const tenantId = req.user.tenant_id
    const isPayroll = kind === 'payroll'
    const table = isPayroll ? 'payroll_payments' : 'expense_payments'
    const parentTable = isPayroll ? 'payroll_entries' : 'expense_obligations'
    const parentField = isPayroll ? 'payroll_entry_id' : 'obligation_id'
    const sourceType = isPayroll ? 'payroll_payment' : 'expense_payment'
    const idempotencyKey = requiredText(req.body && req.body.idempotency_key, 'Idempotency key', 80)
    const amount = validAmount(req.body && req.body.amount, 'Payment amount')
    const paymentDate = validDate(req.body && req.body.payment_date, 'Payment date')
    const method = validMethod(req.body && req.body.payment_method)
    const reference = optionalText(req.body && req.body.reference, 120)
    const currency = validCurrency(req.body && req.body.currency)
    const accountId = positiveId(req.body && req.body.account_id, 'Account')

    return transaction(async client => {
      const prior = await client.query(
        `SELECT * FROM ${table} WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      )
      if (prior.rows.length) return { ...prior.rows[0], duplicate: true }

      const parentResult = isPayroll
        ? await client.query(
          `SELECT pe.id, pe.amount_due, pe.status, pe.currency,
                  COALESCE(pp.branch_id, s.branch_id) AS branch_id
           FROM payroll_entries pe
           JOIN payroll_periods pp ON pp.id = pe.payroll_period_id AND pp.tenant_id = pe.tenant_id
           JOIN staff_members s ON s.id=pe.employee_id AND s.tenant_id=pe.tenant_id
           WHERE pe.id = $1 AND pe.tenant_id = $2 FOR UPDATE OF pe`,
          [parentId, tenantId]
        )
        : await client.query(
          'SELECT id, amount_due, currency, branch_id FROM expense_obligations WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
          [parentId, tenantId]
        )
      const parent = parentResult.rows[0]
      if (!parent) fail(404, isPayroll ? 'Payroll entry was not found.' : 'Expense obligation was not found.')
      if (req.user.branch_id != null && Number(parent.branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'The financial record was not found.')
      }
      if (isPayroll && parent.status !== 'approved') fail(409, 'Approve the payroll period before recording payments.')
      if (parent.currency.trim() !== currency) fail(400, 'Payment currency must match the obligation currency.')

      const alreadyPaid = await calculatePaid(client, table, parentField, parentId, tenantId)
      const remainingCents = amountToCents(parent.amount_due) - amountToCents(alreadyPaid)
      if (remainingCents <= 0n) fail(409, 'This obligation has no remaining balance.')
      if (amountToCents(amount) > remainingCents) fail(400, 'Payment exceeds the remaining obligation balance.')

      const recordBranch = parent.branch_id == null ? null : Number(parent.branch_id)
      await assertCurrencyAccount(client, req, accountId, currency, recordBranch)

      const inserted = isPayroll
        ? await client.query(
          `INSERT INTO payroll_payments
             (tenant_id, payroll_entry_id, account_id, amount, currency, payment_date,
              payment_method, reference, idempotency_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [tenantId, parentId, accountId, amount, currency, paymentDate, method, reference, idempotencyKey, req.user.user_id]
        )
        : await client.query(
          `INSERT INTO expense_payments
             (tenant_id, obligation_id, account_id, amount, currency, payment_date,
              payment_method, reference, idempotency_key, receipt_reference, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            tenantId, parentId, accountId, amount, currency, paymentDate, method, reference,
            idempotencyKey, optionalText(req.body && req.body.receipt_reference, 500), req.user.user_id
          ]
        )
      const payment = inserted.rows[0]

      await client.query(
        `INSERT INTO financial_transactions
           (tenant_id, branch_id, account_id, transaction_type, direction, amount, currency,
            transaction_date, source_type, source_id, idempotency_key, payment_method, reference, created_by)
         VALUES ($1,$2,$3,'expense','out',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          tenantId, recordBranch, accountId, amount, currency, paymentDate, sourceType,
          String(payment.id), sourceType + ':' + idempotencyKey, method, reference, req.user.user_id
        ]
      )
      await audit(client, req, tenantId, 'payment_recorded', sourceType, payment.id, {
        parent_id: parentId,
        amount,
        currency,
        payment_date: paymentDate,
        payment_method: method
      })
      return payment
    })
  }

  router.get('/bootstrap', route(async (req, res) => {
    const tenantId = req.user.tenant_id
    const result = await transaction(async client => {
      await ensureTenantDefaults(client, req)
      const accountParams = [tenantId]
      const accountBranch = addBranchWhere(req, req.query.branch_id, 'a', accountParams)
      const [employeeCategories, expenseCategories, accounts, branches] = await Promise.all([
        client.query('SELECT id, name, category_key, is_system, is_active FROM employee_categories WHERE tenant_id=$1 ORDER BY name', [tenantId]),
        client.query('SELECT id, name, category_key, is_active FROM expense_categories WHERE tenant_id=$1 ORDER BY name', [tenantId]),
        client.query(
          `SELECT id, name, currency, branch_id, opening_balance, opening_balance_date
           FROM finance_accounts a WHERE a.tenant_id=$1 AND a.is_active=true${accountBranch}
           ORDER BY branch_id NULLS FIRST, name`,
          accountParams
        ),
        client.query(
          `SELECT id, name, status FROM branches
           WHERE school_id=$1 AND status='active'
           ORDER BY name`,
          [tenantId]
        )
      ])
      return {
        employee_categories: employeeCategories.rows,
        expense_categories: expenseCategories.rows,
        accounts: accounts.rows,
        branches: req.user.branch_id == null
          ? branches.rows
          : branches.rows.filter(branch => Number(branch.id) === Number(req.user.branch_id))
      }
    })
    res.json(result)
  }))

  router.get('/overview', route(async (req, res) => {
    const tenantId = req.user.tenant_id
    const month = String(req.query.month || new Date().toISOString().slice(0, 7))
    const bounds = monthBounds(month)
    if (!bounds) fail(400, 'Month must be in YYYY-MM format.')
    const branchId = branchFilter(req, req.query.branch_id)
    const openingAccountParams = [tenantId, bounds.start]
    const openingAccountBranch = branchId == null ? '' : (openingAccountParams.push(branchId), ' AND a.branch_id = $' + openingAccountParams.length)
    const monthlyAccountParams = [tenantId, bounds.start, bounds.end]
    const monthlyAccountBranch = branchId == null ? '' : (monthlyAccountParams.push(branchId), ' AND a.branch_id = $' + monthlyAccountParams.length)
    const transactionParams = [tenantId, bounds.start, bounds.end]
    const monthlyTransactionBranch = branchId == null ? '' : (transactionParams.push(branchId), ' AND t.branch_id = $' + transactionParams.length)
    const openingTransactionParams = [tenantId, bounds.start]
    const openingTransactionBranch = branchId == null ? '' : (openingTransactionParams.push(branchId), ' AND t.branch_id = $' + openingTransactionParams.length)
    const obligationParams = [tenantId, bounds.end]
    const obligationBranch = branchId == null ? '' : (obligationParams.push(branchId), ' AND o.branch_id = $' + obligationParams.length)
    const payrollParams = [tenantId, bounds.start, bounds.end]
    const payrollBranch = branchId == null ? '' : (payrollParams.push(branchId), ' AND COALESCE(pp.branch_id, s.branch_id) = $' + payrollParams.length)

    const opening = await pool.query(
      `SELECT COALESCE(SUM(a.opening_balance),0)::numeric(14,2) AS opening
       FROM finance_accounts a
       WHERE a.tenant_id=$1 AND a.is_active=true
         AND a.opening_balance_date < $2::date
         AND a.created_at::date < $2::date${openingAccountBranch}`,
      openingAccountParams
    )
    const openingMovement = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0)::numeric(14,2) AS movement
       FROM financial_transactions t
       WHERE t.tenant_id=$1 AND t.transaction_date < $2::date${openingTransactionBranch}`,
      openingTransactionParams
    )
    const cash = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0)::numeric(14,2) AS movement
       FROM financial_transactions t
       WHERE t.tenant_id=$1 AND t.transaction_date BETWEEN $2::date AND $3::date${monthlyTransactionBranch}`,
      transactionParams
    )
    const accountOpeningsThisMonth = await pool.query(
      `SELECT COALESCE(SUM(a.opening_balance),0)::numeric(14,2) AS opening
       FROM finance_accounts a
       WHERE a.tenant_id=$1 AND a.is_active=true
         AND a.created_at::date <= $3::date
         AND (
           a.opening_balance_date BETWEEN $2::date AND $3::date
           OR a.created_at::date BETWEEN $2::date AND $3::date
         )${monthlyAccountBranch}`,
      monthlyAccountParams
    )
    const monthly = await pool.query(
      `SELECT
         COALESCE(SUM(CASE
           WHEN t.transaction_type='income' THEN t.amount
           WHEN t.transaction_type='reversal' AND original.transaction_type='income' THEN -t.amount
           ELSE 0 END),0)::numeric(14,2) AS income,
         COALESCE(SUM(CASE
           WHEN t.transaction_type='expense' THEN t.amount
           WHEN t.transaction_type='reversal' AND original.transaction_type='expense' THEN -t.amount
           ELSE 0 END),0)::numeric(14,2) AS expenses,
         COALESCE(SUM(CASE
           WHEN t.source_type IN ('payroll_payment','payroll_advance') AND t.transaction_type='expense' THEN t.amount
           WHEN t.transaction_type='reversal' AND original.source_type IN ('payroll_payment','payroll_advance') THEN -t.amount
           ELSE 0 END),0)::numeric(14,2) AS payroll_paid,
         COALESCE(SUM(CASE
           WHEN t.source_type='expense_payment' AND t.transaction_type='expense' THEN t.amount
           WHEN t.transaction_type='reversal' AND original.source_type='expense_payment' THEN -t.amount
           ELSE 0 END),0)::numeric(14,2) AS other_expenses
       FROM financial_transactions t
       LEFT JOIN financial_transactions original ON original.id=t.reversal_of_id
       WHERE t.tenant_id=$1 AND t.transaction_date BETWEEN $2::date AND $3::date${monthlyTransactionBranch}`,
      transactionParams
    )
    const payroll = await pool.query(
      `SELECT COALESCE(SUM(pe.amount_due) FILTER (
                WHERE pp.period_start BETWEEN $2::date AND $3::date
              ),0)::numeric(14,2) AS expected,
              COALESCE(SUM(GREATEST(pe.amount_due-COALESCE(pay.paid,0),0)),0)::numeric(14,2) AS outstanding
       FROM payroll_entries pe
       JOIN payroll_periods pp ON pp.id=pe.payroll_period_id AND pp.tenant_id=pe.tenant_id
       JOIN staff_members s ON s.id=pe.employee_id AND s.tenant_id=pe.tenant_id
       LEFT JOIN LATERAL (
         SELECT SUM(p.amount) AS paid
         FROM payroll_payments p
         JOIN financial_transactions tx ON tx.tenant_id=p.tenant_id
           AND tx.source_type='payroll_payment' AND tx.source_id=p.id::text
         WHERE p.tenant_id=pe.tenant_id AND p.payroll_entry_id=pe.id
           AND NOT EXISTS (SELECT 1 FROM financial_transactions rev WHERE rev.reversal_of_id=tx.id)
       ) pay ON true
       WHERE pe.tenant_id=$1 AND pp.period_start <= $3::date
         AND pp.period_end <= $3::date AND pp.created_at::date <= $3::date
         AND pe.status='approved'${payrollBranch}`,
      payrollParams
    )
    const expensesDue = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(o.amount_due-COALESCE(pay.paid,0),0)),0)::numeric(14,2) AS outstanding
       FROM expense_obligations o
       LEFT JOIN LATERAL (
         SELECT SUM(p.amount) AS paid
         FROM expense_payments p
         JOIN financial_transactions tx ON tx.tenant_id=p.tenant_id
           AND tx.source_type='expense_payment' AND tx.source_id=p.id::text
         WHERE p.tenant_id=o.tenant_id AND p.obligation_id=o.id
           AND NOT EXISTS (SELECT 1 FROM financial_transactions rev WHERE rev.reversal_of_id=tx.id)
       ) pay ON true
       WHERE o.tenant_id=$1 AND (o.due_date IS NULL OR o.due_date <= $2::date)
         AND o.created_at::date <= $2::date${obligationBranch}`,
      obligationParams
    )
    const estimateParams = [tenantId, bounds.start, bounds.end]
    let estimateBranch = ''
    if (branchId != null) {
      estimateParams.push(branchId)
      estimateBranch = ' AND r.branch_id = $' + estimateParams.length
    }
    const estimates = await pool.query(
      `SELECT COALESCE(SUM(e.amount),0)::numeric(14,2) AS total
       FROM expense_estimates e
       JOIN recurring_expense_templates r ON r.id=e.template_id AND r.tenant_id=e.tenant_id
       WHERE e.tenant_id=$1 AND e.period_start BETWEEN $2::date AND $3::date${estimateBranch}`,
      estimateParams
    )

    const openingCash = amountToCents(opening.rows[0].opening) + amountToCents(openingMovement.rows[0].movement)
    const actualCash = openingCash + amountToCents(cash.rows[0].movement) + amountToCents(accountOpeningsThisMonth.rows[0].opening)
    const payrollOutstanding = amountToCents(payroll.rows[0].outstanding)
    const expenseOutstanding = amountToCents(expensesDue.rows[0].outstanding)
    const outstanding = payrollOutstanding + expenseOutstanding
    res.json({
      month,
      currency: 'PKR',
      opening_cash: centsToAmount(openingCash),
      actual_cash: centsToAmount(actualCash),
      total_income: monthly.rows[0].income,
      total_expenses_paid: monthly.rows[0].expenses,
      outstanding_obligations: centsToAmount(outstanding),
      expected_payroll: payroll.rows[0].expected,
      payroll_paid: monthly.rows[0].payroll_paid,
      other_expenses: monthly.rows[0].other_expenses,
      estimated_future_expenses: estimates.rows[0].total,
      available_after_obligations: centsToAmount(actualCash - outstanding)
    })
  }))

  router.get('/accounts', route(async (req, res) => {
    const tenantId = req.user.tenant_id
    const params = [tenantId]
    const branch = addBranchWhere(req, req.query.branch_id, 'a', params)
    const result = await pool.query(
      `SELECT a.id, a.name, a.currency, a.branch_id, a.opening_balance, a.opening_balance_date,
              a.is_active, COALESCE(b.name, 'School-wide') AS branch_name
       FROM finance_accounts a LEFT JOIN branches b ON b.id=a.branch_id AND b.school_id=a.tenant_id
       WHERE a.tenant_id=$1${branch} ORDER BY a.branch_id NULLS FIRST, a.name`,
      params
    )
    res.json(result.rows)
  }))

  router.post('/accounts', route(async (req, res) => {
    const name = requiredText(req.body && req.body.name, 'Account name', 100)
    const currency = validCurrency(req.body && req.body.currency)
    const openingBalance = validAmount(req.body && req.body.opening_balance || '0', 'Opening balance', { allowZero: true })
    const openingDate = validDate(req.body && req.body.opening_balance_date || new Date().toISOString().slice(0, 10), 'Opening balance date')
    const account = await transaction(async client => {
      const branchId = await resolveBranch(client, req, req.body && req.body.branch_id)
      const result = await client.query(
        `INSERT INTO finance_accounts
           (tenant_id, branch_id, name, currency, opening_balance, opening_balance_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user.tenant_id, branchId, name, currency, openingBalance, openingDate, req.user.user_id]
      )
      await audit(client, req, req.user.tenant_id, 'account_created', 'finance_account', result.rows[0].id, {
        name, currency, opening_balance: openingBalance, opening_balance_date: openingDate, branch_id: branchId
      })
      return result.rows[0]
    })
    res.status(201).json(account)
  }))

  router.put('/accounts/:id/opening-balance', route(async (req, res) => {
    const accountId = positiveId(req.params.id, 'Account')
    const amount = validAmount(req.body && req.body.opening_balance, 'Opening balance', { allowZero: true })
    const date = validDate(req.body && req.body.opening_balance_date, 'Opening balance date')
    const result = await transaction(async client => {
      const account = await client.query(
        'SELECT * FROM finance_accounts WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [accountId, req.user.tenant_id]
      )
      if (!account.rows.length) fail(404, 'Financial account was not found.')
      if (req.user.branch_id != null && Number(account.rows[0].branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'Financial account was not found.')
      }
      const transactions = await client.query(
        'SELECT 1 FROM financial_transactions WHERE tenant_id=$1 AND account_id=$2 LIMIT 1',
        [req.user.tenant_id, accountId]
      )
      if (transactions.rowCount) fail(409, 'Opening balance is locked after an account has financial activity.')
      const updated = await client.query(
        `UPDATE finance_accounts
         SET opening_balance=$1, opening_balance_date=$2
         WHERE id=$3 AND tenant_id=$4 RETURNING *`,
        [amount, date, accountId, req.user.tenant_id]
      )
      await audit(client, req, req.user.tenant_id, 'opening_balance_set', 'finance_account', accountId, {
        previous: account.rows[0].opening_balance,
        opening_balance: amount,
        opening_balance_date: date
      })
      return updated.rows[0]
    })
    res.json(result)
  }))

  router.post('/income', route(async (req, res) => {
    const amount = validAmount(req.body && req.body.amount, 'Income amount')
    const date = validDate(req.body && req.body.transaction_date, 'Income date')
    const method = validMethod(req.body && req.body.payment_method)
    const currency = validCurrency(req.body && req.body.currency)
    const accountId = positiveId(req.body && req.body.account_id, 'Account')
    const idempotencyKey = requiredText(req.body && req.body.idempotency_key, 'Idempotency key', 80)
    const reference = optionalText(req.body && req.body.reference, 120)
    const memo = optionalText(req.body && req.body.memo, 500)
    const result = await transaction(async client => {
      const prior = await client.query(
        'SELECT * FROM financial_transactions WHERE tenant_id=$1 AND idempotency_key=$2',
        [req.user.tenant_id, 'income:' + idempotencyKey]
      )
      if (prior.rows.length) return prior.rows[0]
      const branchId = await resolveBranch(client, req, req.body && req.body.branch_id)
      await assertCurrencyAccount(client, req, accountId, currency, branchId)
      const transactionResult = await client.query(
        `INSERT INTO financial_transactions
           (tenant_id, branch_id, account_id, transaction_type, direction, amount, currency,
            transaction_date, source_type, source_id, idempotency_key, payment_method, reference, memo, created_by)
         VALUES ($1,$2,$3,'income','in',$4,$5,$6,'manual_income',$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          req.user.tenant_id, branchId, accountId, amount, currency, date,
          idempotencyKey, 'income:' + idempotencyKey, method, reference, memo, req.user.user_id
        ]
      )
      const entry = transactionResult.rows[0]
      await audit(client, req, req.user.tenant_id, 'income_recorded', 'financial_transaction', entry.id, {
        amount, currency, transaction_date: date, branch_id: branchId
      })
      return entry
    })
    res.status(201).json(result)
  }))

  router.get('/transactions', route(async (req, res) => {
    const tenantId = req.user.tenant_id
    const params = [tenantId]
    let where = 't.tenant_id=$1'
    const branch = addBranchWhere(req, req.query.branch_id, 't', params)
    where += branch
    if (req.query.from) {
      params.push(validDate(req.query.from, 'Start date'))
      where += ' AND t.transaction_date >= $' + params.length
    }
    if (req.query.to) {
      params.push(validDate(req.query.to, 'End date'))
      where += ' AND t.transaction_date <= $' + params.length
    }
    const result = await pool.query(
      `SELECT t.id, t.transaction_type, t.direction, t.amount, t.currency, t.transaction_date,
              t.source_type, t.reference, t.memo, t.reversal_of_id, t.created_at,
              a.name AS account_name,
              CASE WHEN rev.id IS NULL THEN false ELSE true END AS is_reversed
       FROM financial_transactions t
       JOIN finance_accounts a ON a.id=t.account_id AND a.tenant_id=t.tenant_id
       LEFT JOIN financial_transactions rev ON rev.reversal_of_id=t.id
       WHERE ${where}
       ORDER BY t.transaction_date DESC, t.id DESC LIMIT 200`,
      params
    )
    res.json(result.rows)
  }))

  router.post('/transactions/:id/reverse', route(async (req, res) => {
    const transactionId = positiveId(req.params.id, 'Transaction')
    const reason = requiredText(req.body && req.body.reason, 'Reversal reason', 500)
    const key = requiredText(req.body && req.body.idempotency_key, 'Idempotency key', 80)
    const result = await transaction(async client => {
      const prior = await client.query(
        `SELECT * FROM financial_transactions
         WHERE tenant_id=$1 AND idempotency_key=$2`,
        [req.user.tenant_id, 'reversal:' + key]
      )
      if (prior.rows.length) return prior.rows[0]
      const originalResult = await client.query(
        'SELECT * FROM financial_transactions WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [transactionId, req.user.tenant_id]
      )
      const original = originalResult.rows[0]
      if (!original || original.transaction_type === 'reversal') fail(404, 'Reversible transaction was not found.')
      if (req.user.branch_id != null && Number(original.branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'Reversible transaction was not found.')
      }
      if (original.source_type === 'payroll_advance') {
        const allocation = await client.query(
          `SELECT 1 FROM payroll_advance_allocations a
           WHERE a.tenant_id=$1 AND a.advance_id=$2 LIMIT 1`,
          [req.user.tenant_id, original.source_id]
        )
        if (allocation.rowCount) fail(409, 'An advance already applied to payroll cannot be reversed.')
      }
      const inserted = await client.query(
        `INSERT INTO financial_transactions
           (tenant_id, branch_id, account_id, transaction_type, direction, amount, currency,
            transaction_date, source_type, source_id, idempotency_key, payment_method, reference,
            memo, reversal_of_id, created_by)
         VALUES ($1,$2,$3,'reversal',$4,$5,$6,CURRENT_DATE,'reversal',$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          req.user.tenant_id, original.branch_id, original.account_id,
          original.direction === 'in' ? 'out' : 'in',
          original.amount, original.currency, String(original.id),
          'reversal:' + key, original.payment_method, original.reference, reason, original.id, req.user.user_id
        ]
      )
      await audit(client, req, req.user.tenant_id, 'transaction_reversed', 'financial_transaction', original.id, {
        reversal_id: inserted.rows[0].id,
        amount: original.amount,
        direction: original.direction
      }, reason)
      return inserted.rows[0]
    })
    res.status(201).json(result)
  }))

  router.get('/employees', route(async (req, res) => {
    const tenantId = req.user.tenant_id
    const params = [tenantId]
    let where = 's.tenant_id=$1'
    if (req.query.status && req.query.status !== 'all') {
      params.push(validEnum(req.query.status, ['active', 'on_leave', 'left', 'inactive'], 'Employee status'))
      where += ' AND s.employment_status=$' + params.length
    }
    if (req.query.search) {
      const search = '%' + String(req.query.search).trim().slice(0, 80) + '%'
      params.push(search)
      where += ` AND (COALESCE(t.name,s.name) ILIKE $${params.length}
                  OR COALESCE(s.employee_number,'') ILIKE $${params.length}
                  OR COALESCE(s.job_title,'') ILIKE $${params.length})`
    }
    const branch = addBranchWhere(req, req.query.branch_id, 's', params)
    where += branch
    const result = await pool.query(
      `SELECT s.id, s.tenant_id, s.branch_id, s.teacher_id, s.category_id, s.employee_number,
              COALESCE(t.name,s.name) AS name, s.job_title, s.phone, s.email, s.employee_identifier,
              s.joining_date, s.last_working_date, s.employment_type, s.employment_status,
              s.payment_basis, s.notes, c.name AS category_name, comp_current.amount AS current_rate,
              comp_current.payment_frequency, comp_current.currency, comp_current.effective_from, comp_current.effective_to
       FROM staff_members s
       JOIN employee_categories c ON c.id=s.category_id AND c.tenant_id=s.tenant_id
       LEFT JOIN teachers t ON t.id=s.teacher_id AND t.tenant_id=s.tenant_id
       LEFT JOIN LATERAL (
         SELECT amount, payment_frequency, currency, effective_from, effective_to
         FROM employee_compensation ec
         WHERE ec.tenant_id=s.tenant_id AND ec.employee_id=s.id AND ec.is_active=true
           AND ec.effective_from <= CURRENT_DATE
           AND (ec.effective_to IS NULL OR ec.effective_to >= CURRENT_DATE)
         ORDER BY ec.effective_from DESC LIMIT 1
       ) comp_current ON true
       WHERE ${where}
       ORDER BY s.employment_status, name`,
      params
    )
    res.json(result.rows)
  }))

  router.get('/employees/unlinked-teachers', route(async (req, res) => {
    const params = [req.user.tenant_id]
    const branch = addBranchWhere(req, req.query.branch_id, 't', params)
    const result = await pool.query(
      `SELECT t.id, t.name, t.phone, t.branch_id
       FROM teachers t
       WHERE t.tenant_id=$1
         AND NOT EXISTS (
           SELECT 1 FROM staff_members s WHERE s.tenant_id=t.tenant_id AND s.teacher_id=t.id
         )${branch}
       ORDER BY t.name`,
      params
    )
    res.json(result.rows)
  }))

  async function insertCompensation(client, req, employeeId, input) {
    const basis = validEnum(input.payment_basis, ['monthly', 'daily', 'hourly', 'contract'], 'Payment basis')
    const frequencies = ['monthly', 'weekly', 'biweekly', 'daily', 'hourly', 'per_contract']
    const frequency = validEnum(input.payment_frequency, frequencies, 'Payment frequency')
    if ((basis === 'monthly' && !['monthly'].includes(frequency)) ||
        (basis === 'daily' && !['daily', 'weekly', 'biweekly', 'monthly'].includes(frequency)) ||
        (basis === 'hourly' && !['weekly', 'biweekly', 'monthly', 'hourly'].includes(frequency)) ||
        (basis === 'contract' && frequency !== 'per_contract')) {
      fail(400, 'Payment frequency does not match the payment basis.')
    }
    const amount = validAmount(input.amount, 'Compensation amount')
    const currency = validCurrency(input.currency)
    const effectiveFrom = validDate(input.effective_from, 'Effective date')
    const effectiveTo = input.effective_to ? validDate(input.effective_to, 'Effective end date') : null
    if (effectiveTo && effectiveTo < effectiveFrom) fail(400, 'Effective end date must not precede the effective date.')
    const paymentDay = input.expected_payment_day == null || input.expected_payment_day === ''
      ? null
      : Number(input.expected_payment_day)
    if (paymentDay != null && (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31)) {
      fail(400, 'Expected payment day must be between 1 and 31.')
    }

    const later = await client.query(
      `SELECT id FROM employee_compensation
       WHERE tenant_id=$1 AND employee_id=$2 AND effective_from >= $3
       LIMIT 1 FOR UPDATE`,
      [req.user.tenant_id, employeeId, effectiveFrom]
    )
    if (later.rowCount) fail(409, 'A compensation record already starts on or after this effective date.')
    await client.query(
      `UPDATE employee_compensation
       SET effective_to = $1::date - 1
       WHERE tenant_id=$2 AND employee_id=$3 AND is_active=true
         AND effective_to IS NULL AND effective_from < $1::date`,
      [effectiveFrom, req.user.tenant_id, employeeId]
    )
    const result = await client.query(
      `INSERT INTO employee_compensation
         (tenant_id, employee_id, payment_basis, payment_frequency, amount, currency,
          expected_payment_day, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.tenant_id, employeeId, basis, frequency, amount, currency, paymentDay, effectiveFrom, effectiveTo, req.user.user_id]
    )
    await client.query(
      `UPDATE staff_members SET payment_basis=$1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$2 AND tenant_id=$3`,
      [basis, employeeId, req.user.tenant_id]
    )
    return result.rows[0]
  }

  router.post('/employees', route(async (req, res) => {
    const body = req.body || {}
    const categoryId = positiveId(body.category_id, 'Employee category')
    const employeeType = validEnum(body.employment_type, ['permanent', 'contract', 'temporary', 'part_time'], 'Employment type')
    const basis = validEnum(body.payment_basis, ['monthly', 'daily', 'hourly', 'contract'], 'Payment basis')
    const joiningDate = validDate(body.joining_date, 'Joining date')
    const teacherId = body.teacher_id ? positiveId(body.teacher_id, 'Teacher') : null
    const employeeName = teacherId ? null : requiredText(body.name, 'Employee name', 150)
    const employeeNumber = optionalText(body.employee_number, 50)
    const jobTitle = optionalText(body.job_title, 120)
    const phone = optionalText(body.phone, 50)
    const email = optionalText(body.email, 200)
    const identifier = optionalText(body.employee_identifier, 100)
    const employee = await transaction(async client => {
      await assertCategory(client, 'employee_categories', categoryId, req.user.tenant_id)
      const category = await client.query(
        'SELECT category_key FROM employee_categories WHERE id=$1 AND tenant_id=$2',
        [categoryId, req.user.tenant_id]
      )
      if (teacherId && category.rows[0].category_key !== 'teacher') {
        fail(400, 'Existing teachers must use the Teacher employee category.')
      }
      if (!teacherId && category.rows[0].category_key === 'teacher') {
        fail(400, 'The Teacher category can only be used for a linked teacher.')
      }
      let branchId = await resolveBranch(client, req, body.branch_id)
      if (teacherId) {
        const teacher = await client.query(
          'SELECT id, branch_id FROM teachers WHERE id=$1 AND tenant_id=$2',
          [teacherId, req.user.tenant_id]
        )
        if (!teacher.rows.length) fail(404, 'Teacher was not found for this school.')
        if (branchId == null && teacher.rows[0].branch_id != null) branchId = Number(teacher.rows[0].branch_id)
        if (branchId != null && teacher.rows[0].branch_id != null && Number(teacher.rows[0].branch_id) !== branchId) {
          fail(400, 'Teacher and payroll profile must use the same branch.')
        }
      }
      const inserted = await client.query(
        `INSERT INTO staff_members
           (tenant_id, branch_id, teacher_id, category_id, employee_number, name, job_title,
            phone, email, employee_identifier, joining_date, employment_type, payment_basis,
            created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          req.user.tenant_id, branchId, teacherId, categoryId, employeeNumber, employeeName,
          jobTitle, phone, email, identifier, joiningDate, employeeType, basis, req.user.user_id
        ]
      )
      if (body.compensation && typeof body.compensation === 'object') {
        await insertCompensation(client, req, inserted.rows[0].id, {
          ...body.compensation,
          payment_basis: basis,
          effective_from: body.compensation.effective_from || joiningDate
        })
      }
      await audit(client, req, req.user.tenant_id, 'employee_created', 'staff_member', inserted.rows[0].id, {
        teacher_id: teacherId,
        employee_number: employeeNumber,
        category_id: categoryId,
        branch_id: branchId
      })
      return inserted.rows[0]
    })
    res.status(201).json(employee)
  }))

  router.put('/employees/:id', route(async (req, res) => {
    const employeeId = positiveId(req.params.id, 'Employee')
    const body = req.body || {}
    const result = await transaction(async client => {
      const current = await client.query(
        'SELECT * FROM staff_members WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [employeeId, req.user.tenant_id]
      )
      if (!current.rows.length) fail(404, 'Employee was not found.')
      const row = current.rows[0]
      if (req.user.branch_id != null && Number(row.branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'Employee was not found.')
      }
      const categoryId = body.category_id == null ? row.category_id : positiveId(body.category_id, 'Employee category')
      await assertCategory(client, 'employee_categories', categoryId, req.user.tenant_id)
      const category = await client.query(
        'SELECT category_key FROM employee_categories WHERE id=$1 AND tenant_id=$2',
        [categoryId, req.user.tenant_id]
      )
      if (row.teacher_id && category.rows[0].category_key !== 'teacher') {
        fail(400, 'Existing teachers must use the Teacher employee category.')
      }
      if (!row.teacher_id && category.rows[0].category_key === 'teacher') {
        fail(400, 'The Teacher category can only be used for a linked teacher.')
      }
      const branchId = body.branch_id === undefined
        ? (req.user.branch_id != null ? Number(req.user.branch_id) : row.branch_id)
        : await resolveBranch(client, req, body.branch_id)
      const status = body.employment_status === undefined
        ? row.employment_status
        : validEnum(body.employment_status, ['active', 'on_leave', 'left', 'inactive'], 'Employment status')
      const leaveDate = body.last_working_date === undefined
        ? row.last_working_date
        : (body.last_working_date ? validDate(body.last_working_date, 'Last working date') : null)
      if (leaveDate && leaveDate < row.joining_date) fail(400, 'Last working date must not precede joining date.')
      if (status === 'left' && !leaveDate) fail(400, 'A last working date is required when an employee leaves.')
      if (status !== 'left' && leaveDate) fail(400, 'Clear the last working date before changing this employee to another status.')
      if (row.teacher_id && branchId != null) {
        const teacher = await client.query('SELECT branch_id FROM teachers WHERE id=$1 AND tenant_id=$2', [row.teacher_id, req.user.tenant_id])
        if (!teacher.rows.length || (teacher.rows[0].branch_id != null && Number(teacher.rows[0].branch_id) !== Number(branchId))) {
          fail(400, 'Teacher and payroll profile must use the same branch.')
        }
      }
      const updated = await client.query(
        `UPDATE staff_members
         SET branch_id=$1, category_id=$2, employee_number=$3, name=$4, job_title=$5,
             phone=$6, email=$7, employee_identifier=$8, last_working_date=$9,
             employment_status=$10, notes=$11, updated_at=CURRENT_TIMESTAMP
         WHERE id=$12 AND tenant_id=$13 RETURNING *`,
        [
          branchId, categoryId, optionalText(body.employee_number === undefined ? row.employee_number : body.employee_number, 50),
          row.teacher_id ? null : (body.name === undefined ? row.name : requiredText(body.name, 'Employee name', 150)),
          optionalText(body.job_title === undefined ? row.job_title : body.job_title, 120),
          optionalText(body.phone === undefined ? row.phone : body.phone, 50),
          optionalText(body.email === undefined ? row.email : body.email, 200),
          optionalText(body.employee_identifier === undefined ? row.employee_identifier : body.employee_identifier, 100),
          leaveDate, status, optionalText(body.notes === undefined ? row.notes : body.notes, 2000),
          employeeId, req.user.tenant_id
        ]
      )
      await audit(client, req, req.user.tenant_id, 'employee_updated', 'staff_member', employeeId, {
        branch_id: branchId,
        employment_status: status,
        last_working_date: leaveDate
      })
      return updated.rows[0]
    })
    res.json(result)
  }))

  router.get('/employees/:id/compensation', route(async (req, res) => {
    const employeeId = positiveId(req.params.id, 'Employee')
    const result = await pool.query(
      `SELECT ec.id, ec.payment_basis, ec.payment_frequency, ec.amount, ec.currency, ec.expected_payment_day,
              ec.effective_from, ec.effective_to, ec.is_active, ec.created_at
       FROM employee_compensation ec
       JOIN staff_members s ON s.id=ec.employee_id AND s.tenant_id=ec.tenant_id
       WHERE ec.employee_id=$1 AND ec.tenant_id=$2
         AND ($3::integer IS NULL OR s.branch_id=$3)
       ORDER BY ec.effective_from DESC`,
      [employeeId, req.user.tenant_id, req.user.branch_id == null ? null : Number(req.user.branch_id)]
    )
    res.json(result.rows)
  }))

  router.post('/employees/:id/compensation', route(async (req, res) => {
    const employeeId = positiveId(req.params.id, 'Employee')
    const result = await transaction(async client => {
      const employee = await client.query(
        'SELECT id, branch_id FROM staff_members WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [employeeId, req.user.tenant_id]
      )
      if (!employee.rows.length) fail(404, 'Employee was not found.')
      if (req.user.branch_id != null && Number(employee.rows[0].branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'Employee was not found.')
      }
      const compensation = await insertCompensation(client, req, employeeId, req.body || {})
      await audit(client, req, req.user.tenant_id, 'compensation_created', 'employee_compensation', compensation.id, {
        amount: compensation.amount,
        payment_basis: compensation.payment_basis,
        effective_from: compensation.effective_from,
        effective_to: compensation.effective_to
      })
      return compensation
    })
    res.status(201).json(result)
  }))

  router.post('/employee-categories', route(async (req, res) => {
    const name = requiredText(req.body && req.body.name, 'Category name', 100)
    const key = normalizeCategoryKey(name)
    if (!key) fail(400, 'Category name must include letters or numbers.')
    const category = await transaction(async client => {
      const result = await client.query(
        `INSERT INTO employee_categories (tenant_id, name, category_key, is_system, created_by)
         VALUES ($1,$2,$3,false,$4) RETURNING id, name, category_key, is_system, is_active`,
        [req.user.tenant_id, name, key, req.user.user_id]
      )
      await audit(client, req, req.user.tenant_id, 'employee_category_created', 'employee_category', result.rows[0].id, { name, category_key: key })
      return result.rows[0]
    })
    res.status(201).json(category)
  }))

  router.patch('/employee-categories/:id', route(async (req, res) => {
    const categoryId = positiveId(req.params.id, 'Category')
    const body = req.body || {}
    const updated = await transaction(async client => {
      const current = await client.query(
        'SELECT * FROM employee_categories WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [categoryId, req.user.tenant_id]
      )
      if (!current.rows.length) fail(404, 'Employee category was not found.')
      const name = body.name === undefined ? current.rows[0].name : requiredText(body.name, 'Category name', 100)
      const key = normalizeCategoryKey(name)
      if (!key) fail(400, 'Category name must include letters or numbers.')
      const active = body.is_active === undefined ? current.rows[0].is_active : validBoolean(body.is_active, 'Active state')
      if (current.rows[0].is_system && !active) fail(409, 'Built-in employee categories cannot be deactivated.')
      const result = await client.query(
        `UPDATE employee_categories SET name=$1, category_key=$2, is_active=$3
         WHERE id=$4 AND tenant_id=$5 RETURNING id, name, category_key, is_system, is_active`,
        [name, key, active, categoryId, req.user.tenant_id]
      )
      await audit(client, req, req.user.tenant_id, 'employee_category_updated', 'employee_category', categoryId, {
        before: { name: current.rows[0].name, is_active: current.rows[0].is_active },
        after: { name, is_active: active }
      })
      return result.rows[0]
    })
    res.json(updated)
  }))

  router.post('/payroll/eligible', route(async (req, res) => {
    const periodStart = validDate(req.body && req.body.period_start, 'Payroll period start')
    const periodEnd = validDate(req.body && req.body.period_end, 'Payroll period end')
    if (periodEnd < periodStart) fail(400, 'Payroll period end must be on or after the start.')
    const branchId = branchFilter(req, req.body && req.body.branch_id)
    const params = [req.user.tenant_id, periodStart, periodEnd]
    const branch = branchId == null ? '' : (params.push(branchId), ' AND s.branch_id=$' + params.length)
    const result = await pool.query(
      `SELECT s.id, s.employee_number, s.teacher_id, COALESCE(t.name,s.name) AS name,
              s.job_title, s.payment_basis AS staff_basis, s.joining_date, s.last_working_date,
              comp.id AS compensation_id, comp.payment_basis, comp.payment_frequency,
              comp.amount AS rate, comp.currency, comp.effective_from, comp.expected_payment_day,
              (s.joining_date > $2::date OR (s.last_working_date IS NOT NULL AND s.last_working_date < $3::date)
                OR comp.effective_from > $2::date) AS needs_proration_review
       FROM staff_members s
       LEFT JOIN teachers t ON t.id=s.teacher_id AND t.tenant_id=s.tenant_id
       JOIN LATERAL (
         SELECT ec.id, ec.payment_basis, ec.payment_frequency, ec.amount, ec.currency,
                ec.effective_from, ec.expected_payment_day
         FROM employee_compensation ec
         WHERE ec.tenant_id=s.tenant_id AND ec.employee_id=s.id AND ec.is_active=true
           AND ec.effective_from <= $3::date
           AND (ec.effective_to IS NULL OR ec.effective_to >= $2::date)
         ORDER BY ec.effective_from DESC LIMIT 1
       ) comp ON true
       WHERE s.tenant_id=$1
         AND s.joining_date <= $3::date
         AND (s.last_working_date IS NULL OR s.last_working_date >= $2::date)
         AND s.employment_status IN ('active','left','on_leave')${branch}
       ORDER BY name`,
      params
    )
    res.json(result.rows)
  }))

  router.get('/payroll', route(async (req, res) => {
    const month = req.query.month ? String(req.query.month) : null
    if (month && !monthBounds(month)) fail(400, 'Month must be in YYYY-MM format.')
    const result = await getPayrollEntries(pool, req.user.tenant_id, {
      month,
      branchId: branchFilter(req, req.query.branch_id)
    })
    res.json(result)
  }))

  router.post('/payroll/generate', route(async (req, res) => {
    const body = req.body || {}
    const periodStart = validDate(body.period_start, 'Payroll period start')
    const periodEnd = validDate(body.period_end, 'Payroll period end')
    const month = monthBounds(periodStart.slice(0, 7))
    if (!month || month.start !== periodStart || month.end !== periodEnd) {
      fail(400, 'Payroll periods must cover one complete calendar month.')
    }
    const branchId = await transaction(async client => {
      const resolved = await resolveBranch(client, req, body.branch_id)
      const created = await client.query(
        `INSERT INTO payroll_periods (tenant_id, branch_id, period_start, period_end, created_by)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
        [req.user.tenant_id, resolved, periodStart, periodEnd, req.user.user_id]
      )
      const periodResult = await client.query(
        `SELECT * FROM payroll_periods
         WHERE tenant_id=$1 AND branch_id IS NOT DISTINCT FROM $2::integer
           AND period_start=$3 AND period_end=$4 FOR UPDATE`,
        [req.user.tenant_id, resolved, periodStart, periodEnd]
      )
      const period = periodResult.rows[0]
      if (!period) fail(500, 'Payroll period could not be established.')
      const existing = await client.query(
        'SELECT 1 FROM payroll_entries WHERE tenant_id=$1 AND payroll_period_id=$2 LIMIT 1',
        [req.user.tenant_id, period.id]
      )
      if (existing.rowCount) return { created: false, periodId: period.id, branchId: resolved }

      const params = [req.user.tenant_id, periodStart, periodEnd]
      const branchClause = resolved == null ? '' : (params.push(resolved), ' AND s.branch_id=$' + params.length)
      const employees = await client.query(
        `SELECT s.id, s.joining_date, s.last_working_date, s.employment_status,
                comp.payment_basis, comp.payment_frequency, comp.amount, comp.currency,
                comp.effective_from, comp.expected_payment_day
         FROM staff_members s
         JOIN LATERAL (
           SELECT ec.payment_basis, ec.payment_frequency, ec.amount, ec.currency,
                  ec.effective_from, ec.expected_payment_day
           FROM employee_compensation ec
           WHERE ec.tenant_id=s.tenant_id AND ec.employee_id=s.id AND ec.is_active=true
             AND ec.effective_from <= $3::date
             AND (ec.effective_to IS NULL OR ec.effective_to >= $2::date)
           ORDER BY ec.effective_from DESC LIMIT 1
         ) comp ON true
         WHERE s.tenant_id=$1
           AND s.joining_date <= $3::date
           AND (s.last_working_date IS NULL OR s.last_working_date >= $2::date)
           AND s.employment_status IN ('active','left','on_leave')${branchClause}
         ORDER BY s.id`,
        params
      )
      if (!employees.rows.length) fail(400, 'No employees have eligible compensation for this period.')
      const inputs = new Map((Array.isArray(body.employees) ? body.employees : []).map(item => [String(item.employee_id), item]))

      for (const employee of employees.rows) {
        const input = inputs.get(String(employee.id)) || {}
        const basis = employee.payment_basis
        let units = '1.00'
        let gross
        const partialMonth = employee.joining_date > periodStart ||
          (employee.last_working_date && employee.last_working_date < periodEnd) ||
          employee.effective_from > periodStart
        if (basis === 'daily' || basis === 'hourly') {
          units = validAmount(input.payable_units, 'Payable days or hours')
          gross = calculateGross(employee.amount, units)
        } else if (partialMonth) {
          gross = validAmount(input.reviewed_gross_amount, 'Reviewed prorated amount', { allowZero: true })
        } else {
          gross = validAmount(employee.amount, 'Compensation amount')
        }
        if (gross === null) fail(400, 'Could not calculate payroll for employee ' + employee.id + '.')
        const dueDate = employee.expected_payment_day
          ? dueDateInMonth(periodStart, employee.expected_payment_day)
          : periodEnd
        const entryResult = await client.query(
          `INSERT INTO payroll_entries
             (tenant_id, payroll_period_id, employee_id, payment_basis, rate_snapshot,
              payable_units, gross_amount, amount_due, currency, due_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)
           RETURNING id`,
          [
            req.user.tenant_id, period.id, employee.id, basis, employee.amount,
            units, gross, employee.currency, dueDate, req.user.user_id
          ]
        )
        let remainingGross = amountToCents(gross)
        const advances = await client.query(
          `SELECT a.id, a.amount, COALESCE(allocated.amount,0)::numeric(12,2) AS allocated
           FROM payroll_advances a
           LEFT JOIN LATERAL (
             SELECT SUM(al.amount) AS amount FROM payroll_advance_allocations al
             WHERE al.tenant_id=a.tenant_id AND al.advance_id=a.id
           ) allocated ON true
           WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.currency=$3
            AND NOT EXISTS (
              SELECT 1
              FROM financial_transactions tx
              JOIN financial_transactions rev ON rev.reversal_of_id=tx.id
              WHERE tx.tenant_id=a.tenant_id AND tx.source_type='payroll_advance'
                AND tx.source_id=a.id::text
            )
           ORDER BY a.payment_date, a.id FOR UPDATE OF a`,
          [req.user.tenant_id, employee.id, employee.currency]
        )
        for (const advance of advances.rows) {
          if (remainingGross <= 0n) break
          const outstanding = amountToCents(advance.amount) - amountToCents(advance.allocated)
          if (outstanding <= 0n) continue
          const applied = outstanding < remainingGross ? outstanding : remainingGross
          await client.query(
            `INSERT INTO payroll_advance_allocations
               (tenant_id, advance_id, payroll_entry_id, amount, created_by)
             VALUES ($1,$2,$3,$4,$5)`,
            [req.user.tenant_id, advance.id, entryResult.rows[0].id, centsToAmount(applied), req.user.user_id]
          )
          remainingGross -= applied
        }
        await client.query(
          'UPDATE payroll_entries SET amount_due=$1 WHERE id=$2 AND tenant_id=$3',
          [centsToAmount(remainingGross), entryResult.rows[0].id, req.user.tenant_id]
        )
      }
      if (created.rowCount) {
        await audit(client, req, req.user.tenant_id, 'payroll_generated', 'payroll_period', period.id, {
          period_start: periodStart,
          period_end: periodEnd,
          employee_count: employees.rows.length,
          branch_id: resolved
        })
      }
      return { created: Boolean(created.rowCount), periodId: period.id, branchId: resolved }
    })
    const entries = await getPayrollEntries(pool, req.user.tenant_id, { periodId: branchId.periodId })
    res.status(branchId.created ? 201 : 200).json({ ...branchId, entries })
  }))

  router.post('/payroll/periods/:id/approve', route(async (req, res) => {
    const periodId = positiveId(req.params.id, 'Payroll period')
    const result = await transaction(async client => {
      const period = await client.query(
        'SELECT * FROM payroll_periods WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [periodId, req.user.tenant_id]
      )
      if (!period.rows.length) fail(404, 'Payroll period was not found.')
      if (req.user.branch_id != null && Number(period.rows[0].branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'Payroll period was not found.')
      }
      if (period.rows[0].status === 'closed') fail(409, 'Closed payroll periods cannot be changed.')
      await client.query(
        `UPDATE payroll_entries SET status='approved', approved_by=$1, approved_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$2 AND payroll_period_id=$3`,
        [req.user.user_id, req.user.tenant_id, periodId]
      )
      await client.query(
        `UPDATE payroll_periods SET status='approved', approved_by=$1, approved_at=CURRENT_TIMESTAMP
         WHERE id=$2 AND tenant_id=$3`,
        [req.user.user_id, periodId, req.user.tenant_id]
      )
      await audit(client, req, req.user.tenant_id, 'payroll_approved', 'payroll_period', periodId, {
        period_start: period.rows[0].period_start,
        period_end: period.rows[0].period_end
      })
      return { approved: true, period_id: periodId }
    })
    res.json(result)
  }))

  router.post('/payroll/entries/:id/adjustments', route(async (req, res) => {
    const entryId = positiveId(req.params.id, 'Payroll entry')
    const type = validEnum(req.body && req.body.adjustment_type, ['bonus', 'allowance', 'deduction'], 'Adjustment type')
    const amount = validAmount(req.body && req.body.amount, 'Adjustment amount')
    const description = requiredText(req.body && req.body.description, 'Adjustment description', 500)
    const result = await transaction(async client => {
      const entryResult = await client.query(
        `SELECT pe.* FROM payroll_entries pe
         JOIN payroll_periods pp ON pp.id=pe.payroll_period_id AND pp.tenant_id=pe.tenant_id
         JOIN staff_members s ON s.id=pe.employee_id AND s.tenant_id=pe.tenant_id
         WHERE pe.id=$1 AND pe.tenant_id=$2
           AND ($3::integer IS NULL OR COALESCE(pp.branch_id,s.branch_id)=$3)
         FOR UPDATE OF pe`,
        [entryId, req.user.tenant_id, req.user.branch_id == null ? null : Number(req.user.branch_id)]
      )
      const entry = entryResult.rows[0]
      if (!entry) fail(404, 'Payroll entry was not found.')
      if (entry.status !== 'draft') fail(409, 'Payroll adjustments are locked after approval.')
      const cents = amountToCents(entry.amount_due)
      const adjustmentCents = amountToCents(amount)
      if (type === 'deduction' && adjustmentCents > cents) fail(400, 'Deduction cannot exceed the remaining payroll obligation.')
      const adjustment = await client.query(
        `INSERT INTO payroll_adjustments
           (tenant_id, payroll_entry_id, adjustment_type, amount, description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.user.tenant_id, entryId, type, amount, description, req.user.user_id]
      )
      const next = type === 'deduction' ? cents - adjustmentCents : cents + adjustmentCents
      await client.query(
        'UPDATE payroll_entries SET amount_due=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND tenant_id=$3',
        [centsToAmount(next), entryId, req.user.tenant_id]
      )
      await audit(client, req, req.user.tenant_id, 'payroll_adjustment_added', 'payroll_adjustment', adjustment.rows[0].id, {
        payroll_entry_id: entryId,
        adjustment_type: type,
        amount,
        description
      })
      return adjustment.rows[0]
    })
    res.status(201).json(result)
  }))

  router.post('/employees/:id/advances', route(async (req, res) => {
    const employeeId = positiveId(req.params.id, 'Employee')
    const amount = validAmount(req.body && req.body.amount, 'Advance amount')
    const date = validDate(req.body && req.body.payment_date, 'Payment date')
    const method = validMethod(req.body && req.body.payment_method)
    const currency = validCurrency(req.body && req.body.currency)
    const accountId = positiveId(req.body && req.body.account_id, 'Account')
    const key = requiredText(req.body && req.body.idempotency_key, 'Idempotency key', 80)
    const reference = optionalText(req.body && req.body.reference, 120)
    const notes = optionalText(req.body && req.body.notes, 500)
    const result = await transaction(async client => {
      const prior = await client.query(
        'SELECT * FROM payroll_advances WHERE tenant_id=$1 AND idempotency_key=$2',
        [req.user.tenant_id, key]
      )
      if (prior.rows.length) return { ...prior.rows[0], duplicate: true }
      const employee = await client.query(
        'SELECT id, branch_id, payment_basis FROM staff_members WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [employeeId, req.user.tenant_id]
      )
      if (!employee.rows.length) fail(404, 'Employee was not found.')
      const branchId = employee.rows[0].branch_id == null ? null : Number(employee.rows[0].branch_id)
      if (req.user.branch_id != null && branchId !== Number(req.user.branch_id)) fail(404, 'Employee was not found.')
      await assertCurrencyAccount(client, req, accountId, currency, branchId)
      const advance = await client.query(
        `INSERT INTO payroll_advances
           (tenant_id, employee_id, amount, currency, payment_date, payment_method,
            reference, notes, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.tenant_id, employeeId, amount, currency, date, method, reference, notes, key, req.user.user_id]
      )
      await client.query(
        `INSERT INTO financial_transactions
           (tenant_id, branch_id, account_id, transaction_type, direction, amount, currency,
            transaction_date, source_type, source_id, idempotency_key, payment_method, reference, memo, created_by)
         VALUES ($1,$2,$3,'expense','out',$4,$5,$6,'payroll_advance',$7,$8,$9,$10,$11,$12)`,
        [
          req.user.tenant_id, branchId, accountId, amount, currency, date, String(advance.rows[0].id),
          'advance:' + key, method, reference, notes, req.user.user_id
        ]
      )
      await audit(client, req, req.user.tenant_id, 'payroll_advance_paid', 'payroll_advance', advance.rows[0].id, {
        employee_id: employeeId, amount, currency, payment_date: date
      })
      return advance.rows[0]
    })
    res.status(201).json(result)
  }))

  router.get('/employee-categories', route(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, category_key, is_system, is_active
       FROM employee_categories WHERE tenant_id=$1 ORDER BY name`,
      [req.user.tenant_id]
    )
    res.json(result.rows)
  }))

  router.get('/expense-categories', route(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, category_key, is_active
       FROM expense_categories WHERE tenant_id=$1 ORDER BY name`,
      [req.user.tenant_id]
    )
    res.json(result.rows)
  }))

  router.post('/expense-categories', route(async (req, res) => {
    const name = requiredText(req.body && req.body.name, 'Category name', 100)
    const key = normalizeCategoryKey(name)
    if (!key) fail(400, 'Category name must include letters or numbers.')
    const category = await transaction(async client => {
      const result = await client.query(
        `INSERT INTO expense_categories (tenant_id, name, category_key, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id, name, category_key, is_active`,
        [req.user.tenant_id, name, key, req.user.user_id]
      )
      await audit(client, req, req.user.tenant_id, 'expense_category_created', 'expense_category', result.rows[0].id, { name, category_key: key })
      return result.rows[0]
    })
    res.status(201).json(category)
  }))

  router.patch('/expense-categories/:id', route(async (req, res) => {
    const categoryId = positiveId(req.params.id, 'Category')
    const body = req.body || {}
    const updated = await transaction(async client => {
      const current = await client.query(
        'SELECT * FROM expense_categories WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [categoryId, req.user.tenant_id]
      )
      if (!current.rows.length) fail(404, 'Expense category was not found.')
      const name = body.name === undefined ? current.rows[0].name : requiredText(body.name, 'Category name', 100)
      const key = normalizeCategoryKey(name)
      if (!key) fail(400, 'Category name must include letters or numbers.')
      const active = body.is_active === undefined ? current.rows[0].is_active : validBoolean(body.is_active, 'Active state')
      const result = await client.query(
        `UPDATE expense_categories SET name=$1, category_key=$2, is_active=$3
         WHERE id=$4 AND tenant_id=$5 RETURNING id, name, category_key, is_active`,
        [name, key, active, categoryId, req.user.tenant_id]
      )
      await audit(client, req, req.user.tenant_id, 'expense_category_updated', 'expense_category', categoryId, {
        before: { name: current.rows[0].name, is_active: current.rows[0].is_active },
        after: { name, is_active: active }
      })
      return result.rows[0]
    })
    res.json(updated)
  }))

  router.get('/expenses/templates', route(async (req, res) => {
    const params = [req.user.tenant_id]
    const branch = addBranchWhere(req, req.query.branch_id, 'r', params)
    const result = await pool.query(
      `SELECT r.*, c.name AS category_name, b.name AS branch_name
       FROM recurring_expense_templates r
       JOIN expense_categories c ON c.id=r.category_id AND c.tenant_id=r.tenant_id
       LEFT JOIN branches b ON b.id=r.branch_id AND b.school_id=r.tenant_id
       WHERE r.tenant_id=$1${branch}
       ORDER BY r.is_active DESC, r.name`,
      params
    )
    res.json(result.rows)
  }))

  router.post('/expenses/templates', route(async (req, res) => {
    const body = req.body || {}
    const categoryId = positiveId(body.category_id, 'Expense category')
    const name = requiredText(body.name, 'Expense name', 160)
    const type = validEnum(body.expense_type, ['fixed_recurring', 'variable_recurring', 'scheduled'], 'Expense type')
    const frequency = validEnum(body.frequency, ['monthly', 'quarterly', 'yearly'], 'Frequency')
    const start = validDate(body.start_date, 'Start date')
    const end = body.end_date ? validDate(body.end_date, 'End date') : null
    if (end && end < start) fail(400, 'End date must not precede start date.')
    const dueDay = body.due_day == null || body.due_day === '' ? 1 : Number(body.due_day)
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) fail(400, 'Due day must be between 1 and 31.')
    const expected = body.expected_amount == null || body.expected_amount === ''
      ? null
      : validAmount(body.expected_amount, 'Expected amount', { allowZero: true })
    if (type === 'fixed_recurring' && expected === null) fail(400, 'Fixed recurring expenses require an expected amount.')
    if (type === 'scheduled' && expected === null) fail(400, 'Scheduled expenses require an expected amount.')
    const result = await transaction(async client => {
      await assertCategory(client, 'expense_categories', categoryId, req.user.tenant_id)
      const branchId = await resolveBranch(client, req, body.branch_id)
      const inserted = await client.query(
        `INSERT INTO recurring_expense_templates
           (tenant_id, branch_id, category_id, name, expense_type, frequency,
            expected_amount, due_day, start_date, end_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.user.tenant_id, branchId, categoryId, name, type, frequency, expected, dueDay, start, end, req.user.user_id]
      )
      await audit(client, req, req.user.tenant_id, 'expense_template_created', 'recurring_expense_template', inserted.rows[0].id, {
        name, expense_type: type, frequency, category_id: categoryId, branch_id: branchId
      })
      return inserted.rows[0]
    })
    res.status(201).json(result)
  }))

  router.patch('/expenses/templates/:id', route(async (req, res) => {
    const templateId = positiveId(req.params.id, 'Expense template')
    const body = req.body || {}
    const updated = await transaction(async client => {
      const current = await client.query(
        'SELECT * FROM recurring_expense_templates WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [templateId, req.user.tenant_id]
      )
      if (!current.rows.length) fail(404, 'Expense template was not found.')
      if (req.user.branch_id != null && Number(current.rows[0].branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'Expense template was not found.')
      }
      const active = body.is_active === undefined ? current.rows[0].is_active : validBoolean(body.is_active, 'Active state')
      const name = body.name === undefined ? current.rows[0].name : requiredText(body.name, 'Expense name', 160)
      const expected = body.expected_amount === undefined
        ? current.rows[0].expected_amount
        : (body.expected_amount === null || body.expected_amount === ''
            ? null
            : validAmount(body.expected_amount, 'Expected amount', { allowZero: true }))
      if (current.rows[0].expense_type === 'fixed_recurring' && expected === null) {
        fail(400, 'Fixed recurring expenses require an expected amount.')
      }
      const result = await client.query(
        `UPDATE recurring_expense_templates
         SET name=$1, expected_amount=$2, is_active=$3, updated_at=CURRENT_TIMESTAMP
         WHERE id=$4 AND tenant_id=$5 RETURNING *`,
        [name, expected, active, templateId, req.user.tenant_id]
      )
      await audit(client, req, req.user.tenant_id, 'expense_template_updated', 'recurring_expense_template', templateId, {
        before: { name: current.rows[0].name, expected_amount: current.rows[0].expected_amount, is_active: current.rows[0].is_active },
        after: { name, expected_amount: expected, is_active: active }
      })
      return result.rows[0]
    })
    res.json(updated)
  }))

  router.post('/expenses/generate', route(async (req, res) => {
    const periodStart = validDate(req.body && req.body.period_start, 'Expense period')
    if (periodStart.slice(-2) !== '01') fail(400, 'Expense period must be the first day of a month.')
    const branchId = await transaction(async client => {
      const resolved = await resolveBranch(client, req, req.body && req.body.branch_id)
      const params = [req.user.tenant_id]
      let branchClause = ''
      if (resolved != null) {
        params.push(resolved)
        branchClause = ' AND r.branch_id=$' + params.length
      }
      const templates = await client.query(
        `SELECT r.* FROM recurring_expense_templates r
         WHERE r.tenant_id=$1 AND r.is_active=true
           AND r.expense_type IN ('fixed_recurring','scheduled')${branchClause}
         ORDER BY r.id`,
        params
      )
      let created = 0
      for (const template of templates.rows) {
        if (!recurrenceMatches(template, periodStart)) continue
        if (template.expected_amount == null) continue
        const dueDate = dueDateInMonth(periodStart, template.due_day)
        const inserted = await client.query(
          `INSERT INTO expense_obligations
             (tenant_id, branch_id, category_id, template_id, expense_type, name,
              period_start, due_date, expected_amount, amount_due, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            req.user.tenant_id, template.branch_id, template.category_id, template.id,
            template.expense_type, template.name, periodStart, dueDate,
            template.expected_amount, req.user.user_id
          ]
        )
        created += inserted.rowCount
      }
      await audit(client, req, req.user.tenant_id, 'expense_obligations_generated', 'expense_period', null, {
        period_start: periodStart,
        created_count: created,
        branch_id: resolved
      })
      return { period_start: periodStart, created_count: created, branch_id: resolved }
    })
    res.json(branchId)
  }))

  router.post('/expenses/obligations', route(async (req, res) => {
    const body = req.body || {}
    const type = validEnum(body.expense_type, ['variable_recurring', 'one_time'], 'Expense type')
    const categoryId = positiveId(body.category_id, 'Expense category')
    const name = requiredText(body.name, 'Expense name', 160)
    const amount = validAmount(body.amount_due, 'Actual bill amount', { allowZero: true })
    const expected = body.expected_amount == null || body.expected_amount === ''
      ? null
      : validAmount(body.expected_amount, 'Expected amount', { allowZero: true })
    const periodStart = body.period_start ? validDate(body.period_start, 'Bill period') : null
    const dueDate = body.due_date ? validDate(body.due_date, 'Due date') : null
    const description = optionalText(body.description, 2000)
    const currency = validCurrency(body.currency)
    const result = await transaction(async client => {
      await assertCategory(client, 'expense_categories', categoryId, req.user.tenant_id)
      const branchId = await resolveBranch(client, req, body.branch_id)
      let templateId = null
      if (type === 'variable_recurring') {
        if (!periodStart) fail(400, 'Variable bills require a period start date.')
        if (body.template_id) {
          templateId = positiveId(body.template_id, 'Expense template')
          const template = await client.query(
            `SELECT id, category_id, expense_type, branch_id, name
             FROM recurring_expense_templates WHERE id=$1 AND tenant_id=$2 AND is_active=true`,
            [templateId, req.user.tenant_id]
          )
          if (!template.rows.length || template.rows[0].expense_type !== 'variable_recurring') {
            fail(400, 'Choose an active variable recurring expense template.')
          }
          if (Number(template.rows[0].category_id) !== categoryId) fail(400, 'Bill category must match its recurring template.')
          if (Number(template.rows[0].branch_id) !== Number(branchId)) {
            fail(400, 'Bill branch must match its recurring template.')
          }
        }
      }
      const inserted = await client.query(
        `INSERT INTO expense_obligations
           (tenant_id, branch_id, category_id, template_id, expense_type, name, description,
            period_start, due_date, expected_amount, amount_due, currency, receipt_reference, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          req.user.tenant_id, branchId, categoryId, templateId, type, name, description,
          periodStart, dueDate, expected, amount, currency,
          optionalText(body.receipt_reference, 500), req.user.user_id
        ]
      )
      if (templateId && expected !== null) {
        await client.query(
          `INSERT INTO expense_estimates (tenant_id, template_id, period_start, amount, created_by)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, template_id, period_start)
           DO UPDATE SET amount=EXCLUDED.amount, notes='Updated with actual bill entry'`,
          [req.user.tenant_id, templateId, periodStart, expected, req.user.user_id]
        )
      }
      await audit(client, req, req.user.tenant_id, 'expense_obligation_created', 'expense_obligation', inserted.rows[0].id, {
        expense_type: type, amount_due: amount, expected_amount: expected, branch_id: branchId
      })
      return inserted.rows[0]
    })
    res.status(201).json(result)
  }))

  router.put('/expenses/obligations/:id', route(async (req, res) => {
    const obligationId = positiveId(req.params.id, 'Expense obligation')
    const body = req.body || {}
    const result = await transaction(async client => {
      const currentResult = await client.query(
        'SELECT * FROM expense_obligations WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [obligationId, req.user.tenant_id]
      )
      const current = currentResult.rows[0]
      if (!current) fail(404, 'Expense obligation was not found.')
      if (req.user.branch_id != null && Number(current.branch_id) !== Number(req.user.branch_id)) {
        fail(404, 'Expense obligation was not found.')
      }
      const paid = await calculatePaid(client, 'expense_payments', 'obligation_id', obligationId, req.user.tenant_id)
      if (amountToCents(paid) > 0n) fail(409, 'An obligation with payments cannot be edited; reverse or record a correction instead.')
      const amount = body.amount_due === undefined
        ? current.amount_due
        : validAmount(body.amount_due, 'Actual bill amount', { allowZero: true })
      const expected = body.expected_amount === undefined
        ? current.expected_amount
        : (body.expected_amount == null || body.expected_amount === ''
            ? null
            : validAmount(body.expected_amount, 'Expected amount', { allowZero: true }))
      const dueDate = body.due_date === undefined
        ? current.due_date
        : (body.due_date ? validDate(body.due_date, 'Due date') : null)
      const description = body.description === undefined ? current.description : optionalText(body.description, 2000)
      const updated = await client.query(
        `UPDATE expense_obligations
         SET amount_due=$1, expected_amount=$2, due_date=$3, description=$4,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$5 AND tenant_id=$6 RETURNING *`,
        [amount, expected, dueDate, description, obligationId, req.user.tenant_id]
      )
      await audit(client, req, req.user.tenant_id, 'expense_obligation_updated', 'expense_obligation', obligationId, {
        before: { amount_due: current.amount_due, expected_amount: current.expected_amount, due_date: current.due_date },
        after: { amount_due: amount, expected_amount: expected, due_date: dueDate }
      })
      return updated.rows[0]
    })
    res.json(result)
  }))

  router.get('/expenses/obligations', route(async (req, res) => {
    const month = req.query.month ? String(req.query.month) : null
    if (month && !monthBounds(month)) fail(400, 'Month must be in YYYY-MM format.')
    const categoryId = req.query.category_id ? positiveId(req.query.category_id, 'Category') : null
    const result = await getExpenseObligations(pool, req.user.tenant_id, {
      month,
      categoryId,
      status: req.query.status ? String(req.query.status) : null,
      branchId: branchFilter(req, req.query.branch_id)
    })
    res.json(result)
  }))

  router.post('/expenses/estimates', route(async (req, res) => {
    const templateId = positiveId(req.body && req.body.template_id, 'Expense template')
    const periodStart = validDate(req.body && req.body.period_start, 'Estimate period')
    if (periodStart.slice(-2) !== '01') fail(400, 'Estimate period must be the first day of a month.')
    const amount = validAmount(req.body && req.body.amount, 'Estimate amount', { allowZero: true })
    const notes = optionalText(req.body && req.body.notes, 500)
    const result = await transaction(async client => {
      const branchId = branchFilter(req, req.body && req.body.branch_id)
      const template = await client.query(
        `SELECT id, expense_type, branch_id FROM recurring_expense_templates
         WHERE id=$1 AND tenant_id=$2 AND is_active=true
           AND ($3::integer IS NULL OR branch_id=$3) FOR UPDATE`,
        [templateId, req.user.tenant_id, branchId]
      )
      if (!template.rows.length || template.rows[0].expense_type !== 'variable_recurring') {
        fail(400, 'Estimates are available only for active variable recurring expenses.')
      }
      const estimate = await client.query(
        `INSERT INTO expense_estimates (tenant_id, template_id, period_start, amount, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, template_id, period_start)
         DO UPDATE SET amount=EXCLUDED.amount, notes=EXCLUDED.notes
         RETURNING *`,
        [req.user.tenant_id, templateId, periodStart, amount, notes, req.user.user_id]
      )
      await audit(client, req, req.user.tenant_id, 'expense_estimate_recorded', 'expense_estimate', estimate.rows[0].id, {
        template_id: templateId, period_start: periodStart, amount
      })
      return estimate.rows[0]
    })
    res.status(201).json(result)
  }))

  router.get('/expenses/analytics', route(async (req, res) => {
    const year = String(req.query.year || new Date().getUTCFullYear())
    if (!/^\d{4}$/.test(year)) fail(400, 'Year must contain four digits.')
    const templateId = req.query.template_id ? positiveId(req.query.template_id, 'Expense template') : null
    const params = [req.user.tenant_id, year + '-01-01', (Number(year) + 1) + '-01-01']
    let templateClause = ''
    if (templateId != null) {
      params.push(templateId)
      templateClause = ' AND o.template_id=$' + params.length
    }
    const branch = addBranchWhere(req, req.query.branch_id, 'o', params)
    const actual = await pool.query(
      `SELECT TO_CHAR(DATE_TRUNC('month', o.period_start), 'YYYY-MM') AS month,
              SUM(o.amount_due)::numeric(14,2) AS amount
       FROM expense_obligations o
       WHERE o.tenant_id=$1 AND o.expense_type='variable_recurring'
         AND o.period_start >= $2::date AND o.period_start < $3::date${templateClause}${branch}
       GROUP BY DATE_TRUNC('month', o.period_start)
       ORDER BY DATE_TRUNC('month', o.period_start)`,
      params
    )
    const estimateParams = [req.user.tenant_id, templateId, year + '-01-01', (Number(year) + 1) + '-01-01']
    const branchId = branchFilter(req, req.query.branch_id)
    let estimateBranch = ''
    if (branchId != null) {
      estimateParams.push(branchId)
      estimateBranch = ' AND r.branch_id=$' + estimateParams.length
    }
    const estimates = templateId == null
      ? { rows: [] }
      : await pool.query(
        `SELECT TO_CHAR(DATE_TRUNC('month', e.period_start), 'YYYY-MM') AS month,
                SUM(e.amount)::numeric(14,2) AS amount
         FROM expense_estimates e
         JOIN recurring_expense_templates r ON r.id=e.template_id AND r.tenant_id=e.tenant_id
         WHERE e.tenant_id=$1 AND e.template_id=$2
           AND e.period_start >= $3::date AND e.period_start < $4::date${estimateBranch}
         GROUP BY DATE_TRUNC('month', e.period_start)
         ORDER BY DATE_TRUNC('month', e.period_start)`,
        estimateParams
      )
    const actualByMonth = new Map(actual.rows.map(row => [row.month, row.amount]))
    const estimateByMonth = new Map(estimates.rows.map(row => [row.month, row.amount]))
    const months = Array.from({ length: 12 }, (_, index) => {
      const month = year + '-' + String(index + 1).padStart(2, '0')
      return { month, actual: actualByMonth.get(month) || '0.00', estimate: estimateByMonth.get(month) || null }
    })
    const populated = months.filter(item => amountToCents(item.actual) > 0n)
    const amounts = populated.map(item => amountToCents(item.actual))
    const average = amounts.length
      ? centsToAmount(amounts.reduce((sum, value) => sum + value, 0n) / BigInt(amounts.length))
      : '0.00'
    const max = amounts.length ? centsToAmount(amounts.reduce((a, b) => a > b ? a : b)) : '0.00'
    const min = amounts.length ? centsToAmount(amounts.reduce((a, b) => a < b ? a : b)) : '0.00'
    const changes = months.map((item, index) => {
      if (index === 0) return { month: item.month, percentage_change: null }
      const previous = amountToCents(months[index - 1].actual)
      const current = amountToCents(item.actual)
      if (previous === 0n) return { month: item.month, percentage_change: null }
      return {
        month: item.month,
        percentage_change: Number(((current - previous) * 10000n / previous)) / 100
      }
    })
    res.json({
      year: Number(year),
      template_id: templateId,
      months,
      highest: max,
      lowest: min,
      average,
      month_to_month: changes
    })
  }))

  router.get('/payroll/advances', route(async (req, res) => {
    const params = [req.user.tenant_id]
    const branch = addBranchWhere(req, req.query.branch_id, 's', params)
    const result = await pool.query(
      `SELECT a.id, a.employee_id, COALESCE(t.name,s.name) AS employee_name,
              a.amount, a.currency, a.payment_date, a.payment_method, a.reference,
              COALESCE(al.allocated,0)::numeric(12,2) AS allocated,
              GREATEST(a.amount-COALESCE(al.allocated,0),0)::numeric(12,2) AS outstanding
       FROM payroll_advances a
       JOIN staff_members s ON s.id=a.employee_id AND s.tenant_id=a.tenant_id
       LEFT JOIN teachers t ON t.id=s.teacher_id AND t.tenant_id=s.tenant_id
       LEFT JOIN LATERAL (
         SELECT SUM(amount) AS allocated FROM payroll_advance_allocations
         WHERE tenant_id=a.tenant_id AND advance_id=a.id
       ) al ON true
       WHERE a.tenant_id=$1${branch}
         AND NOT EXISTS (
           SELECT 1
           FROM financial_transactions tx
           JOIN financial_transactions rev ON rev.reversal_of_id=tx.id
           WHERE tx.tenant_id=a.tenant_id AND tx.source_type='payroll_advance'
             AND tx.source_id=a.id::text
         )
       ORDER BY a.payment_date DESC, a.id DESC`,
      params
    )
    res.json(result.rows)
  }))

  router.post('/expenses/obligations/:id/payments', route(async (req, res) => {
    const obligationId = positiveId(req.params.id, 'Expense obligation')
    const result = await postPayment(req, 'expense', obligationId)
    res.status(result.duplicate ? 200 : 201).json(result)
  }))

  router.post('/payroll/entries/:id/payments', route(async (req, res) => {
    const entryId = positiveId(req.params.id, 'Payroll entry')
    const result = await postPayment(req, 'payroll', entryId)
    res.status(result.duplicate ? 200 : 201).json(result)
  }))

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    if (error instanceof FinanceError) return res.status(error.status).json({ error: error.message })
    if (error && error.code === '23505') return res.status(409).json({ error: 'A matching financial record already exists.' })
    if (error && error.code === '23503') return res.status(400).json({ error: 'A referenced record does not belong to this school or cannot be removed.' })
    if (error && error.code === '23514') return res.status(400).json({ error: 'A financial value does not satisfy the required constraints.' })
    console.error('Finance API error:', error && (error.code || error.message) || 'Unknown error')
    return res.status(500).json({ error: 'Finance request failed. Please try again or contact your administrator.' })
  })

  return router
}

module.exports = { createFinanceRouter }
