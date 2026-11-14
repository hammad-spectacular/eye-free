(function () {
  'use strict'

  const F = window.Finance
  const alert = document.getElementById('financeAlert')
  const monthInput = document.getElementById('monthFilter')
  const branchInput = document.getElementById('branchFilter')
  const branchWrap = document.getElementById('branchFilterWrap')
  const incomeForm = document.getElementById('incomeForm')
  const incomeAccount = document.getElementById('incomeAccount')
  const incomeBranch = document.getElementById('incomeBranch')
  const incomeDate = document.getElementById('incomeDate')
  const transactionRows = document.getElementById('transactionRows')
  const reverseDialog = document.getElementById('reverseDialog')
  const reverseForm = document.getElementById('reverseForm')
  const openingDialog = document.getElementById('openingBalanceDialog')
  const openingForm = document.getElementById('openingBalanceForm')
  const accountForm = document.getElementById('accountForm')
  let bootstrap = { accounts: [], branches: [] }

  monthInput.value = F.monthValue()
  incomeDate.value = new Date().toISOString().slice(0, 10)
  document.getElementById('accountOpeningDate').value = new Date().toISOString().slice(0, 10)
  document.getElementById('openingBalanceDate').value = new Date().toISOString().slice(0, 10)

  function branchQuery(select) {
    return select && select.value ? '&branch_id=' + encodeURIComponent(select.value) : ''
  }

  function fillIncomeBranches() {
    incomeBranch.innerHTML = '<option value="">Automatic / school-wide</option>' +
      F.options(bootstrap.branches, null, '')
    document.getElementById('accountBranch').innerHTML = '<option value="">School-wide</option>' +
      F.options(bootstrap.branches, null, '')
    if (branchInput.value) {
      incomeBranch.value = branchInput.value
      document.getElementById('accountBranch').value = branchInput.value
    }
  }

  function fillAccounts() {
    const accounts = bootstrap.accounts || []
    incomeAccount.innerHTML = accounts.length
      ? accounts.map(account => '<option value="' + F.escapeHtml(account.id) + '">' +
          F.escapeHtml(account.name) + ' · ' + F.escapeHtml(account.currency) + '</option>').join('')
      : '<option value="">No active account available</option>'
    const selected = accounts.find(account => String(account.id) === incomeAccount.value)
    if (selected && selected.branch_id != null) incomeBranch.value = String(selected.branch_id)
    else if (branchInput.value) incomeBranch.value = branchInput.value
    const accountRows = document.getElementById('accountRows')
    accountRows.innerHTML = accounts.length
      ? accounts.map(account => {
          const branch = account.branch_id == null
            ? 'School-wide'
            : ((bootstrap.branches || []).find(item => Number(item.id) === Number(account.branch_id)) || {}).name || 'Branch ' + account.branch_id
          return '<tr><td><strong>' + F.escapeHtml(account.name) + '</strong><span class="secondary">' + F.escapeHtml(branch) + ' · ' + F.escapeHtml(account.currency) + '</span></td>' +
            '<td class="numeric finance-number">' + F.escapeHtml(F.money(account.opening_balance, account.currency)) + '</td>' +
            '<td><div class="finance-table-actions"><button class="finance-button finance-button-small" data-opening="' + F.escapeHtml(account.id) + '" data-amount="' + F.escapeHtml(account.opening_balance) + '" data-date="' + F.escapeHtml(String(account.opening_balance_date).slice(0, 10)) + '" type="button">Set balance</button></div></td></tr>'
        }).join('')
      : '<tr><td colspan="3"><div class="finance-empty">No active finance accounts.</div></td></tr>'
  }

  function setRail(id, amount, total) {
    const element = document.getElementById(id)
    const width = total > 0 ? Math.max(2, Math.min(100, amount / total * 100)) : 0
    element.style.flexBasis = width + '%'
  }

  function renderTransactions(items) {
    if (!items.length) {
      transactionRows.innerHTML = '<tr><td colspan="6"><div class="finance-empty">No cash movements recorded for this month.</div></td></tr>'
      return
    }
    transactionRows.innerHTML = items.slice(0, 12).map(item => {
      const reversed = item.is_reversed
      const isReversal = item.transaction_type === 'reversal'
      const direction = item.direction === 'in' ? '+' : '−'
      const status = isReversal ? 'reversal' : (reversed ? 'reversed' : item.transaction_type)
      const action = !reversed && !isReversal
        ? '<button class="finance-button finance-button-small finance-button-danger" data-reverse="' + F.escapeHtml(item.id) + '" type="button">Reverse</button>'
        : ''
      return '<tr>' +
        '<td>' + F.escapeHtml(F.date(item.transaction_date)) + '</td>' +
        '<td><strong>' + F.escapeHtml(item.source_type.replace(/_/g, ' ')) + '</strong>' +
          (item.reference ? '<span class="secondary">' + F.escapeHtml(item.reference) + '</span>' : '') + '</td>' +
        '<td>' + F.escapeHtml(item.account_name) + '</td>' +
        '<td class="numeric finance-number">' + direction + F.escapeHtml(F.money(item.amount, item.currency)) + '</td>' +
        '<td>' + F.statusPill(status) + '</td>' +
        '<td><div class="finance-table-actions">' + action + '</div></td>' +
      '</tr>'
    }).join('')
  }

  async function loadBootstrap() {
    const query = branchQuery(branchInput)
    const selectedBranch = branchInput.value
    bootstrap = await F.api('/bootstrap' + (query ? '?' + query.slice(1) : ''))
    const branches = bootstrap.branches || []
    branchWrap.classList.toggle('finance-hidden', branches.length === 0)
    branchInput.innerHTML = '<option value="">All branches</option>' + F.options(branches, selectedBranch, '')
    fillIncomeBranches()
    fillAccounts()
  }

  async function loadOverview() {
    F.clearAlert(alert)
    const month = monthInput.value || F.monthValue()
    const range = F.monthBounds(month)
    const query = '?month=' + encodeURIComponent(month) + branchQuery(branchInput)
    const transactionQuery = '?from=' + encodeURIComponent(range.start) + '&to=' + encodeURIComponent(range.end) + branchQuery(branchInput)
    try {
      const [overview, transactions] = await Promise.all([
        F.api('/overview' + query),
        F.api('/transactions' + transactionQuery)
      ])
      const currency = overview.currency || 'PKR'
      document.getElementById('totalIncome').textContent = F.money(overview.total_income, currency)
      document.getElementById('totalExpenses').textContent = F.money(overview.total_expenses_paid, currency)
      document.getElementById('pendingPayments').textContent = F.money(overview.outstanding_obligations, currency)
      document.getElementById('availableBalance').textContent = F.money(overview.available_after_obligations, currency)
      document.getElementById('openingCash').textContent = F.money(overview.opening_cash, currency)
      document.getElementById('actualCash').textContent = F.money(overview.actual_cash, currency)
      const amounts = [
        Number(overview.total_income) || 0,
        Number(overview.total_expenses_paid) || 0,
        Number(overview.outstanding_obligations) || 0
      ]
      const sum = amounts.reduce((total, amount) => total + amount, 0)
      setRail('incomeRail', amounts[0], sum)
      setRail('expensesRail', amounts[1], sum)
      setRail('pendingRail', amounts[2], sum)
      document.getElementById('cashStatus').textContent = month
      renderTransactions(transactions)
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
      transactionRows.innerHTML = '<tr><td colspan="6"><div class="finance-empty">The ledger could not be loaded.</div></td></tr>'
    }
  }

  branchInput.addEventListener('change', async function () {
    try {
      await loadBootstrap()
      await loadOverview()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })
  monthInput.addEventListener('change', loadOverview)
  document.getElementById('refreshButton').addEventListener('click', loadOverview)
  incomeAccount.addEventListener('change', fillAccounts)

  document.getElementById('toggleAccountForm').addEventListener('click', function () {
    accountForm.classList.toggle('finance-hidden')
    if (!accountForm.classList.contains('finance-hidden')) document.getElementById('accountName').focus()
  })

  accountForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    try {
      await F.api('/accounts', F.jsonOptions('POST', {
        name: accountForm.elements.name.value,
        currency: 'PKR',
        opening_balance: accountForm.elements.opening_balance.value,
        opening_balance_date: accountForm.elements.opening_balance_date.value,
        branch_id: accountForm.elements.branch_id.value || null
      }))
      accountForm.reset()
      document.getElementById('accountOpening').value = '0'
      document.getElementById('accountOpeningDate').value = new Date().toISOString().slice(0, 10)
      accountForm.classList.add('finance-hidden')
      await loadBootstrap()
      await loadOverview()
      F.alertFor(alert, 'Finance account created.', 'success')
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.getElementById('accountRows').addEventListener('click', function (event) {
    const button = event.target.closest('[data-opening]')
    if (!button) return
    openingForm.elements.account_id.value = button.dataset.opening
    openingForm.elements.opening_balance.value = button.dataset.amount
    openingForm.elements.opening_balance_date.value = button.dataset.date
    openingDialog.showModal()
  })

  openingForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const accountId = openingForm.elements.account_id.value
    try {
      await F.api('/accounts/' + encodeURIComponent(accountId) + '/opening-balance', F.jsonOptions('PUT', {
        opening_balance: openingForm.elements.opening_balance.value,
        opening_balance_date: openingForm.elements.opening_balance_date.value
      }))
      openingDialog.close()
      await loadBootstrap()
      await loadOverview()
      F.alertFor(alert, 'Account opening balance updated.', 'success')
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  incomeForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    F.clearAlert(alert)
    const account = bootstrap.accounts.find(item => String(item.id) === incomeAccount.value)
    if (!account) {
      F.alertFor(alert, 'Choose an active financial account first.', 'error')
      return
    }
    const branchId = incomeBranch.value || account.branch_id || branchInput.value || null
    const body = {
      amount: incomeForm.elements.amount.value,
      transaction_date: incomeForm.elements.transaction_date.value,
      payment_method: incomeForm.elements.payment_method.value,
      account_id: account.id,
      currency: account.currency,
      branch_id: branchId,
      reference: incomeForm.elements.reference.value,
      memo: incomeForm.elements.memo.value,
      idempotency_key: F.randomKey()
    }
    try {
      await F.api('/income', F.jsonOptions('POST', body))
      incomeForm.reset()
      incomeDate.value = new Date().toISOString().slice(0, 10)
      fillAccounts()
      F.alertFor(alert, 'Income recorded in the shared finance ledger.', 'success')
      await loadOverview()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  transactionRows.addEventListener('click', function (event) {
    const button = event.target.closest('[data-reverse]')
    if (!button) return
    reverseForm.elements.transaction_id.value = button.dataset.reverse
    reverseForm.elements.reason.value = ''
    reverseDialog.showModal()
  })

  reverseForm.addEventListener('submit', async function (event) {
    event.preventDefault()
    const transactionId = reverseForm.elements.transaction_id.value
    try {
      await F.api('/transactions/' + encodeURIComponent(transactionId) + '/reverse', F.jsonOptions('POST', {
        reason: reverseForm.elements.reason.value,
        idempotency_key: F.randomKey()
      }))
      reverseDialog.close()
      F.alertFor(alert, 'A reversal has been added to the ledger.', 'success')
      await loadOverview()
    } catch (error) {
      F.alertFor(alert, error.message, 'error')
    }
  })

  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.addEventListener('click', function () {
      button.closest('dialog').close()
    })
  })

  loadBootstrap().then(loadOverview).catch(error => F.alertFor(alert, error.message, 'error'))
})()
