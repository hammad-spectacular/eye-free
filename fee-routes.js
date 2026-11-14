/* ==========================================================================
   fee-routes.js
   --------------------------------------------------------------------------
   The server side of the fee voucher generator: the real students, classes and
   fee rules of a school, plus the vouchers and receipts made from them.

   The money maths is not repeated here. Every calculation comes from
   voucher-engine.js (the same file the browser loads), so the printed challan,
   the collection screen and the stored records can never disagree about what
   is owed. This module only reads and writes rows, and hands the engine the
   same shape of data it already understands.

   Everything is scoped by tenant: a request only ever sees the academy it
   belongs to, and a coordinator only ever sees their own branch.

   Mounted at /api/fees by serverg.js.
   ========================================================================== */

const express = require('express')
const jwt = require('jsonwebtoken')
const E = require('./voucher-engine')
const { isCoordinator } = require('./authMiddleware')

const num = E.num
const DAY_MS = 24 * 60 * 60 * 1000

function createFeeRouter({ pool, requireAuth }) {
  const router = express.Router()
  const auth = requireAuth(['admin', 'super_admin', 'coordinator'])

  // --------------------------------------------------------------------------
  // Reading a school out of the database
  // --------------------------------------------------------------------------

  /** A voucher row becomes the object the fee engine works with. */
  function rowToVoucher(r) {
    return {
      id: r.ref_id,
      studentId: r.student_id,
      studentName: r.student_name || '',
      fatherName: r.father_name || '',
      admissionNumber: r.admission_number || '',
      className: r.class_name || '',
      classId: r.class_id,
      month: r.month,
      year: String(r.year),
      amount: num(r.amount),
      baseAmount: num(r.base_amount),
      discount: num(r.discount),
      charges: Array.isArray(r.charges) ? r.charges : [],
      status: r.status || 'Unpaid',
      issueDate: r.issue_date ? new Date(r.issue_date).toISOString() : null,
      dueDate: r.due_date ? new Date(r.due_date).toISOString() : null,
      paymentDate: r.payment_date ? new Date(r.payment_date).toISOString() : null,
      totalReceived: num(r.total_received),
      paidTuition: num(r.paid_tuition),
      paidAC: num(r.paid_ac),
      ...(r.fine_charged != null && { fineCharged: num(r.fine_charged) }),
      fineWaived: !!r.fine_waived,
      remainingAnnualCharges: num(r.remaining_annual_charges),
    }
  }

  /** A receipt row becomes the object the fee engine works with. */
  function rowToReceipt(r) {
    return {
      id: r.ref_id,
      receiptNo: r.receipt_no,
      voucherId: r.voucher_id,
      studentId: r.student_id,
      studentName: r.student_name || '',
      className: r.class_name || '',
      month: r.month || '',
      year: String(r.year || ''),
      paidTuition: num(r.paid_tuition),
      paidAC: num(r.paid_ac),
      amount: num(r.amount),
      receivedAt: new Date(r.received_at).toISOString(),
      receivedBy: r.received_by || '',
      receivedByName: r.received_by_name || '',
      allocations: Array.isArray(r.allocations) ? r.allocations : [],
      reversedAt: r.reversed_at ? new Date(r.reversed_at).toISOString() : null,
      reversedBy: r.reversed_by || null,
    }
  }

  /** The fee rules of one student: their own row wins over the class row. */
  function feeFor(feeMap, student) {
    const own = feeMap.get(`student:${student.id}`)
    const klass = student.class_id != null ? feeMap.get(`class:${student.class_id}`) : null
    const row = own || klass
    return {
      monthlyFee: num(row?.monthly_fee),
      discount: num(row?.discount),
      admissionFee: num(row?.admission_fee),
      transportFee: num(row?.transport_fee),
    }
  }

  /**
   * Loads the whole school into the shape the fee engine expects:
   * settings, classes, students, vouchers and receipts.
   */
  async function loadDb(client, tenantId, user) {
    const branchId = isCoordinator(user) ? user.branch_id : null

    const classQuery = branchId
      ? client.query('SELECT id, name, section FROM classes WHERE tenant_id = $1 AND branch_id = $2 ORDER BY id', [tenantId, branchId])
      : client.query('SELECT id, name, section FROM classes WHERE tenant_id = $1 ORDER BY id', [tenantId])
    const studentQuery = branchId
      ? client.query('SELECT id, name, roll_no, phone, class_id, login_id FROM students WHERE tenant_id = $1 AND branch_id = $2 ORDER BY name, id', [tenantId, branchId])
      : client.query('SELECT id, name, roll_no, phone, class_id, login_id FROM students WHERE tenant_id = $1 ORDER BY name, id', [tenantId])

    const [classesRes, studentsRes, feesRes, settingsRes, voucherRes, receiptRes] = await Promise.all([
      classQuery,
      studentQuery,
      client.query('SELECT type, target_id, monthly_fee, admission_fee, transport_fee, discount FROM fee_structures WHERE tenant_id = $1 ORDER BY id', [tenantId]),
      client.query('SELECT due_days, late_fine, branding FROM fee_settings WHERE tenant_id = $1', [tenantId]),
      client.query('SELECT * FROM fee_vouchers WHERE tenant_id = $1 ORDER BY year, month, id', [tenantId]),
      client.query('SELECT * FROM fee_receipts WHERE tenant_id = $1 ORDER BY id', [tenantId]),
    ])

    // The newest fee row for a class or a student wins.
    const feeMap = new Map()
    for (const row of feesRes.rows) feeMap.set(`${row.type}:${row.target_id}`, row)

    // Annual charges already paid come from the receipts that are not reversed.
    const paidAnnual = new Map()
    for (const row of receiptRes.rows) {
      if (row.reversed_at) continue
      paidAnnual.set(row.student_id, num(paidAnnual.get(row.student_id)) + num(row.paid_ac))
    }

    const classes = classesRes.rows.map((c) => ({
      id: c.id,
      name: c.name,
      section: c.section || '',
      monthlyFee: num(feeMap.get(`class:${c.id}`)?.monthly_fee),
      annualCharges: num(feeMap.get(`class:${c.id}`)?.admission_fee),
    }))

    const students = studentsRes.rows.map((s) => {
      const fee = feeFor(feeMap, s)
      return {
        id: s.id,
        name: s.name,
        fatherName: '',
        admissionNumber: s.roll_no || s.login_id || `ST-${s.id}`,
        classId: s.class_id,
        monthlyFee: fee.monthlyFee,
        discount: fee.discount,
        annualCharges: fee.admissionFee,
        paidAnnualCharges: num(paidAnnual.get(s.id)),
        monthlyCharges: fee.transportFee > 0 ? [{ label: 'Transport Fee', amount: fee.transportFee }] : [],
        parentPhone: s.phone || '',
        status: 'Active',
      }
    })

    const settingsRow = settingsRes.rows[0]
    const settings = {
      dueDays: settingsRow ? num(settingsRow.due_days) : E.DEFAULT_DUE_DAYS,
      lateFine: settingsRow ? num(settingsRow.late_fine) : 0,
    }

    const branding = (settingsRow && settingsRow.branding) || {}

    const fees = voucherRes.rows.map(rowToVoucher)
    const payments = receiptRes.rows.map(rowToReceipt)

    const counters = {
      voucher: fees.reduce((max, v) => Math.max(max, num(v.id)), 0),
      payment: payments.reduce((max, p) => Math.max(max, num(p.id)), 0),
    }

    return { settings, classes, students, fees, payments, counters, branding }
  }

  /** Vouchers with arrears, late fines and balances worked out fresh. */
  function decorate(db, vouchers) {
    const students = new Map(db.students.map((s) => [String(s.id), s]))
    return E.withBalances(vouchers, db.fees, students, db.settings)
  }

  /**
   * The saved challan charges that apply to this student: every school-wide
   * preset plus the ones scoped to the student's class. A preset whose name
   * is already a monthly charge (the transport fee, say) is not repeated.
   */
  function presetChargesFor(db, student) {
    const presets = Array.isArray(db.branding?.chargePresets) ? db.branding.chargePresets : []
    const taken = new Set((student.monthlyCharges ?? []).map((c) => String(c.label).toLowerCase()))
    const out = []
    for (const p of presets) {
      const label = String(p?.label ?? '').trim()
      const amount = num(p?.amount)
      if (!label || !(amount > 0) || taken.has(label.toLowerCase())) continue
      const scope = p?.classId == null ? '' : String(p.classId)
      if (scope !== '' && scope !== String(student.classId)) continue
      taken.add(label.toLowerCase())
      out.push({ label, amount })
    }
    return out
  }

  // --------------------------------------------------------------------------
  // Writing back
  // --------------------------------------------------------------------------

  async function persist(client, tenantId, db) {
    for (const v of db.fees) {
      await client.query(
        `INSERT INTO fee_vouchers (
           tenant_id, ref_id, student_id, class_id, student_name, father_name, admission_number,
           class_name, month, year, amount, base_amount, discount, charges, status, issue_date,
           due_date, payment_date, total_received, paid_tuition, paid_ac, fine_charged,
           fine_waived, remaining_annual_charges, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, NOW())
         ON CONFLICT (tenant_id, ref_id) DO UPDATE SET
           amount = EXCLUDED.amount, base_amount = EXCLUDED.base_amount, discount = EXCLUDED.discount,
           charges = EXCLUDED.charges, status = EXCLUDED.status, due_date = EXCLUDED.due_date,
           payment_date = EXCLUDED.payment_date, total_received = EXCLUDED.total_received,
           paid_tuition = EXCLUDED.paid_tuition, paid_ac = EXCLUDED.paid_ac,
           fine_charged = EXCLUDED.fine_charged, fine_waived = EXCLUDED.fine_waived,
           remaining_annual_charges = EXCLUDED.remaining_annual_charges, updated_at = NOW()`,
        [
          tenantId, num(v.id), v.studentId ?? null, v.classId ?? null, v.studentName || null,
          v.fatherName || null, v.admissionNumber || null, v.className || null, v.month, String(v.year),
          num(v.amount), num(v.baseAmount), num(v.discount), JSON.stringify(v.charges ?? []),
          v.status || 'Unpaid', v.issueDate || null, v.dueDate || null, v.paymentDate || null,
          num(v.totalReceived), num(v.paidTuition), num(v.paidAC),
          v.fineCharged == null ? null : num(v.fineCharged), !!v.fineWaived,
          num(v.remainingAnnualCharges),
        ]
      )
    }

    // A voucher that was reversed is gone from the list, so take it out of the database too.
    const refs = db.fees.map((v) => num(v.id))
    await client.query('DELETE FROM fee_vouchers WHERE tenant_id = $1 AND NOT (ref_id = ANY($2::int[]))', [tenantId, refs])

    for (const p of db.payments) {
      await client.query(
        `INSERT INTO fee_receipts (
           tenant_id, ref_id, receipt_no, voucher_id, student_id, student_name, class_name, month, year,
           paid_tuition, paid_ac, amount, allocations, received_at, received_by, received_by_name,
           reversed_at, reversed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)
         ON CONFLICT (tenant_id, ref_id) DO UPDATE SET
           paid_tuition = EXCLUDED.paid_tuition, paid_ac = EXCLUDED.paid_ac, amount = EXCLUDED.amount,
           allocations = EXCLUDED.allocations, reversed_at = EXCLUDED.reversed_at, reversed_by = EXCLUDED.reversed_by`,
        [
          tenantId, num(p.id), p.receiptNo || `RCP-${num(p.id)}`, p.voucherId ?? null, p.studentId ?? null,
          p.studentName || null, p.className || null, p.month || null, p.year ? String(p.year) : null,
          num(p.paidTuition), num(p.paidAC), num(p.amount), JSON.stringify(p.allocations ?? []),
          p.receivedAt || new Date().toISOString(), p.receivedBy || null, p.receivedByName || null,
          p.reversedAt || null, p.reversedBy || null,
        ]
      )
    }
  }

  /** Keeps the older Fees tab in step with what the voucher module records. */
  async function syncLegacyPayments(client, tenantId, db, receipt) {
    const lines = receipt?.allocations?.length
      ? receipt.allocations
      : [{ voucherId: receipt?.voucherId, amount: receipt?.paidTuition }]

    for (const line of lines) {
      const voucher = db.fees.find((v) => String(v.id) === String(line.voucherId))
      if (!voucher || voucher.studentId == null) continue
      const monthIndex = E.MONTHS.indexOf(String(voucher.month))
      const month = monthIndex >= 0 ? `${voucher.year}-${String(monthIndex + 1).padStart(2, '0')}` : `${voucher.year}-01`
      const paid = num(voucher.paidTuition) + num(voucher.paidAC)
      const status = num(voucher.paidTuition) >= num(voucher.amount) ? 'paid' : paid > 0 ? 'partial' : 'unpaid'
      await client.query(
        `INSERT INTO fee_payments (student_id, month, amount_due, amount_paid, status, tenant_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, NOW())
         ON CONFLICT (student_id, month, tenant_id) DO UPDATE SET
           amount_due = EXCLUDED.amount_due, amount_paid = EXCLUDED.amount_paid,
           status = EXCLUDED.status, updated_at = NOW()`,
        [voucher.studentId, month, num(voucher.amount), paid, status, tenantId]
      )
    }
  }

  async function ensureSettings(client, tenantId) {
    await client.query(
      `INSERT INTO fee_settings (tenant_id, due_days, late_fine, branding)
       VALUES ($1, $2, $3, '{}'::jsonb) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, E.DEFAULT_DUE_DAYS, 0]
    )
    const res = await client.query('SELECT due_days, late_fine, branding FROM fee_settings WHERE tenant_id = $1', [tenantId])
    return res.rows[0] || { due_days: E.DEFAULT_DUE_DAYS, late_fine: 0, branding: {} }
  }

  /** Runs a write inside a transaction, so a refused change leaves nothing behind. */
  async function withTransaction(handler) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try { await client.query('ROLLBACK') } catch (ignored) { /* the connection is already broken */ }
      throw err
    } finally {
      client.release()
    }
  }

  /** The message the fee engine refuses with, as a clean HTTP answer. */
  function sendError(res, err) {
    if (err instanceof E.Refused) return res.status(400).json({ error: err.message, refused: true })
    console.error('fee API error:', err.message)
    return res.status(500).json({ error: err.message || 'Something went wrong with the fee records.' })
  }

  // --------------------------------------------------------------------------
  // Routes
  // --------------------------------------------------------------------------

  /**
   * Is the fee service there, and is this browser signed in?
   *
   * The page asks this before anything else. It always answers with a 200, so
   * a browser that is not signed in gets a plain answer instead of an error
   * in the console, and knows to show the demo data instead.
   */
  router.get('/status', async (req, res) => {
    let signedIn = false;
    try {
      const header = req.headers['authorization'];
      const token = header && header.startsWith('Bearer ')
        ? header.slice(7)
        : req.cookies?.auth_token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'theEye_Secret_2024_xK9mP2qR7vN');
        signedIn = !!decoded.tenant_id;
      }
    } catch (err) {
      signedIn = false;
    }
    res.json({ service: 'fees', signedIn });
  })

  /** Everything the page needs to start: the school's classes, students and rules. */
  router.get('/bootstrap', auth, async (req, res) => {
    try {
      const client = await pool.connect()
      try {
        const db = await loadDb(client, req.user.tenant_id, req.user)
        res.json({
          classes: db.classes,
          students: db.students,
          settings: db.settings,
          branding: db.branding,
          counts: {
            classes: db.classes.length,
            students: db.students.length,
            vouchers: db.fees.length,
          },
        })
      } finally {
        client.release()
      }
    } catch (err) {
      sendError(res, err)
    }
  })

  /** The vouchers of a billing cycle, with arrears and balances worked out. */
  router.get('/vouchers', auth, async (req, res) => {
    try {
      const client = await pool.connect()
      try {
        const db = await loadDb(client, req.user.tenant_id, req.user)
        let fees = db.fees

        const { month, year, classId, status, search } = req.query
        if (month && month !== 'all') fees = fees.filter((f) => f.month === month)
        if (year && year !== 'all') fees = fees.filter((f) => String(f.year) === String(year))
        if (classId && classId !== 'all') fees = fees.filter((f) => String(f.classId) === String(classId))
        if (status && status !== 'all') fees = fees.filter((f) => f.status === status)
        if (search) {
          const q = String(search).toLowerCase()
          fees = fees.filter((f) => [f.studentName, f.fatherName, f.admissionNumber, f.className]
            .some((v) => String(v ?? '').toLowerCase().includes(q)))
        }

        res.json(decorate(db, fees))
      } finally {
        client.release()
      }
    } catch (err) {
      sendError(res, err)
    }
  })

  /** Generates the vouchers of one month for a class, or for the whole school. */
  router.post('/vouchers/generate', auth, async (req, res) => {
    try {
      const body = req.body || {}
      const tenantId = req.user.tenant_id
      const month = body.month || E.MONTHS[new Date().getMonth()]
      const year = String(body.year || new Date().getFullYear())

      const count = await withTransaction(async (client) => {
        const db = await loadDb(client, tenantId, req.user)
        const alreadyBilled = new Set(
          db.fees.filter((f) => f.month === month && String(f.year) === year).map((f) => String(f.studentId))
        )

        let targets = db.students.filter((s) => !E.isLeft(s))
        if (Array.isArray(body.studentIds) && body.studentIds.length) {
          targets = targets.filter((s) => body.studentIds.some((id) => String(id) === String(s.id)))
        } else if (body.classId && body.classId !== 'all') {
          targets = targets.filter((s) => String(s.classId) === String(body.classId))
        }

        const issued = new Date()
        const dueDate = new Date(issued.getTime() + db.settings.dueDays * DAY_MS)
        const classes = new Map(db.classes.map((c) => [String(c.id), c]))

        let made = 0
        for (const student of targets) {
          if (alreadyBilled.has(String(student.id))) continue
          const extra = presetChargesFor(db, student)
          const voucher = E.newVoucher(
            extra.length ? { ...student, monthlyCharges: [...(student.monthlyCharges ?? []), ...extra] } : student,
            E.classLabel(classes.get(String(student.classId)), student.classId),
            month,
            year,
            issued,
            dueDate
          )
          if (E.insertIfNew(db, voucher)) made++
        }

        await persist(client, tenantId, db)
        return made
      })

      res.json({ count, month, year })
    } catch (err) {
      sendError(res, err)
    }
  })

  /** Replaces the charges on one voucher. */
  router.put('/vouchers/:id/charges', auth, async (req, res) => {
    try {
      const parsed = E.parseCharges((req.body || {}).charges)
      if (typeof parsed === 'string') return res.status(400).json({ error: parsed })

      const tenantId = req.user.tenant_id
      const voucher = await withTransaction(async (client) => {
        const db = await loadDb(client, tenantId, req.user)
        const result = E.setVoucherCharges(db, req.params.id, parsed)
        if (!result) return null
        await persist(client, tenantId, db)
        return result.voucher
      })

      if (!voucher) return res.status(404).json({ error: 'That voucher no longer exists.' })
      res.json({ voucher })
    } catch (err) {
      sendError(res, err)
    }
  })

  /** Adds one charge to many vouchers at once (an exam fee for a whole class, say). */
  router.post('/vouchers/charges', auth, async (req, res) => {
    try {
      const body = req.body || {}
      const parsed = E.parseCharges([body.charge])
      if (typeof parsed === 'string') return res.status(400).json({ error: parsed })

      const tenantId = req.user.tenant_id
      const result = await withTransaction(async (client) => {
        const db = await loadDb(client, tenantId, req.user)
        const outcome = E.addChargeToVouchers(db, body.voucherIds || [], parsed[0])
        await persist(client, tenantId, db)
        return outcome
      })

      res.json({ added: result.added.length, skipped: result.skipped })
    } catch (err) {
      sendError(res, err)
    }
  })

  /** Deletes a voucher and takes back every receipt that touched it. */
  router.delete('/vouchers/:id', auth, async (req, res) => {
    try {
      const tenantId = req.user.tenant_id
      const result = await withTransaction(async (client) => {
        const db = await loadDb(client, tenantId, req.user)
        const outcome = E.reverseVoucher(db, req.params.id)
        if (!outcome) return null
        await persist(client, tenantId, db)
        return outcome
      })

      if (!result) return res.status(404).json({ error: 'That voucher no longer exists.' })
      res.json({ takenBack: result.takenBack, receipts: result.receipts })
    } catch (err) {
      sendError(res, err)
    }
  })

  /** Takes a payment and issues the receipt for it. */
  router.post('/receipts', auth, async (req, res) => {
    try {
      const body = req.body || {}
      const tenantId = req.user.tenant_id
      const session = {
        username: req.user.login_id || String(req.user.user_id),
        displayName: req.user.login_id || String(req.user.user_id),
      }

      const result = await withTransaction(async (client) => {
        const db = await loadDb(client, tenantId, req.user)
        const outcome = E.receivePayment(db, body.voucherId, {
          paidTuition: E.num(body.paidTuition),
          paidAC: E.num(body.paidAC),
          waiveFine: !!body.waiveFine,
          advance: !!body.advance,
          monthlyCharges: body.monthlyCharges !== false,
        }, session)
        if (!outcome) return null
        outcome.receipt.receiptNo = `RCP-${tenantId}-${String(outcome.receipt.id).padStart(5, '0')}`
        await persist(client, tenantId, db)
        await syncLegacyPayments(client, tenantId, db, outcome.receipt)
        return outcome
      })

      if (!result) return res.status(404).json({ error: 'That voucher no longer exists.' })
      res.json({ receipt: result.receipt, voucher: result.voucher })
    } catch (err) {
      sendError(res, err)
    }
  })

  /** Undoes a receipt: the money comes off the vouchers it reached. */
  router.post('/receipts/:id/reverse', auth, async (req, res) => {
    try {
      const tenantId = req.user.tenant_id
      const receipt = await withTransaction(async (client) => {
        const db = await loadDb(client, tenantId, req.user)
        const outcome = E.reverseReceipt(db, req.params.id)
        if (!outcome) return null
        await persist(client, tenantId, db)
        return outcome
      })

      if (!receipt) return res.status(404).json({ error: 'That receipt was already reversed.' })
      res.json({ receipt })
    } catch (err) {
      sendError(res, err)
    }
  })

  /** The receipts of a school, newest first. */
  router.get('/receipts', auth, async (req, res) => {
    try {
      const client = await pool.connect()
      try {
        const db = await loadDb(client, req.user.tenant_id, req.user)
        let receipts = db.payments
        if (req.query.studentId) {
          receipts = receipts.filter((p) => String(p.studentId) === String(req.query.studentId))
        }
        res.json([...receipts].sort((a, b) => num(b.id) - num(a.id)))
      } finally {
        client.release()
      }
    } catch (err) {
      sendError(res, err)
    }
  })

  /** The fee rules of the school: how many days a bill is good for, and the late fine. */
  router.get('/settings', auth, async (req, res) => {
    try {
      const client = await pool.connect()
      try {
        const db = await loadDb(client, req.user.tenant_id, req.user)
        res.json({ ...db.settings, branding: db.branding })
      } finally {
        client.release()
      }
    } catch (err) {
      sendError(res, err)
    }
  })

  router.put('/settings', auth, async (req, res) => {
    try {
      const body = req.body || {}
      const tenantId = req.user.tenant_id
      await withTransaction(async (client) => {
        await ensureSettings(client, tenantId)
        await client.query(
          `UPDATE fee_settings SET due_days = $2, late_fine = $3, updated_at = NOW() WHERE tenant_id = $1`,
          [tenantId, Math.max(0, Math.round(num(body.dueDays)) || 0), Math.max(0, E.roundRupees(num(body.lateFine)))]
        )
      })
      const client = await pool.connect()
      try {
        const db = await loadDb(client, tenantId, req.user)
        res.json({ ...db.settings, branding: db.branding })
      } finally {
        client.release()
      }
    } catch (err) {
      sendError(res, err)
    }
  })

  /** The school logo, bank details and saved charges used on the printed challan. */
  router.put('/branding', auth, async (req, res) => {
    try {
      const tenantId = req.user.tenant_id
      const branding = (req.body && req.body.branding) || {}
      await withTransaction(async (client) => {
        await ensureSettings(client, tenantId)
        await client.query(
          'UPDATE fee_settings SET branding = $2::jsonb, updated_at = NOW() WHERE tenant_id = $1',
          [tenantId, JSON.stringify(branding)]
        )
      })
      res.json({ branding })
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}

module.exports = { createFeeRouter }
