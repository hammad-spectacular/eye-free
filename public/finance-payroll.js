(function () {
  'use strict'

  const F = window.Finance
  const alert = document.getElementById('financeAlert')
  const branchInput = document.getElementById('branchFilter')
  const monthInput = document.getElementById('payrollMonth')
  const previewRows = document.getElementById('previewRows')
  const payrollRows = document.getElementById('payrollRows')
  const employeeRows = document.getElementById('employeeRows')
  const employeeForm = document.getElementById('employeeForm')
  const paymentDialog = document.getElementById('paymentDialog')
  const adjustmentDialog = document.getElementById('adjustmentDialog')
  const employeeDialog = document.getElementById('employeeDialog')
  const paymentForm = document.getElementById('paymentForm')
  const adjustmentForm = document.getElementById('adjustmentForm')
  const editEmployeeForm = document.getElementById('editEmployeeForm')
  const compensationForm = document.getElementById('compensationForm')
  const advanceForm = document.getElementById('advanceForm')
  let bootstrap = { accounts: [], branches: [], employee_categories: [] }
  let employees = []
  let eligibleEmployees = []
  let payrollEntries = []
  let selectedEntry = null
  let selectedAdjustmentEntry = null

  monthInput.value = F.monthValue()
  document.getElementById('joiningDate').value = new Date().toISOString().slice(0, 10)
  document.getElementById('advanceDate').value = new Date().toISOString().slice(0, 10)
  document.getElementById('payDate').value = new Date().toISOString().slice(0, 10)

  function branchSuffix() {
    return branchInput.value ? '&branch_id=' + encodeURIComponent(branchInput.value) : ''
  }

  function renderBranchOptions(selected) {
    branchInput.innerHTML = '<option value="">All branches</option>' + F.options(bootstrap.branches, selected, '')
    document.getElementById('employeeBranch').innerHTML = '<option value="">School-wide</option>' + F.options(bootstrap.branches, null, '')
    document.getElementById('editEmployeeBranch').innerHTML = '<option value="">School-wide</option>' + F.options(bootstrap.branches, null, '')
  }

  function renderCategories() {
    const categories = (bootstrap.employee_categories || []).filter(category => category.is_active)
    document.getElementById('employeeCategory').innerHTML = F.options(categories, null, 'Choose category')
  }

  function renderAccounts(select, currency, branchId) {
    const accounts = (bootstrap.accounts || []).filter(account =>
      (!currency || account.currency === currency) &&
      (account.branch_id == null || (branchId != null && Number(account.branch_id) === Number(branchId)))
    )
    select.innerHTML = accounts.length
      ? accounts.map(account => '<option value="' + F.escapeHtml(account.id) + '">' +
          F.escapeHtml(account.name) + ' · ' + F.escapeHtml(account.currency) + '</option>').join('')
      : '<option value="">No matching active account</option>'
  }

  function renderTeacherOptions(teachers) {
    const teacherOptions = teachers.map(teacher => ({
      id: teacher.id,
      name: teacher.name + (teacher.branch_id ? ' · branch ' + teacher.branch_id : '')
    }))
    document.getElementById('teacherLink').innerHTML = F.options(teacherOptions, null, 'Non-teaching employee')
  }

  async function loadBootstrap() {
    const selected = branchInput.value
    const suffix = selected ? '?branch_id=' + encodeURIComponent(selected) : ''
    bootstrap = await F.api('/bootstrap' + suffix)
    renderBranchOptions(selected)
    renderCategories()
    renderAccounts(document.getElementById('advanceAccount'))
    renderTeacherOptions(await F.api('/employees/unlinked-teachers' + (branchSuffix() ? '?' + branchSuffix().slice(1) : '')))
  }

  function renderEmployees() {
    if (!employees.length) {
      employeeRows.innerHTML = '<tr><td colspan="6"><div class="finance-empty">No employees match this filter. Add a profile to begin payroll.</div></td></tr>'
      document.getElementById('advanceEmployee').innerHTML = '<option value="">No employees available</option>'
      return
    }
    employeeRows.innerHTML = employees.map(employee => {
      const currentRate = employee.current_rate == null ? 'Rate not set' : F.money(employee.current_rate, employee.currency)
      const branchName = employee.branch_id == null ? 'School-wide' : (bootstrap.branches.find(branch => Number(branch.id) === Number(employee.branch_id)) || {}).name || 'Branch ' + employee.branch_id
      return '<tr>' +
        '<td><strong>' + F.escapeHtml(employee.name) + '</strong><span class="secondary">' + F.escapeHtml(employee.employee_number || employee.email || employee.phone || 'Employee ' + employee.id) + '</span></td>' +
        '<td>' + F.escapeHtml(employee.category_name) + (employee.job_title ? '<span class="secondary">' + F.escapeHtml(employee.job_title) + '</span>' : '') + '</td>' +
        '<td class="finance-number">' + F.escapeHtml(currentRate) + (employee.payment_basis ? '<span class="secondary">' + F.escapeHtml(employee.payment_basis) + ' · ' + F.escapeHtml(employee.payment_frequency || '') + '</span>' : '') + '</td>' +
        '<td>' + F.escapeHtml(branchName) + '</td>' +
        '<td>' + F.statusPill(employee.employment_status) + '</td>' +
        '<td><div class="finance-table-actions"><button class="finance-button finance-button-small" data-edit-employee="' + F.escapeHtml(employee.id) + '" type="button">Edit</button><button class="finance-button finance-button-small" data-advance="' + F.escapeHtml(employee.id) + '" type="button">Advance</button></div></td>' +
      '</tr>'
    }).join('')
    const activeEmployees = employees.filter(employee => employee.employment_status === 'active')
    document.getElementById('advanceEmployee').innerHTML = F.options(
      activeEmployees.map(employee => ({ id: employee.id, name: employee.name })),
      null,
      'Choose employee'
    )
    updateAdvanceAccounts()
  }

  async function loadEmployees() {
    const params = new URLSearchParams()
    params.set('status', document.getElementById('employeeStatus').value)
    const search = document.getElementById('employeeSearch').value.trim()
    if (search) params.set('search', search)
    if (branchInput.value) params.set('branch_id', branchInput.value)
    employees = await F.api('/employees?' + params.toString())
    renderEmployees()
  }

  function updateAdvanceAccounts() {
    const employee = employees.find(item => String(item.id) === document.getElementById('advanceEmployee').value)
    renderAccounts(document.getElementById('advanceAccount'), employee && employee.currency, employee && employee.branch_id)
  }

  function setFrequencyOptions(select, basis) {
    const values = {
      monthly: ['monthly'],
      daily: ['daily', 'weekly', 'biweekly', 'monthly'],
      hourly: ['hourly', 'weekly', 'biweekly', 'monthly'],
      contract: ['per_contract']
    }[basis] || ['monthly']
    const labels = { monthly: 'Monthly', weekly: 'Weekly', biweekly: 'Biweekly', daily: 'Daily', hourly: 'Hourly', per_contract: 'Per contract' }
    const previous = select.value
    select.innerHTML = values.map(value => '<option value="' + value + '">' + labels[value] + '</option>').join('')
    select.value = values.includes(previous) ? previous : values[0]
  }

  async function loadCompensationHistory(employeeId) {
    const rows = document.getElementById('compensationRows')
    rows.innerHTML = '<tr><td colspan="4" class="finance-caption">Loading rate history…</td></tr>'
    try {
      const history = await F.api('/employees/' + encodeURIComponent(employeeId) + '/compensation')
      rows.innerHTML = history.length
        ? history.map(item => '<tr><td>' + F.escapeHtml(F.date(item.effective_from)) + (item.effective_to ? '<span class="secondary">through ' + F.escapeHtml(F.date(item.effective_to)) + '</span>' : '') + '</td><td class="finance-number">' + F.escapeHtml(F.money(item.amount, item.currency)) + '</td><td>' + F.escapeHtml(item.payment_basis) + '</td><td>' + F.escapeHtml(item.payment_frequency) + '</td></tr>').join('')
        : '<tr><td colspan="4"><div class="finance-empty">No compensation history.</div></td></tr>'
    } catch (error) {
      rows.innerHTML = '<tr><td colspan="4" class="finance-caption">' + F.escapeHtml(error.message) + '</td></tr>'
    }
  }

  function renderPreview() {
    const button = document.getElementById('generateButton')
    if (!eligibleEmployees.length) {
      previewRows.innerHTML = '<tr><td colspan="5"><div class="finance-empty">No eligible employees for this period.</div></td></tr>'
      button.disabled = true
      return
    }
    previewRows.innerHTML = eligibleEmployees.map(employee => {
      let review = '<span class="finance-caption">Standard period</span>'
      let gross = Number(employee.rate || 0)
      if (employee.payment_basis === 'daily' || employee.payment_basis === 'hourly') {
        review = '<label class="finance-field"><span class="finance-caption">Payable ' + (employee.payment_basis === 'daily' ? 'days' : 'hours') + '</span><input data-units="' + employee.id + '" type="number" min="0.01" step="0.01" value="0" aria-label="Payable quantity for ' + F.escapeHtml(employee.name) + '"></label>'
        gross = 0
      } else if (employee.needs_proration_review) {
        review = '<label class="finance-field"><span class="finance-caption">Reviewed gross</span><input data-reviewed="' + employee.id + '" type="number" min="0" step="0.01" placeholder="Enter approved amount" aria-label="Reviewed gross for ' + F.escapeHtml(employee.name) + '"></label>'
        gross = 0
      }
      const warning = employee.needs_proration_review
        ? '<span class="finance-pill finance-pill-warn">Review dates</span>'
        : ''
      return '<tr>' +
        '<td><strong>' + F.escapeHtml(employee.name) + '</strong>' + (warning ? '<span class="secondary">' + warning + '</span>' : '') + '</td>' +
        '<td>' + F.escapeHtml(employee.payment_basis) + '</td>' +
        '<td class="finance-number">' + F.escapeHtml(F.money(employee.rate, employee.currency)) + '</td>' +
        '<td>' + review + '</td>' +
        '<td class="finance-number" data-gross-preview="' + employee.id + '">' + (gross ? F.escapeHtml(F.money(gross, employee.currency)) : '—') + '</td>' +
      '</tr>'
    }).join('')
    button.disabled = false
    previewRows.querySelectorAll('[data-units], [data-reviewed]').forEach(input => input.addEventListener('input', updateGrossPreview))
  }

  function updateGrossPreview(event) {
    const id = event.target.dataset.units || event.target.dataset.reviewed
    const employee = eligibleEmployees.find(item => String(item.id) === String(id))
    const output = previewRows.querySelector('[data-gross-preview="' + CSS.escape(String(id)) + '"]')
    if (!employee || !output) return
    let gross = 0
    if (event.target.dataset.units) gross = Number(employee.rate) * Number(event.target.value || 0)
    else gross = Number(event.target.value || 0)
    output.textContent = Number.isFinite(gross) && gross > 0 ? F.money(gross.toFixed(2), employee.currency) : '—'
  }

  function payrollActions(entry) {
    if (entry.status === 'draft') {
      return '<button class="finance-button finance-button-small" data-adjust="' + F.escapeHtml(entry.id) + '" type="button">Adjust</button>'
    }
    if (entry.status === 'approved' && Number(entry.outstanding) > 0) {
      return '<button class="finance-button finance-button-small finance-button-primary" data-pay="' + F.escapeHtml(entry.id) + '" type="button">Pay</button>'
    }
    return ''
  }

  function renderPayroll() {
    if (!payrollEntries.length) {
      payrollRows.innerHTML = '<tr><td colspan="9"><div class="finance-empty">No payroll run exists for this month.</div></td></tr>'
      document.getElementById('approveButton').disabled = true
      document.getElementById('payrollSummary').textContent = ''
      return
    }
    payrollRows.innerHTML = payrollEntries.map(entry =>
      '<tr>' +
        '<td><strong>' + F.escapeHtml(entry.employee_name) + '</strong><span class="secondary">' + F.escapeHtml(entry.employee_number || '') + '</span></td>' +
        '<td>' + F.escapeHtml(F.date(entry.period_start)) + ' – ' + F.escapeHtml(F.date(entry.period_end)) + '</td>' +
        '<td>' + F.escapeHtml(entry.payment_basis) + '</td>' +
        '<td class="numeric finance-number">' + F.escapeHtml(F.money(entry.gross_amount, entry.currency)) + '</td>' +
        '<td class="numeric finance-number">' + F.escapeHtml(F.money(entry.adjustments_total, entry.currency)) + '</td>' +
        '<td class="numeric finance-number">' + F.escapeHtml(F.money(entry.amount_paid, entry.currency)) + '</td>' +
        '<td class="numeric finance-number">' + F.escapeHtml(F.money(entry.outstanding, entry.currency)) + '</td>' +
        '<td>' + F.statusPill(entry.status) + '<span class="secondary">' + F.escapeHtml(entry.payment_status.replace(/_/g, ' ')) + '</span></td>' +
        '<td><div class="finance-table-actions">' + payrollActions(entry) + '</div></td>' +
      '</tr>'
    ).join('')
    const periodId = payrollEntries[0].payroll_period_id
    const allDraft = payrollEntries.every(entry => entry.status === 'draft')
    document.getElementById('approveButton').disabled = !allDraft
    document.getElementById('approveButton').dataset.periodId = periodId
    document.getElementById('payrollSummary').textContent = payrollEntries.length + ' employees · ' +
      F.money(payrollEntries.reduce((sum, entry) => sum + Number(entry.amount_due), 0), payrollEntries[0].currency)
  }

  async function loadPayroll() {
    const params = new URLSearchParams({ month: monthInput.value })
    if (branchInput.value) params.set('branch_id', branchInput.value)
    payrollEntries = await F.api('/payroll?' + params.toString())
    renderPayroll()
  }

  async function loadAdvances() {
    const query = branchSuffix()
    const advances = await F.api('/payroll/advances' + (query ? '?' + query.slice(1) : ''))
    const available = advances.filter(advance => Number(advance.outstanding) > 0)
    document.getElementById('advanceRows').innerHTML = available.length
      ? available.slice(0, 10).map(advance => '<tr><td>' + F.escapeHtml(advance.employee_name) + '<span class="secondary">' + F.escapeHtml(F.date(advance.payment_date)) + '</span></td><td class="numeric finance-number">' + F.escapeHtml(F.money(advance.outstanding, advance.currency)) + '</td></tr>').join('')
      : '<tr><td colspan="2"><div class="finance-empty">No unallocated advances.</div></td></tr>'
  }

  async function refreshAll() {
    F.clearAlert(alert)
    try {
      await Promise.all([loadEmployees(), loadPayroll(), loadAdvances()])
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  }

  document.getElementById('previewButton').addEventListener('click', async function () {
    F.clearAlert(alert)
    try {
      const bounds = F.monthBounds(monthInput.value)
      const eligible = await F.api('/payroll/eligible', F.jsonOptions('POST', {
        period_start: bounds.start,
        period_end: bounds.end,
        branch_id: branchInput.value || null
      }))
      eligibleEmployees = eligible
      renderPreview()
      document.getElementById('payrollSummary').textContent = eligible.length + ' eligible employees to review.'
    } catch (error) {
      eligibleEmployees = []
      renderPreview()
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('generateButton').addEventListener('click', async function () {
    F.clearAlert(alert)
    const bounds = F.monthBounds(monthInput.value)
    const inputs = eligibleEmployees.map(employee => {
      const units = previewRows.querySelector('[data-units="' + employee.id + '"]')
      const reviewed = previewRows.querySelector('[data-reviewed="' + employee.id + '"]')
      return {
        employee_id: employee.id,
        payable_units: units ? units.value : undefined,
        reviewed_gross_amount: reviewed ? reviewed.value : undefined
      }
    })
    try {
      await F.api('/payroll/generate', F.jsonOptions('POST', {
        period_start: bounds.start,
        period_end: bounds.end,
        branch_id: branchInput.value || null,
        employees: inputs
      }))
      eligibleEmployees = []
      renderPreview()
      F.alertFor(alert, 'Payroll has been generated as a draft. Review it before approval.', 'success')
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('approveButton').addEventListener('click', async function () {
    const periodId = this.dataset.periodId
    if (!periodId || !window.confirm('Approve this payroll period? Adjustments will be locked.')) return
    try {
      await F.api('/payroll/periods/' + encodeURIComponent(periodId) + '/approve', F.jsonOptions('POST', {}))
      F.alertFor(alert, 'Payroll period approved. Payments can now be recorded.', 'success')
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  employeeRows.addEventListener('click', function (event) {
    const editButton = event.target.closest('[data-edit-employee]')
    const button = event.target.closest('[data-advance]')
    if (editButton) {
      const employee = employees.find(item => String(item.id) === editButton.dataset.editEmployee)
      if (!employee) return
      document.getElementById('editEmployeeHeading').textContent = employee.name
      editEmployeeForm.elements.employee_id.value = employee.id
      editEmployeeForm.elements.employment_status.value = employee.employment_status
      editEmployeeForm.elements.last_working_date.value = employee.last_working_date ? String(employee.last_working_date).slice(0, 10) : ''
      editEmployeeForm.elements.employee_number.value = employee.employee_number || ''
      editEmployeeForm.elements.job_title.value = employee.job_title || ''
      editEmployeeForm.elements.branch_id.value = employee.branch_id == null ? '' : String(employee.branch_id)
      editEmployeeForm.elements.notes.value = employee.notes || ''
      compensationForm.elements.employee_id.value = employee.id
      compensationForm.elements.payment_basis.value = employee.payment_basis || 'monthly'
      setFrequencyOptions(compensationForm.elements.payment_frequency, compensationForm.elements.payment_basis.value)
      compensationForm.elements.amount.value = ''
      compensationForm.elements.effective_from.value = new Date().toISOString().slice(0, 10)
      compensationForm.elements.expected_payment_day.value = ''
      employeeDialog.showModal()
      loadCompensationHistory(employee.id)
      return
    }
    if (button) {
      document.getElementById('advanceEmployee').value = button.dataset.advance
      updateAdvanceAccounts()
      document.getElementById('advanceAmount').focus()
    }
  })

  document.getElementById('payrollRows').addEventListener('click', function (event) {
    const payButton = event.target.closest('[data-pay]')
    const adjustButton = event.target.closest('[data-adjust]')
    if (payButton) {
      selectedEntry = payrollEntries.find(entry => String(entry.id) === payButton.dataset.pay)
      if (!selectedEntry) return
      paymentForm.elements.amount.max = selectedEntry.outstanding
      paymentForm.elements.amount.value = selectedEntry.outstanding
      paymentForm.elements.reference.value = ''
      paymentForm.dataset.entryId = selectedEntry.id
      renderAccounts(document.getElementById('payAccount'), selectedEntry.currency, selectedEntry.branch_id)
      paymentDialog.showModal()
    } else if (adjustButton) {
      selectedAdjustmentEntry = payrollEntries.find(entry => String(entry.id) === adjustButton.dataset.adjust)
      if (!selectedAdjustmentEntry) return
      adjustmentForm.elements.amount.value = ''
      adjustmentForm.elements.description.value = ''
      adjustmentForm.dataset.entryId = selectedAdjustmentEntry.id
      adjustmentDialog.showModal()
    }
  })

  paymentForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    if (!selectedEntry) return
    const account = bootstrap.accounts.find(item => String(item.id) === paymentForm.elements.account_id.value)
    if (!account) {
      F.alertFor(alert, 'Choose an active account with the employee currency.', 'error')
      return
    }
    try {
      await F.api('/payroll/entries/' + encodeURIComponent(selectedEntry.id) + '/payments', F.jsonOptions('POST', {
        amount: paymentForm.elements.amount.value,
        payment_date: paymentForm.elements.payment_date.value,
        payment_method: paymentForm.elements.payment_method.value,
        account_id: account.id,
        currency: account.currency,
        reference: paymentForm.elements.reference.value,
        idempotency_key: F.randomKey()
      }))
      paymentDialog.close()
      selectedEntry = null
      F.alertFor(alert, 'Payroll payment recorded in the shared ledger.', 'success')
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  adjustmentForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const entryId = adjustmentForm.dataset.entryId
    try {
      await F.api('/payroll/entries/' + encodeURIComponent(entryId) + '/adjustments', F.jsonOptions('POST', {
        adjustment_type: adjustmentForm.elements.adjustment_type.value,
        amount: adjustmentForm.elements.amount.value,
        description: adjustmentForm.elements.description.value
      }))
      adjustmentDialog.close()
      F.alertFor(alert, 'Payroll adjustment added to the draft.', 'success')
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  advanceForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const account = bootstrap.accounts.find(item => String(item.id) === advanceForm.elements.account_id.value)
    if (!account) {
      F.alertFor(alert, 'Choose an active account matching this employee’s currency and branch.', 'error')
      return
    }
    try {
      await F.api('/employees/' + encodeURIComponent(advanceForm.elements.employee_id.value) + '/advances', F.jsonOptions('POST', {
        amount: advanceForm.elements.amount.value,
        payment_date: advanceForm.elements.payment_date.value,
        payment_method: advanceForm.elements.payment_method.value,
        account_id: account.id,
        currency: account.currency,
        reference: advanceForm.elements.reference.value,
        idempotency_key: F.randomKey()
      }))
      advanceForm.reset()
      document.getElementById('advanceDate').value = new Date().toISOString().slice(0, 10)
      updateAdvanceAccounts()
      F.alertFor(alert, 'Salary advance recorded and added to the shared ledger.', 'success')
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  employeeForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const teacherId = employeeForm.elements.teacher_id.value
    const basis = employeeForm.elements.payment_basis.value
    const compensation = {
      amount: employeeForm.elements.compensation_amount.value,
      currency: 'PKR',
      payment_frequency: employeeForm.elements.payment_frequency.value,
      expected_payment_day: employeeForm.elements.expected_payment_day.value || null
    }
    const body = {
      teacher_id: teacherId || null,
      name: teacherId ? null : employeeForm.elements.name.value,
      employee_number: employeeForm.elements.employee_number.value,
      job_title: employeeForm.elements.job_title.value,
      category_id: employeeForm.elements.category_id.value,
      branch_id: employeeForm.elements.branch_id.value || null,
      joining_date: employeeForm.elements.joining_date.value,
      employment_type: employeeForm.elements.employment_type.value,
      payment_basis: basis,
      compensation
    }
    try {
      await F.api('/employees', F.jsonOptions('POST', body))
      employeeForm.reset()
      employeeForm.classList.add('finance-hidden')
      document.getElementById('employeeNameWrap').classList.remove('finance-hidden')
      document.getElementById('joiningDate').value = new Date().toISOString().slice(0, 10)
      document.getElementById('paymentBasis').value = 'monthly'
      setFrequencyOptions(document.getElementById('paymentFrequency'), 'monthly')
      F.alertFor(alert, 'Employee profile and compensation record saved.', 'success')
      await loadBootstrap()
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  editEmployeeForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const employeeId = editEmployeeForm.elements.employee_id.value
    try {
      await F.api('/employees/' + encodeURIComponent(employeeId), F.jsonOptions('PUT', {
        employment_status: editEmployeeForm.elements.employment_status.value,
        last_working_date: editEmployeeForm.elements.last_working_date.value || null,
        employee_number: editEmployeeForm.elements.employee_number.value,
        job_title: editEmployeeForm.elements.job_title.value,
        branch_id: editEmployeeForm.elements.branch_id.value || null,
        notes: editEmployeeForm.elements.notes.value
      }))
      F.alertFor(alert, 'Employee details updated.', 'success')
      await loadEmployees()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  compensationForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const employeeId = compensationForm.elements.employee_id.value
    try {
      await F.api('/employees/' + encodeURIComponent(employeeId) + '/compensation', F.jsonOptions('POST', {
        payment_basis: compensationForm.elements.payment_basis.value,
        payment_frequency: compensationForm.elements.payment_frequency.value,
        amount: compensationForm.elements.amount.value,
        currency: 'PKR',
        expected_payment_day: compensationForm.elements.expected_payment_day.value || null,
        effective_from: compensationForm.elements.effective_from.value
      }))
      compensationForm.elements.amount.value = ''
      F.alertFor(alert, 'New compensation rate recorded.', 'success')
      await loadCompensationHistory(employeeId)
      await loadEmployees()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('toggleEmployeeForm').addEventListener('click', function () {
    employeeForm.classList.toggle('finance-hidden')
    if (!employeeForm.classList.contains('finance-hidden')) document.getElementById('employeeName').focus()
  })
  document.getElementById('cancelEmployeeForm').addEventListener('click', () => employeeForm.classList.add('finance-hidden'))
  document.getElementById('teacherLink').addEventListener('change', function () {
    const linked = Boolean(this.value)
    document.getElementById('employeeNameWrap').classList.toggle('finance-hidden', linked)
    if (linked) {
      const teacherCategory = bootstrap.employee_categories.find(category => category.category_key === 'teacher')
      if (teacherCategory) document.getElementById('employeeCategory').value = teacherCategory.id
    }
  })
  document.getElementById('paymentBasis').addEventListener('change', function () {
    setFrequencyOptions(document.getElementById('paymentFrequency'), this.value)
  })
  compensationForm.elements.payment_basis.addEventListener('change', function () {
    setFrequencyOptions(compensationForm.elements.payment_frequency, this.value)
  })
  document.getElementById('advanceEmployee').addEventListener('change', updateAdvanceAccounts)
  document.getElementById('employeeSearch').addEventListener('input', () => loadEmployees().catch(error => F.alertFor(alert, error.message, 'error')))
  document.getElementById('employeeStatus').addEventListener('change', () => loadEmployees().catch(error => F.alertFor(alert, error.message, 'error')))
  document.getElementById('reloadPayroll').addEventListener('click', () => loadPayroll().catch(error => F.alertFor(alert, error.message, 'error')))
  monthInput.addEventListener('change', async function () {
    eligibleEmployees = []
    renderPreview()
    try { await loadPayroll() } catch (error) { F.alertFor(alert, error.message, 'error') }
  })
  branchInput.addEventListener('change', async function () {
    eligibleEmployees = []
    renderPreview()
    try {
      await loadBootstrap()
      await refreshAll()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()))

  loadBootstrap().then(refreshAll).catch(error => F.alertFor(alert, error.message, 'error'))
})()
