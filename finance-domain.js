'use strict'

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/

function normalizeAmount(value, { allowZero = false } = {}) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2)
    : String(value == null ? '' : value).trim()
  if (!AMOUNT_PATTERN.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
  if (!allowZero && cents === 0n) return null
  return (cents / 100n).toString() + '.' + (cents % 100n).toString().padStart(2, '0')
}

function amountToCents(value) {
  const normalized = normalizeAmount(value, { allowZero: true })
  if (normalized === null) return null
  const [whole, fraction] = normalized.split('.')
  return BigInt(whole) * 100n + BigInt(fraction)
}

function centsToAmount(cents) {
  const value = BigInt(cents)
  const absolute = value < 0n ? -value : value
  const result = (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2, '0')
  return value < 0n ? '-' + result : result
}

function calculateGross(rate, units) {
  const normalizedRate = normalizeAmount(rate)
  const normalizedUnits = normalizeAmount(units)
  if (normalizedRate === null || normalizedUnits === null) return null
  const unitText = normalizedUnits.replace('.', '')
  const unitHundredths = BigInt(unitText)
  const grossCents = (amountToCents(normalizedRate) * unitHundredths + 50n) / 100n
  return centsToAmount(grossCents)
}

function paymentStatus(due, paid) {
  const dueCents = amountToCents(due)
  const paidCents = amountToCents(paid)
  if (dueCents === null || paidCents === null) return null
  if (paidCents === 0n) return 'unpaid'
  if (paidCents < dueCents) return 'partially_paid'
  return 'paid'
}

function normalizeCategoryKey(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00Z')
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function monthBounds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null
  const [year, month] = value.split('-').map(Number)
  if (month < 1 || month > 12) return null
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  return { start: value + '-01', end }
}

function dueDateInMonth(periodStart, dueDay) {
  const [year, month] = periodStart.split('-').map(Number)
  const day = Math.min(Number(dueDay), new Date(Date.UTC(year, month, 0)).getUTCDate())
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

function recurrenceMatches(template, periodStart) {
  if (!isIsoDate(periodStart)) return false
  if (periodStart < template.start_date) return false
  if (template.end_date && periodStart > template.end_date) return false
  const [startYear, startMonth] = template.start_date.slice(0, 7).split('-').map(Number)
  const [year, month] = periodStart.slice(0, 7).split('-').map(Number)
  const offset = (year - startYear) * 12 + month - startMonth
  if (offset < 0) return false
  if (template.frequency === 'monthly') return true
  if (template.frequency === 'quarterly') return offset % 3 === 0
  if (template.frequency === 'yearly') return offset % 12 === 0
  return false
}

module.exports = {
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
}
