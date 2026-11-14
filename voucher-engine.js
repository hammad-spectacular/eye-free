/* ==========================================================================
   voucher-engine.js
   --------------------------------------------------------------------------
   Fee arithmetic for the voucher generator, ported 1:1 from the source
   voucher project (lib/fees.ts + lib/ledger.ts) to plain JavaScript so it
   can run inside The Eye without a build step.

   Pure logic only: no DOM, no database. Everything the page shows is
   worked out here, so the printed challan, the collection screen and the
   stored records can never disagree about what is owed.

   Loads in the browser (window.VGEngine) and in Node (module.exports),
   which is what the unit checks use.
   ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VGEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Constants -----------------------------------------------------------

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const DEFAULT_DUE_DAYS = 10;
  const MAX_CHARGES = 20;
  const MAX_CHARGE_LABEL = 40;
  const MAX_ADVANCE_MONTHS = 12;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Thrown when an operation cannot go ahead (overpaid, no fee to advance, ...). */
  class Refused extends Error {
    constructor(message) {
      super(message);
      this.name = 'Refused';
    }
  }

  // --- Small helpers -------------------------------------------------------

  const num = (value) => (typeof value === 'number' && Number.isFinite(value)
    ? value
    : parseFloat(String(value)) || 0);

  const roundRupees = (value) => Math.round(value * 100) / 100;

  const rupees = (amount) => `Rs. ${num(amount).toLocaleString('en-US')}`;

  // --- Billing periods -----------------------------------------------------

  /** Orders vouchers by billing month: year x 12 + month index. */
  function periodOf(v) {
    return (parseInt(String(v.year)) || 0) * 12 + Math.max(0, MONTHS.indexOf(String(v.month)));
  }

  /** The billing month a period number stands for. */
  function monthOfPeriod(period) {
    return { month: MONTHS[period % 12], year: String(Math.floor(period / 12)) };
  }

  const currentPeriod = (now = new Date()) => now.getFullYear() * 12 + now.getMonth();

  /** Years to offer in year pickers: the last five and next year. */
  function yearOptions(now = new Date()) {
    const year = now.getFullYear();
    return Array.from({ length: 7 }, (_, i) => String(year - 5 + i));
  }

  /** "September 2026" */
  const periodLabel = (v) => `${v.month ?? ''} ${v.year ?? ''}`.trim();

  // --- Charges on top of the monthly fee -----------------------------------

  /** The well-formed charges in `value`, tidied; the rest dropped. */
  function cleanCharges(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((c) => ({
        label: typeof c?.label === 'string' ? c.label.trim().slice(0, MAX_CHARGE_LABEL) : '',
        amount: roundRupees(num(c?.amount)),
      }))
      .filter((c) => c.label && c.amount > 0)
      .slice(0, MAX_CHARGES);
  }

  /** Charges sent by a form: the list, or what is wrong with it. */
  function parseCharges(value) {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) return 'Charges must be a list';
    if (value.length > MAX_CHARGES) return `At most ${MAX_CHARGES} charges`;
    for (const c of value) {
      const label = typeof c?.label === 'string' ? c.label.trim() : '';
      const amount = typeof c?.amount === 'number' ? c.amount : parseFloat(String(c?.amount ?? ''));
      if (!label) return 'Every charge needs a name (e.g. Exam Fee)';
      if (label.length > MAX_CHARGE_LABEL) return `"${label}" is too long; keep charge names to ${MAX_CHARGE_LABEL} characters`;
      if (!Number.isFinite(amount) || amount <= 0) return `Enter an amount above zero for "${label}"`;
    }
    return cleanCharges(value);
  }

  const chargesTotal = (charges) => (charges ?? []).reduce((sum, c) => sum + num(c.amount), 0);

  /** The tuition part of a voucher: its fee before the discount, without the charges. */
  const tuitionOf = (v) => v.baseAmount ?? Math.max(0, num(v.amount) - chargesTotal(v.charges) + num(v.discount));

  /** What a new voucher bills the student for a month: fee less discount, plus monthly charges. */
  const monthlyBill = (student) =>
    Math.max(0, num(student.monthlyFee) - num(student.discount)) + chargesTotal(student.monthlyCharges);

  const classLabel = (cls, classId) => (cls ? `${cls.name}${cls.section ? ' - ' + cls.section : ''}` : `Class ${classId}`);

  // --- Vouchers ------------------------------------------------------------

  /** A new, unpaid voucher for one student and month. */
  function newVoucher(student, className, month, year, issued, dueDate) {
    const baseAmount = num(student.monthlyFee);
    const discount = num(student.discount);
    const charges = cleanCharges(student.monthlyCharges);
    return {
      studentId: student.id,
      studentName: student.name,
      fatherName: student.fatherName,
      admissionNumber: student.admissionNumber,
      className,
      classId: student.classId,
      month,
      year,
      amount: monthlyBill({ ...student, monthlyCharges: charges }),
      baseAmount,
      discount,
      charges,
      status: 'Unpaid',
      issueDate: issued.toISOString(),
      dueDate: dueDate.toISOString(),
      paymentDate: null,
      totalReceived: 0,
      paidTuition: 0,
      paidAC: 0,
    };
  }

  /** Due date of a voucher for `period` made ahead of time. */
  function advanceDueDate(period, dueDays, now = new Date()) {
    const start = new Date(Math.floor(period / 12), period % 12, 1);
    return new Date(Math.max(start.getTime(), now.getTime()) + dueDays * DAY_MS);
  }

  /** Marked paid before amounts were tracked per payment; nothing is owed on it. */
  function settledLegacy(v) {
    return v.status === 'Paid' && v.paidTuition == null;
  }

  /** The late fine a voucher owes: fixed once charged, pending while overdue. */
  function lateFineOf(v, lateFine, now = new Date()) {
    if (v.fineWaived) return 0;
    if (v.fineCharged) return v.fineCharged;
    if (!lateFine || !v.dueDate || v.isACOnly || settledLegacy(v)) return 0;
    if (num(v.paidTuition) >= num(v.amount)) return 0;
    return now.getTime() > new Date(v.dueDate).getTime() ? lateFine : 0;
  }

  /** Tuition (plus any late fine) still owed on this voucher alone. */
  function tuitionOwed(v, lateFine, now = new Date()) {
    if (v.isACOnly || settledLegacy(v)) return 0;
    return Math.max(0, num(v.amount) + lateFineOf(v, lateFine, now) - num(v.paidTuition));
  }

  /** Paid when this month's tuition and fine are covered. */
  function voucherStatus(v) {
    if (settledLegacy(v) || num(v.paidTuition) >= num(v.amount) + num(v.fineCharged)) return 'Paid';
    return num(v.paidTuition) + num(v.paidAC) > 0 ? 'Partially Paid' : 'Unpaid';
  }

  /** The student's vouchers billed before `v` that still have tuition owing, oldest first. */
  function arrearsFor(v, studentVouchers, lateFine, now = new Date()) {
    const period = periodOf(v);
    return studentVouchers
      .filter((other) => periodOf(other) < period && String(other.id) !== String(v.id))
      .sort((a, b) => periodOf(a) - periodOf(b))
      .map((other) => {
        const fine = other.fineCharged ? 0 : lateFineOf(other, lateFine, now);
        return {
          voucherId: other.id,
          month: other.month,
          year: String(other.year),
          amount: tuitionOwed(other, lateFine, now),
          ...(fine > 0 && { fine }),
        };
      })
      .filter((line) => line.amount > 0);
  }

  /** Adds what is owed right now to each voucher: arrears, late fine, annual charges, balance. */
  function withBalances(vouchers, allVouchers, students, settings, now = new Date()) {
    const byStudent = vouchersByStudent(allVouchers);

    return vouchers.map((v) => {
      const arrears = v.studentId == null ? [] : arrearsFor(v, byStudent.get(String(v.studentId)) ?? [], settings.lateFine, now);
      const previousArrears = arrears.reduce((sum, line) => sum + line.amount, 0);
      const student = v.studentId == null ? undefined : students.get(String(v.studentId));
      const remainingAnnualCharges = student
        ? Math.max(0, num(student.annualCharges) - num(student.paidAnnualCharges))
        : num(v.remainingAnnualCharges);
      return {
        ...v,
        arrears,
        previousArrears,
        remainingAnnualCharges,
        lateFine: lateFineOf(v, settings.lateFine, now),
        balanceDue: tuitionOwed(v, settings.lateFine, now) + previousArrears + remainingAnnualCharges,
        ...(student?.parentPhone && { parentPhone: student.parentPhone }),
      };
    });
  }

  /** Groups vouchers by student id. */
  function vouchersByStudent(vouchers) {
    const map = new Map();
    for (const v of vouchers) {
      if (v.studentId == null) continue;
      const list = map.get(String(v.studentId)) ?? [];
      list.push(v);
      map.set(String(v.studentId), list);
    }
    return map;
  }

  const isLeft = (student) => String(student.status ?? '').toLowerCase() === 'left';

  /** What one student owes, from all of their vouchers. */
  function studentDues(student, vouchers, lateFine, now = new Date()) {
    const sorted = [...vouchers].sort((a, b) => periodOf(a) - periodOf(b));
    const owed = (v) => tuitionOwed(v, lateFine, now);
    const isOverdue = (v) => !v.dueDate || new Date(v.dueDate).getTime() < now.getTime();
    const overdue = sorted.filter((v) => isOverdue(v) && owed(v) > 0);
    const tuitionNow = sorted.reduce((sum, v) => sum + owed(v), 0);
    const annualCharges = Math.max(0, num(student.annualCharges) - num(student.paidAnnualCharges));
    return {
      tuitionNow,
      annualCharges,
      totalNow: tuitionNow + annualCharges,
      overdue: {
        months: overdue.length,
        oldest: overdue[0] ? periodLabel(overdue[0]) : '',
        tuition: overdue.reduce((sum, v) => sum + owed(v), 0),
        fines: overdue.reduce((sum, v) => sum + lateFineOf(v, lateFine, now), 0),
      },
      lastPayment: sorted.map((v) => v.paymentDate).filter(Boolean).sort().pop() ?? null,
    };
  }

  // --- Amount in words -----------------------------------------------------

  /** Amount in words, Pakistani numbering (THOUSAND / LAKH). */
  function numberToWords(numValue) {
    const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
      'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
    const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
    if (numValue === 0) return 'ZERO';
    const n = Math.floor(numValue);
    // Pakistani scale: THOUSAND and LAKH (100,000).
    const convertPk = (v) => {
      if (v < 20) return ones[v];
      if (v < 100) return tens[Math.floor(v / 10)] + (v % 10 !== 0 ? ' ' + ones[v % 10] : '');
      if (v < 1000) return ones[Math.floor(v / 100)] + ' HUNDRED' + (v % 100 !== 0 ? ' AND ' + convertPk(v % 100) : '');
      if (v < 100000) return convertPk(Math.floor(v / 1000)) + ' THOUSAND' + (v % 1000 !== 0 ? ' ' + convertPk(v % 1000) : '');
      if (v < 10000000) return convertPk(Math.floor(v / 100000)) + ' LAKH' + (v % 100000 !== 0 ? ' ' + convertPk(v % 100000) : '');
      return v.toString();
    };
    return convertPk(n) + ' ONLY';
  }

  // ==========================================================================
   // Ledger: payments, receipts, reversals, charges
   // ==========================================================================

  const feeSettingsOf = (config) => ({
    dueDays: config.dueDays ?? DEFAULT_DUE_DAYS,
    lateFine: config.lateFine ?? 0,
  });

  const nextId = (db, name) => {
    db.counters[name] = (db.counters[name] ?? 0) + 1;
    return db.counters[name];
  };

  const findVoucher = (db, id) => db.fees.find((f) => String(f.id) === String(id)) ?? null;
  const findStudent = (db, id) => db.students.find((s) => String(s.id) === String(id)) ?? null;
  const findClass = (db, id) => db.classes.find((c) => String(c.id) === String(id)) ?? null;

  /** A voucher with nothing received on it yet. */
  const nothingReceived = (v) => num(v.paidTuition) <= 0 && num(v.paidAC) <= 0 && num(v.totalReceived) <= 0;

  /** Vouchers whose amounts were never tracked, or that only ever held annual charges. */
  const takesCharges = (v) => !v.isACOnly && !(v.status === 'Paid' && v.paidTuition == null);

  /**
   * Takes a payment against `voucherId`. Tuition clears the student's earlier unpaid months
   * first, oldest first, then this voucher, then later months already billed. Anything beyond
   * that is advance fee: with `input.advance`, vouchers for the coming months are made and paid
   * (up to MAX_ADVANCE_MONTHS); without it the payment is refused.
   *
   * The whole thing runs as one unit: if it is refused, nothing it touched stays changed.
   */
  function receivePayment(db, voucherId, input, session) {
    const snapshot = snapshotDb(db);
    try {
      return receivePaymentInner(db, voucherId, input, session);
    } catch (err) {
      restoreDb(db, snapshot);
      throw err;
    }
  }

  /** The records a payment can change, kept so a refused payment can be rolled back. */
  function snapshotDb(db) {
    return JSON.stringify({
      fees: db.fees,
      payments: db.payments,
      students: db.students,
      counters: db.counters,
    });
  }

  function restoreDb(db, snapshot) {
    const saved = JSON.parse(snapshot);
    db.fees = saved.fees;
    db.payments = saved.payments;
    db.students = saved.students;
    db.counters = saved.counters;
  }

  function receivePaymentInner(db, voucherId, input, session) {
    const target = findVoucher(db, voucherId);
    if (!target) return null;

    const { lateFine, dueDays } = db.settings;
    const now = new Date();
    const receivedAt = now.toISOString();

    const others = target.studentId == null
      ? []
      : db.fees.filter((v) => v.studentId === target.studentId && String(v.id) !== String(target.id));
    const unpaid = others.filter((v) => v.status !== 'Paid');
    const byId = new Map(unpaid.map((v) => [String(v.id), v]));

    /** Fixes the overdue fine on a voucher about to receive money, or waives it. */
    const settleFine = (v) => {
      const fine = lateFineOf(v, lateFine, now);
      if (!fine || v.fineCharged) return {};
      if (input.waiveFine) {
        v.fineWaived = true;
        return { fineWaived: fine };
      }
      v.fineCharged = fine;
      return { fineCharged: fine };
    };

    let remaining = num(input.paidTuition);
    const allocations = [];

    /** Puts as much of what's left as `v` still owes on it. */
    const payOn = (v, extra = {}) => {
      const fine = settleFine(v);
      const applied = Math.min(remaining, tuitionOwed(v, lateFine, now));
      if (applied <= 0) return;
      remaining = roundRupees(remaining - applied);
      v.paidTuition = num(v.paidTuition) + applied;
      v.totalReceived = num(v.totalReceived) + applied;
      v.paymentDate = receivedAt;
      allocations.push({ voucherId: v.id, month: v.month, year: String(v.year), amount: applied, ...fine, ...extra });
    };

    // 1. Earlier unpaid months, oldest first.
    for (const line of arrearsFor(target, unpaid, lateFine, now)) {
      if (remaining <= 0) break;
      const older = byId.get(String(line.voucherId));
      if (older) payOn(older);
    }

    // 2. This voucher.
    const fine = remaining > 0 ? settleFine(target) : {};
    const applied = Math.min(remaining, tuitionOwed(target, lateFine, now));
    if (applied > 0 || num(input.paidAC) > 0) {
      remaining = roundRupees(remaining - applied);
      if (applied > 0) {
        target.paidTuition = num(target.paidTuition) + applied;
        target.totalReceived = num(target.totalReceived) + applied;
      }
      target.paidAC = num(target.paidAC) + num(input.paidAC);
      target.paymentDate = receivedAt;
      allocations.push({ voucherId: target.id, month: target.month, year: String(target.year), amount: applied, ...fine });
    }

    // 3. Later months already billed.
    const later = unpaid.filter((v) => periodOf(v) > periodOf(target)).sort((a, b) => periodOf(a) - periodOf(b));
    for (const v of later) {
      if (remaining <= 0) break;
      payOn(v);
    }

    // 4. Anything left is advance fee for the coming months.
    if (remaining > 0) {
      if (!input.advance) {
        throw new Refused(`${rupees(remaining)} is more than everything owed. To keep it as advance fee for the coming months, tick "advance fee".`);
      }
      const student = target.studentId == null ? null : findStudent(db, target.studentId);
      if (!student) throw new Refused('This voucher has no student record, so no advance fee can be taken on it.');
      if (isLeft(student)) throw new Refused(`${student.name} has left the school, so no advance fee can be taken.`);
      const billed = input.monthlyCharges ? student : { ...student, monthlyCharges: [] };
      if (monthlyBill(billed) <= 0) throw new Refused(`${student.name} has no monthly fee to pay ahead.`);
      const cls = student.classId == null ? null : findClass(db, student.classId);
      const className = classLabel(cls ?? undefined, student.classId);

      let period = Math.max(periodOf(target), ...others.map(periodOf));
      for (let months = 0; remaining > 0; months++) {
        if (months === MAX_ADVANCE_MONTHS) throw new Refused(`That is more than ${MAX_ADVANCE_MONTHS} months of fees in advance.`);
        period += 1;
        const { month, year } = monthOfPeriod(period);
        const made = insertIfNew(db, newVoucher(billed, className, month, year, now, advanceDueDate(period, dueDays, now)));
        if (made) payOn(made, { created: true });
      }
    }

    if (num(input.paidAC) > 0) {
      const student = target.studentId == null ? null : findStudent(db, target.studentId);
      if (student) student.paidAnnualCharges = num(student.paidAnnualCharges) + num(input.paidAC);
    }

    const receipt = {
      id: nextId(db, 'payment'),
      voucherId: target.id,
      studentId: target.studentId,
      studentName: target.studentName,
      className: target.className,
      month: target.month,
      year: target.year,
      paidTuition: num(input.paidTuition),
      paidAC: num(input.paidAC),
      amount: num(input.paidTuition) + num(input.paidAC),
      receivedAt,
      receivedBy: session.username,
      receivedByName: session.displayName,
      allocations,
      reversedAt: null,
      reversedBy: null,
    };
    db.payments.push(receipt);

    return { receipt, voucher: target };
  }

  /** Adds a voucher unless the student already has one for that month. */
  function insertIfNew(db, voucher) {
    const existing = db.fees.find(
      (f) => f.studentId === voucher.studentId && String(f.year) === String(voucher.year) && f.month === voucher.month
    );
    if (existing) return null;
    const row = { ...voucher, id: nextId(db, 'voucher') };
    db.fees.push(row);
    return row;
  }

  /** Marks a receipt reversed and takes its money back off the vouchers and the student. */
  function undoReceipt(db, receiptId, keep) {
    const receipt = db.payments.find((p) => String(p.id) === String(receiptId) && !p.reversedAt);
    if (!receipt) return null;

    receipt.reversedAt = new Date().toISOString();
    receipt.reversedBy = 'demo';

    const allocations = receipt.allocations ?? [{ voucherId: receipt.voucherId, amount: receipt.paidTuition }];
    for (const line of allocations) {
      const v = findVoucher(db, line.voucherId);
      if (!v) continue;
      if (num(line.amount) > 0) {
        v.paidTuition = Math.max(0, num(v.paidTuition) - num(line.amount));
        v.totalReceived = Math.max(0, num(v.totalReceived) - num(line.amount));
      }
      if (String(line.voucherId) === String(receipt.voucherId) && receipt.paidAC > 0) {
        v.paidAC = Math.max(0, num(v.paidAC) - receipt.paidAC);
      }
      if (line.fineCharged) v.fineCharged = undefined;
      if (line.fineWaived) v.fineWaived = false;
      if (line.created && v.id !== keep && periodOf(v) > currentPeriod() && nothingReceived(v)) {
        db.fees = db.fees.filter((x) => String(x.id) !== String(v.id));
      }
    }

    if (receipt.paidAC > 0) {
      const student = findStudent(db, receipt.studentId);
      if (student) student.paidAnnualCharges = Math.max(0, num(student.paidAnnualCharges) - receipt.paidAC);
    }
    return receipt;
  }

  /** Undoes a receipt: money comes off every voucher it reached, fines are released. */
  function reverseReceipt(db, receiptId) {
    return undoReceipt(db, receiptId);
  }

  /**
   * Deletes a voucher that has money on it: every receipt that touched it is reversed in full,
   * then the voucher goes.
   */
  function reverseVoucher(db, voucherId) {
    const voucher = findVoucher(db, voucherId);
    if (!voucher) return null;

    const receipts = db.payments
      .filter((p) => !p.reversedAt && (String(p.voucherId) === String(voucherId)
        || (p.allocations ?? []).some((a) => String(a.voucherId) === String(voucherId))))
      .sort((a, b) => a.id - b.id);

    let takenBack = 0;
    for (const receipt of receipts) {
      const undone = undoReceipt(db, receipt.id, voucher.id);
      if (undone) takenBack += num(undone.amount);
    }

    db.fees = db.fees.filter((f) => String(f.id) !== String(voucherId));
    takenBack += num(voucher.totalReceived);
    if (num(voucher.paidAC) > 0) {
      const student = findStudent(db, voucher.studentId);
      if (student) student.paidAnnualCharges = Math.max(0, num(student.paidAnnualCharges) - num(voucher.paidAC));
    }
    return { voucher, takenBack, receipts: receipts.length };
  }

  /** Saves new charges on a voucher; its amount and status follow. */
  function applyCharges(db, v, charges, now = new Date()) {
    const amount = roundRupees(Math.max(0, num(v.amount) - chargesTotal(v.charges)) + chargesTotal(charges));
    if (amount + num(v.fineCharged) < num(v.paidTuition)) {
      throw new Refused(
        `${rupees(v.paidTuition)} has already been paid on voucher #${v.id}, more than it would bill. Reverse that receipt first.`
      );
    }
    const owedAgain = voucherStatus(v) === 'Paid' && amount > num(v.amount);
    const overdue = v.dueDate && new Date(v.dueDate).getTime() < now.getTime();
    const changes = {
      charges,
      amount,
      status: voucherStatus({ ...v, amount }),
      ...(owedAgain && overdue && { dueDate: new Date(now.getTime() + db.settings.dueDays * DAY_MS).toISOString() }),
    };
    Object.assign(v, changes);
    return v;
  }

  /** Replaces the charges on one voucher. */
  function setVoucherCharges(db, voucherId, charges) {
    const v = findVoucher(db, voucherId);
    if (!v) return null;
    if (!takesCharges(v)) throw new Refused(`Voucher #${v.id} is from before amounts were tracked and can't take charges.`);
    const before = v.charges ?? [];
    applyCharges(db, v, cleanCharges(charges));
    return { voucher: v, before };
  }

  /**
   * Adds one charge (an exam fee for a whole class, say) to each of these vouchers. A voucher that
   * already has a charge by that name is skipped, so doing it twice doesn't bill twice.
   */
  function addChargeToVouchers(db, voucherIds, charge) {
    const ids = [...new Set(voucherIds.map((id) => String(id)))];
    if (ids.length === 0) return { added: [], skipped: 0 };
    const sameName = (c) => c.label.toLowerCase() === charge.label.toLowerCase();
    const added = [];
    for (const id of ids) {
      const v = findVoucher(db, id);
      if (!v) continue;
      const charges = v.charges ?? [];
      if (!takesCharges(v) || charges.some(sameName) || charges.length >= MAX_CHARGES) continue;
      applyCharges(db, v, [...charges, charge]);
      added.push(v);
    }
    return { added, skipped: ids.length - added.length };
  }

  return {
    MONTHS,
    DEFAULT_DUE_DAYS,
    MAX_CHARGES,
    MAX_ADVANCE_MONTHS,
    Refused,
    num,
    roundRupees,
    rupees,
    periodOf,
    monthOfPeriod,
    currentPeriod,
    yearOptions,
    periodLabel,
    cleanCharges,
    parseCharges,
    chargesTotal,
    tuitionOf,
    monthlyBill,
    classLabel,
    newVoucher,
    advanceDueDate,
    settledLegacy,
    lateFineOf,
    tuitionOwed,
    voucherStatus,
    arrearsFor,
    withBalances,
    vouchersByStudent,
    isLeft,
    studentDues,
    numberToWords,
    feeSettingsOf,
    receivePayment,
    reverseReceipt,
    reverseVoucher,
    setVoucherCharges,
    addChargeToVouchers,
    insertIfNew,
  };
});
