'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeAmount,
  amountToCents,
  centsToAmount,
  calculateGross,
  paymentStatus,
  normalizeCategoryKey,
  isIsoDate,
  monthBounds,
  dueDateInMonth,
  recurrenceMatches
} = require('../finance-domain')

test('money parsing preserves cents and rejects malformed or unsafe amounts', () => {
  assert.equal(normalizeAmount('1234.5'), '1234.50')
  assert.equal(normalizeAmount('0', { allowZero: true }), '0.00')
  assert.equal(normalizeAmount('0'), null)
  assert.equal(normalizeAmount('-1.00'), null)
  assert.equal(normalizeAmount('1.001'), null)
  assert.equal(amountToCents('12.34'), 1234n)
  assert.equal(centsToAmount(-1234n), '-12.34')
})

test('payroll quantity calculations round to the nearest paisa', () => {
  assert.equal(calculateGross('1250.00', '2'), '2500.00')
  assert.equal(calculateGross('100.01', '0.5'), '50.01')
  assert.equal(calculateGross('100.00', '0'), null)
})

test('payment status distinguishes unpaid, partial, and fully paid balances', () => {
  assert.equal(paymentStatus('100.00', '0'), 'unpaid')
  assert.equal(paymentStatus('100.00', '99.99'), 'partially_paid')
  assert.equal(paymentStatus('100.00', '100.00'), 'paid')
  assert.equal(paymentStatus('100.00', '101.00'), 'paid')
})

test('dates and monthly due dates are validated and clamped', () => {
  assert.equal(isIsoDate('2026-02-28'), true)
  assert.equal(isIsoDate('2026-02-29'), false)
  assert.deepEqual(monthBounds('2026-02'), { start: '2026-02-01', end: '2026-02-28' })
  assert.equal(dueDateInMonth('2026-02-01', 31), '2026-02-28')
})

test('categories and recurring periods normalize deterministically', () => {
  assert.equal(normalizeCategoryKey('Generator Fuel'), 'generator_fuel')
  const template = { start_date: '2026-01-15', end_date: null, frequency: 'quarterly' }
  assert.equal(recurrenceMatches(template, '2026-04-01'), true)
  assert.equal(recurrenceMatches(template, '2026-03-01'), false)
  assert.equal(recurrenceMatches(template, '2025-12-01'), false)
})
