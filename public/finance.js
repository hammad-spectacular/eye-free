(function () {
  'use strict'

  const savedTheme = localStorage.getItem('attendance-theme') || 'light'
  document.documentElement.setAttribute('data-theme', savedTheme)

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character])
  }

  function money(value, currency) {
    const amount = Number(value || 0)
    if (!Number.isFinite(amount)) return '—'
    const formatted = new Intl.NumberFormat('en-PK', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount)
    return (currency === 'PKR' || !currency ? 'Rs. ' : currency + ' ') + formatted
  }

  function date(value) {
    if (!value) return '—'
    const text = String(value).slice(0, 10)
    const parsed = new Date(text + 'T00:00:00')
    return Number.isNaN(parsed.getTime())
      ? text
      : new Intl.DateTimeFormat('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }).format(parsed)
  }

  function monthValue() {
    return new Date().toISOString().slice(0, 7)
  }

  function monthBounds(value) {
    const match = /^(\d{4})-(\d{2})$/.exec(value || '')
    if (!match) throw new Error('Choose a valid month.')
    const year = Number(match[1])
    const month = Number(match[2])
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return { start: value + '-01', end: value + '-' + String(days).padStart(2, '0') }
  }

  function randomKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
  }

  async function api(path, options) {
    const settings = options || {}
    const headers = new Headers(settings.headers || {})
    if (settings.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const response = await fetch('/api/finance' + path, {
      ...settings,
      headers,
      credentials: 'same-origin'
    })
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text()
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : 'Finance request failed (' + response.status + ').'
      throw new Error(message)
    }
    return payload
  }

  function jsonOptions(method, body) {
    return { method: method || 'POST', body: JSON.stringify(body) }
  }

  function alertFor(element, message, type) {
    if (!element) return
    element.textContent = message
    element.className = 'finance-alert is-visible is-' + (type || 'info')
    element.setAttribute('role', type === 'error' ? 'alert' : 'status')
  }

  function clearAlert(element) {
    if (!element) return
    element.textContent = ''
    element.className = 'finance-alert'
  }

  function options(items, selected, emptyLabel) {
    const head = emptyLabel ? '<option value="">' + escapeHtml(emptyLabel) + '</option>' : ''
    return head + (items || []).map(item => {
      const value = escapeHtml(item.id)
      const label = escapeHtml(item.name || item.label || item.id)
      return '<option value="' + value + '"' + (String(item.id) === String(selected) ? ' selected' : '') + '>' + label + '</option>'
    }).join('')
  }

  function statusPill(status) {
    const styles = {
      paid: 'good',
      approved: 'good',
      active: 'good',
      unpaid: 'warn',
      draft: 'warn',
      partially_paid: 'warn',
      left: 'bad',
      inactive: 'bad',
      reversed: 'bad'
    }
    const label = String(status || '—').replace(/_/g, ' ')
    return '<span class="finance-pill finance-pill-' + (styles[status] || '') + '">' + escapeHtml(label) + '</span>'
  }

  document.querySelectorAll('[data-finance-theme]').forEach(button => {
    button.addEventListener('click', function () {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem('attendance-theme', next)
      button.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')
    })
  })

  window.Finance = {
    api,
    jsonOptions,
    escapeHtml,
    money,
    date,
    monthValue,
    monthBounds,
    randomKey,
    alertFor,
    clearAlert,
    options,
    statusPill
  }
})()
