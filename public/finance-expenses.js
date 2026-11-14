(function () {
  'use strict'

  const F = window.Finance
  const alert = document.getElementById('financeAlert')
  const branchInput = document.getElementById('branchFilter')
  const monthInput = document.getElementById('expenseMonth')
  const obligationRows = document.getElementById('obligationRows')
  const templateRows = document.getElementById('templateRows')
  const paymentDialog = document.getElementById('expensePaymentDialog')
  const paymentForm = document.getElementById('expensePaymentForm')
  const editDialog = document.getElementById('editObligationDialog')
  const editForm = document.getElementById('editObligationForm')
  let bootstrap = { accounts: [], branches: [], expense_categories: [] }
  let templates = []
  let obligations = []
  let selectedObligation = null

  monthInput.value = F.monthValue()
  document.getElementById('analyticsYear').value = new Date().getFullYear()
  document.getElementById('templateStart').value = new Date().toISOString().slice(0, 10)
  document.getElementById('expensePayDate').value = new Date().toISOString().slice(0, 10)
  document.getElementById('estimatePeriod').value = monthInput.value + '-01'

  function branchSuffix() {
    return branchInput.value ? '&branch_id=' + encodeURIComponent(branchInput.value) : ''
  }

  function branchOptions(selected) {
    return '<option value="">School-wide</option>' + F.options(bootstrap.branches, selected, '')
  }

  function renderBranchOptions(selected) {
    branchInput.innerHTML = '<option value="">All branches</option>' + F.options(bootstrap.branches, selected, '')
    ;['obligationBranch', 'templateBranch'].forEach(id => {
      document.getElementById(id).innerHTML = branchOptions(selected || null)
    })
  }

  function renderCategories() {
    const categories = (bootstrap.expense_categories || []).filter(category => category.is_active)
    const markup = F.options(categories, null, 'Choose category')
    document.getElementById('obligationCategory').innerHTML = markup
    document.getElementById('templateCategory').innerHTML = markup
  }

  function renderTemplateSelects() {
    const activeTemplates = templates.filter(template => template.is_active)
    const variable = activeTemplates.filter(template => template.expense_type === 'variable_recurring')
    document.getElementById('billTemplate').innerHTML = F.options(variable, null, 'No template')
    document.getElementById('estimateTemplate').innerHTML = F.options(variable, null, 'Choose expense')
    document.getElementById('analyticsTemplate').innerHTML = F.options(variable, null, 'Choose expense')
  }

  function renderTemplateRows() {
    if (!templates.length) {
      templateRows.innerHTML = '<tr><td colspan="7"><div class="finance-empty">No recurring plans have been added.</div></td></tr>'
      return
    }
    templateRows.innerHTML = templates.map(template => {
      const activeLabel = template.is_active ? 'Deactivate' : 'Reactivate'
      const branchName = template.branch_name || 'School-wide'
      return '<tr>' +
        '<td><strong>' + F.escapeHtml(template.name) + '</strong><span class="secondary">' + F.escapeHtml(branchName) + '</span></td>' +
        '<td>' + F.escapeHtml(template.category_name) + '</td>' +
        '<td>' + F.escapeHtml(template.expense_type.replace(/_/g, ' ')) + '<span class="secondary">' + F.escapeHtml(template.frequency) + '</span></td>' +
        '<td class="numeric finance-number">' + (template.expected_amount == null ? '—' : F.escapeHtml(F.money(template.expected_amount))) + '</td>' +
        '<td>' + F.escapeHtml(template.due_day) + '</td>' +
        '<td>' + F.statusPill(template.is_active ? 'active' : 'inactive') + '</td>' +
        '<td><div class="finance-table-actions"><button class="finance-button finance-button-small" data-template-toggle="' + F.escapeHtml(template.id) + '" data-active="' + String(template.is_active) + '" type="button">' + activeLabel + '</button></div></td>' +
      '</tr>'
    }).join('')
  }

  function renderObligations() {
    if (!obligations.length) {
      obligationRows.innerHTML = '<tr><td colspan="9"><div class="finance-empty">No bills are recorded for this period.</div></td></tr>'
      return
    }
    obligationRows.innerHTML = obligations.map(item => {
      const editable = Number(item.amount_paid) === 0
      const actions = (Number(item.outstanding) > 0
        ? '<button class="finance-button finance-button-small finance-button-primary" data-pay-obligation="' + F.escapeHtml(item.id) + '" type="button">Pay</button>'
        : '') + (editable
        ? '<button class="finance-button finance-button-small" data-edit-obligation="' + F.escapeHtml(item.id) + '" type="button">Edit</button>'
        : '')
      return '<tr>' +
        '<td>' + F.escapeHtml(F.date(item.due_date || item.period_start || item.created_at)) + '</td>' +
        '<td><strong>' + F.escapeHtml(item.name) + '</strong>' + (item.receipt_reference ? '<span class="secondary">Ref: ' + F.escapeHtml(item.receipt_reference) + '</span>' : '') + '</td>' +
        '<td><span class="finance-category-tag">' + F.escapeHtml(item.category_name) + '</span></td>' +
        '<td class="numeric finance-number">' + (item.expected_amount == null ? '—' : F.escapeHtml(F.money(item.expected_amount, item.currency))) + '</td>' +
        '<td class="numeric finance-number">' + F.escapeHtml(F.money(item.amount_due, item.currency)) + '</td>' +
        '<td class="numeric finance-number">' + F.escapeHtml(F.money(item.amount_paid, item.currency)) + '</td>' +
        '<td class="numeric finance-number">' + F.escapeHtml(F.money(item.outstanding, item.currency)) + '</td>' +
        '<td>' + F.statusPill(item.payment_status) + '</td>' +
        '<td><div class="finance-table-actions">' + actions + '</div></td>' +
      '</tr>'
    }).join('')
  }

  async function loadBootstrap() {
    const selected = branchInput.value
    const suffix = selected ? '?branch_id=' + encodeURIComponent(selected) : ''
    bootstrap = await F.api('/bootstrap' + suffix)
    renderBranchOptions(selected)
    renderCategories()
  }

  async function loadTemplates() {
    const query = branchSuffix()
    templates = await F.api('/expenses/templates' + (query ? '?' + query.slice(1) : ''))
    renderTemplateSelects()
    renderTemplateRows()
  }

  async function loadObligations() {
    const params = new URLSearchParams({ month: monthInput.value, status: document.getElementById('statusFilter').value })
    if (branchInput.value) params.set('branch_id', branchInput.value)
    obligations = await F.api('/expenses/obligations?' + params.toString())
    renderObligations()
  }

  async function refreshAll() {
    F.clearAlert(alert)
    try {
      await Promise.all([loadTemplates(), loadObligations()])
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  }

  document.getElementById('obligationType').addEventListener('change', function () {
    const variable = this.value === 'variable_recurring'
    document.getElementById('billTemplateWrap').classList.toggle('finance-hidden', !variable)
    const defaultPeriod = monthInput.value + '-01'
    if (variable && !document.getElementById('billPeriod').value) document.getElementById('billPeriod').value = defaultPeriod
  })

  document.getElementById('billTemplate').addEventListener('change', function () {
    const template = templates.find(item => String(item.id) === this.value)
    if (!template) return
    document.getElementById('obligationCategory').value = template.category_id
    document.getElementById('obligationName').value = template.name
    document.getElementById('obligationBranch').value = template.branch_id == null ? '' : String(template.branch_id)
    if (template.expected_amount != null) document.getElementById('billExpected').value = template.expected_amount
  })

  document.getElementById('templateType').addEventListener('change', function () {
    const expected = document.getElementById('templateExpected')
    expected.required = this.value === 'fixed_recurring'
  })

  document.getElementById('obligationForm').addEventListener('submit', async function (event) {
    event.preventDefault()
    const templateId = this.elements.template_id.value
    try {
      await F.api('/expenses/obligations', F.jsonOptions('POST', {
        expense_type: this.elements.expense_type.value,
        category_id: this.elements.category_id.value,
        name: this.elements.name.value,
        template_id: templateId || null,
        amount_due: this.elements.amount_due.value,
        expected_amount: this.elements.expected_amount.value || null,
        period_start: this.elements.period_start.value || null,
        due_date: this.elements.due_date.value || null,
        branch_id: this.elements.branch_id.value || null,
        receipt_reference: this.elements.receipt_reference.value,
        description: this.elements.description.value,
        currency: 'PKR'
      }))
      this.reset()
      document.getElementById('billTemplateWrap').classList.add('finance-hidden')
      document.getElementById('billPeriod').value = monthInput.value + '-01'
      F.alertFor(alert, 'Bill recorded as an obligation. Record its payment separately when paid.', 'success')
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('templateForm').addEventListener('submit', async function (event) {
    event.preventDefault()
    try {
      await F.api('/expenses/templates', F.jsonOptions('POST', {
        name: this.elements.name.value,
        category_id: this.elements.category_id.value,
        expense_type: this.elements.expense_type.value,
        frequency: this.elements.frequency.value,
        expected_amount: this.elements.expected_amount.value || null,
        due_day: this.elements.due_day.value,
        start_date: this.elements.start_date.value,
        end_date: this.elements.end_date.value || null,
        branch_id: this.elements.branch_id.value || null
      }))
      this.reset()
      document.getElementById('templateStart').value = new Date().toISOString().slice(0, 10)
      document.getElementById('templateDueDay').value = '1'
      document.getElementById('templateExpected').required = true
      F.alertFor(alert, 'Recurring expense plan saved.', 'success')
      await loadTemplates()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('generateExpenses').addEventListener('click', async function () {
    const monthStart = monthInput.value + '-01'
    try {
      const result = await F.api('/expenses/generate', F.jsonOptions('POST', {
        period_start: monthStart,
        branch_id: branchInput.value || null
      }))
      F.alertFor(alert, result.created_count + ' recurring obligation(s) generated for ' + monthInput.value + '.', 'success')
      await loadObligations()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  templateRows.addEventListener('click', async function (event) {
    const button = event.target.closest('[data-template-toggle]')
    if (!button) return
    try {
      await F.api('/expenses/templates/' + encodeURIComponent(button.dataset.templateToggle), F.jsonOptions('PATCH', {
        is_active: button.dataset.active !== 'true'
      }))
      F.alertFor(alert, 'Recurring plan updated.', 'success')
      await loadTemplates()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  obligationRows.addEventListener('click', function (event) {
    const payButton = event.target.closest('[data-pay-obligation]')
    const editButton = event.target.closest('[data-edit-obligation]')
    if (payButton) {
      selectedObligation = obligations.find(item => String(item.id) === payButton.dataset.payObligation)
      if (!selectedObligation) return
      paymentForm.elements.amount.max = selectedObligation.outstanding
      paymentForm.elements.amount.value = selectedObligation.outstanding
      paymentForm.elements.reference.value = ''
      paymentForm.elements.receipt_reference.value = selectedObligation.receipt_reference || ''
      renderPaymentAccounts()
      paymentDialog.showModal()
    } else if (editButton) {
      const item = obligations.find(row => String(row.id) === editButton.dataset.editObligation)
      if (!item) return
      editForm.elements.obligation_id.value = item.id
      editForm.elements.amount_due.value = item.amount_due
      editForm.elements.expected_amount.value = item.expected_amount == null ? '' : item.expected_amount
      editForm.elements.due_date.value = item.due_date ? String(item.due_date).slice(0, 10) : ''
      editForm.elements.description.value = item.description || ''
      editDialog.showModal()
    }
  })

  function renderPaymentAccounts() {
    if (!selectedObligation) return
    const accounts = (bootstrap.accounts || []).filter(account =>
      account.currency === selectedObligation.currency &&
      (account.branch_id == null || (selectedObligation.branch_id != null && Number(account.branch_id) === Number(selectedObligation.branch_id)))
    )
    document.getElementById('expensePayAccount').innerHTML = accounts.length
      ? accounts.map(account => '<option value="' + F.escapeHtml(account.id) + '">' + F.escapeHtml(account.name) + ' · ' + F.escapeHtml(account.currency) + '</option>').join('')
      : '<option value="">No matching active account</option>'
  }

  paymentForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    if (!selectedObligation) return
    const accountId = paymentForm.elements.account_id.value
    if (!accountId) {
      F.alertFor(alert, 'Choose an active account with the bill currency and branch.', 'error')
      return
    }
    const account = bootstrap.accounts.find(item => String(item.id) === accountId)
    try {
      await F.api('/expenses/obligations/' + encodeURIComponent(selectedObligation.id) + '/payments', F.jsonOptions('POST', {
        amount: paymentForm.elements.amount.value,
        payment_date: paymentForm.elements.payment_date.value,
        payment_method: paymentForm.elements.payment_method.value,
        account_id: account.id,
        currency: account.currency,
        reference: paymentForm.elements.reference.value,
        receipt_reference: paymentForm.elements.receipt_reference.value,
        idempotency_key: F.randomKey()
      }))
      paymentDialog.close()
      selectedObligation = null
      F.alertFor(alert, 'Bill payment recorded in the shared ledger.', 'success')
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  editForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const id = editForm.elements.obligation_id.value
    try {
      await F.api('/expenses/obligations/' + encodeURIComponent(id), F.jsonOptions('PUT', {
        amount_due: editForm.elements.amount_due.value,
        expected_amount: editForm.elements.expected_amount.value || null,
        due_date: editForm.elements.due_date.value || null,
        description: editForm.elements.description.value
      }))
      editDialog.close()
      F.alertFor(alert, 'Bill details corrected and recorded in the audit history.', 'success')
      await loadObligations()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('estimateForm').addEventListener('submit', async function (event) {
    event.preventDefault()
    const templateId = this.elements.template_id.value
    const template = templates.find(item => String(item.id) === templateId)
    if (!template) {
      F.alertFor(alert, 'Choose an active variable recurring expense.', 'error')
      return
    }
    try {
      await F.api('/expenses/estimates', F.jsonOptions('POST', {
        template_id: template.id,
        period_start: this.elements.period_start.value,
        amount: this.elements.amount.value,
        notes: this.elements.notes.value,
        branch_id: template.branch_id
      }))
      F.alertFor(alert, 'Planning estimate saved; it does not change cash or bills due.', 'success')
      document.getElementById('analyticsTemplate').value = template.id
      await loadAnalytics()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('categoryForm').addEventListener('submit', async function (event) {
    event.preventDefault()
    try {
      await F.api('/expense-categories', F.jsonOptions('POST', { name: this.elements.name.value }))
      this.reset()
      F.alertFor(alert, 'Expense category added.', 'success')
      await loadBootstrap()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  async function loadAnalytics() {
    const templateId = document.getElementById('analyticsTemplate').value
    if (!templateId) {
      document.getElementById('expenseChart').innerHTML = '<div class="finance-empty">Choose a variable recurring expense to view its history.</div>'
      document.getElementById('analyticsSummary').textContent = ''
      return
    }
    const params = new URLSearchParams({ year: document.getElementById('analyticsYear').value, template_id: templateId })
    if (branchInput.value) params.set('branch_id', branchInput.value)
    try {
      const data = await F.api('/expenses/analytics?' + params.toString())
      const values = data.months.flatMap(item => [Number(item.actual) || 0, Number(item.estimate) || 0])
      const max = Math.max(1, ...values)
      document.getElementById('expenseChart').innerHTML = data.months.map(item => {
        const actual = Number(item.actual) || 0
        const estimate = Number(item.estimate) || 0
        const actualWidth = actual ? Math.max(2, actual / max * 100) : 0
        const estimateWidth = estimate ? Math.max(2, estimate / max * 100) : 0
        return '<div class="finance-chart-row">' +
          '<span class="finance-chart-month">' + F.escapeHtml(item.month.slice(5)) + '</span>' +
          '<div class="finance-chart-bars" aria-label="Actual ' + F.escapeHtml(F.money(actual)) + ', estimate ' + F.escapeHtml(estimate ? F.money(estimate) : 'none') + '">' +
            '<div class="finance-chart-bar" style="width:' + actualWidth + '%"></div>' +
            (estimate ? '<div class="finance-chart-bar estimate" style="width:' + estimateWidth + '%"></div>' : '') +
          '</div>' +
          '<span class="finance-chart-value">' + F.escapeHtml(F.money(actual)) + '</span>' +
        '</div>'
      }).join('')
      document.getElementById('analyticsSummary').textContent =
        'Average actual bill: ' + F.money(data.average) + ' · Highest: ' + F.money(data.highest) + ' · Lowest: ' + F.money(data.lowest)
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  }

  document.getElementById('loadAnalytics').addEventListener('click', loadAnalytics)
  document.getElementById('reloadExpenses').addEventListener('click', refreshAll)
  monthInput.addEventListener('change', async function () {
    document.getElementById('billPeriod').value = monthInput.value + '-01'
    document.getElementById('estimatePeriod').value = monthInput.value + '-01'
    try { await loadObligations() } catch (error) { F.alertFor(alert, error.message, 'error') }
  })
  document.getElementById('statusFilter').addEventListener('change', () => loadObligations().catch(error => F.alertFor(alert, error.message, 'error')))
  branchInput.addEventListener('change', async function () {
    try {
      await loadBootstrap()
      await refreshAll()
      await loadAnalytics()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()))

  loadBootstrap().then(refreshAll).catch(error => F.alertFor(alert, error.message, 'error'))
})()
