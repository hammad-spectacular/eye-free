/* ==========================================================================
   voucher-demo-api.js
   --------------------------------------------------------------------------
   A stand-in for the server side of the voucher generator, so the page can
   be run and reviewed on its own before it is wired into The Eye.

   It behaves like the real API does: the same filters, the same rules about
   who gets billed, the same refusals. Data lives in this browser's
   localStorage, so vouchers, receipts and reversals survive a refresh.

   When this feature is integrated, this file is deleted and the page is
   pointed at the real /api/fees endpoints instead. The page only talks to
   the small API object below, so nothing else changes.
   ========================================================================== */

(function (root) {
  'use strict';

  const E = root.VGEngine;
  const STORAGE_KEY = 'theeye.vg.demo.v1';

  // --- Demo school data ----------------------------------------------------

  const CLASS_SEED = [
    { id: 1, name: 'Nursery', section: '', monthlyFee: 2500, annualCharges: 1500 },
    { id: 2, name: 'Prep', section: '', monthlyFee: 2800, annualCharges: 1500 },
    { id: 3, name: 'Class 1', section: 'A', monthlyFee: 3200, annualCharges: 2000 },
    { id: 4, name: 'Class 1', section: 'B', monthlyFee: 3200, annualCharges: 2000 },
    { id: 5, name: 'Class 3', section: 'A', monthlyFee: 3600, annualCharges: 2000 },
    { id: 6, name: 'Class 5', section: 'A', monthlyFee: 4200, annualCharges: 2500 },
    { id: 7, name: 'Class 7', section: 'A', monthlyFee: 4800, annualCharges: 2500 },
    { id: 8, name: 'Class 9', section: 'A', monthlyFee: 5500, annualCharges: 3000 },
  ];

  const STUDENT_SEED = [
    ['Ayesha Khan', 'Muhammad Khan', '1', 0, 0, '0300-1234501'],
    ['Abdullah Sheikh', 'Ali Sheikh', '1', 200, 0, '0300-1234502'],
    ['Hira Ali', 'Kamran Ali', '2', 0, 0, '0300-1234503'],
    ['Zain Abbas', 'Usman Abbas', '2', 0, 500, '0301-2234504'],
    ['Bilal Ahmed', 'Nadeem Ahmed', '3', 0, 0, '0301-2234505'],
    ['Maryam Noor', 'Aslam Noor', '3', 300, 0, '0301-2234506'],
    ['Hamza Yousaf', 'Tariq Yousaf', '3', 0, 700, '0302-3234507'],
    ['Sana Malik', 'Faisal Malik', '4', 0, 0, '0302-3234508'],
    ['Ahmed Raza', 'Imran Raza', '4', 0, 0, '0302-3234509'],
    ['Fatima Iqbal', 'Zafar Iqbal', '5', 250, 0, '0303-4234510'],
    ['Usman Siddiqui', 'Naveed Siddiqui', '5', 0, 0, '0303-4234511'],
    ['Noor Fatima', 'Shahid Mehmood', '5', 0, 0, '0303-4234512'],
    ['Ali Hamza', 'Javed Hamza', '6', 0, 0, '0304-5234513'],
    ['Maham Rana', 'Waqar Rana', '6', 0, 400, '0304-5234514'],
    ['Ehsan Baig', 'Kashif Baig', '6', 0, 0, '0304-5234515'],
    ['Iqra Aslam', 'Shahzad Aslam', '7', 350, 0, '0305-6234516'],
    ['Yusuf Nadeem', 'Salman Nadeem', '7', 0, 0, '0305-6234517'],
    ['Komal Shah', 'Aamir Shah', '7', 0, 0, '0305-6234518'],
    ['Ahmed Raza Khan', 'Imran Raza Khan', '8', 0, 0, '0306-7234519'],
    ['Rida Fatima', 'Salman Fatima', '8', 0, 600, '0306-7234520'],
    ['Zainab Ali', 'Khaled Ali', '8', 0, 0, '0306-7234521'],
    ['Talha Javed', 'Mehmood Javed', '8', 0, 0, '0306-7234522'],
    ['Sadia Iqbal', 'Farooq Iqbal', '3', 0, 0, '0301-2234523'],
    ['Haroon Aslam', 'Nadeem Aslam', '4', 0, 0, '0302-3234524'],
    ['Maryam Nawaz', 'Rashid Nawaz', '6', 0, 0, '0304-5234525'],
    ['Areeba Sultan', 'Naveed Sultan', '7', 0, 0, '0305-6234526'],
  ];

  const TRANSPORT = [{ label: 'Transport Fee', amount: 800 }];
  const TRANSPORT_LATE = [{ label: 'Transport Fee', amount: 1000 }];

  function seedState() {
    const classes = CLASS_SEED.map((c) => ({ ...c }));

    const students = STUDENT_SEED.map((row, index) => {
      const [name, fatherName, classKey, discount, annualDiscount, phone] = row;
      const cls = classes.find((c) => String(c.id) === classKey);
      const monthlyFee = cls ? cls.monthlyFee : 3000;
      const annualCharges = cls ? cls.annualCharges : 0;
      return {
        id: index + 1,
        name,
        fatherName,
        admissionNumber: `EYE-${String(1000 + index + 1)}`,
        classId: cls ? cls.id : 1,
        monthlyFee,
        discount,
        annualCharges: Math.max(0, annualCharges - annualDiscount),
        paidAnnualCharges: 0,
        monthlyCharges: index % 5 === 0 ? TRANSPORT : index % 7 === 0 ? TRANSPORT_LATE : [],
        parentPhone: phone,
        status: 'Active',
      };
    });

    // One student who left, to show the rule that leavers are not billed.
    students.push({
      id: students.length + 1,
      name: 'Zeeshan Tariq (left)',
      fatherName: 'Tariq Mehmood',
      admissionNumber: 'EYE-1000',
      classId: 5,
      monthlyFee: 3600,
      discount: 0,
      annualCharges: 2000,
      paidAnnualCharges: 0,
      monthlyCharges: [],
      parentPhone: '0300-9999999',
      status: 'Left',
      leftAt: '2026-06-30',
    });

    return {
      settings: { dueDays: 10, lateFine: 500 },
      classes,
      students,
      fees: [],
      payments: [],
      counters: { voucher: 0, payment: 0 },
    };
  }

  // --- Persistence ---------------------------------------------------------

  let state = null;

  function load() {
    if (state) return state;
    try {
      const raw = root.localStorage?.getItem(STORAGE_KEY);
      if (raw) {
        state = JSON.parse(raw);
        // Settings may be missing after an upgrade of the demo data.
        state.settings = { dueDays: 10, lateFine: 500, ...(state.settings ?? {}) };
        state.counters = { voucher: 0, payment: 0, ...(state.counters ?? {}) };
        return state;
      }
    } catch (err) {
      console.warn('Demo state could not be read; starting fresh.', err);
    }
    state = seedState();
    save();
    return state;
  }

  function save() {
    try {
      root.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn('Demo state could not be saved.', err);
    }
  }

  function reset() {
    state = seedState();
    save();
    return state;
  }

  // --- Helpers -------------------------------------------------------------

  const studentsById = () => new Map(load().students.map((s) => [String(s.id), s]));
  const classesById = () => new Map(load().classes.map((c) => [String(c.id), c]));

  /** Vouchers with arrears, fines and balances worked out fresh. */
  function decorate(vouchers) {
    const db = load();
    return E.withBalances(vouchers, db.fees, studentsById(), db.settings);
  }

  function findVoucher(id) {
    return load().fees.find((f) => String(f.id) === String(id)) ?? null;
  }

  // --- The API the page uses ----------------------------------------------

  const api = {
    /** Fee settings for the whole school: due days and late fine. */
    settings() {
      return { ...load().settings };
    },

    saveSettings(next) {
      const db = load();
      db.settings = {
        dueDays: Math.max(0, Math.round(E.num(next.dueDays) || 0)),
        lateFine: Math.max(0, E.roundRupees(E.num(next.lateFine) || 0)),
      };
      save();
      return api.settings();
    },

    classes() {
      return load().classes.map((c) => ({ ...c }));
    },

    students() {
      return load().students.map((s) => ({ ...s }));
    },

    /**
     * Vouchers, filtered like the real API: month, year, class, status and a text search
     * over the student name, father name, admission number or voucher number.
     */
    listFees({ month, year, classId, status, search, limit = 10000 } = {}) {
      const db = load();
      let fees = db.fees.map((f) => {
        // Older vouchers only store the studentId; fill in the details for display.
        const student = !f.studentName && f.studentId ? studentsById().get(String(f.studentId)) : undefined;
        if (!student) return f;
        return {
          ...f,
          studentName: student.name,
          fatherName: student.fatherName,
          admissionNumber: student.admissionNumber,
          className: E.classLabel(classesById().get(String(student.classId)), student.classId),
          classId: student.classId,
        };
      });

      if (classId && classId !== 'all') fees = fees.filter((f) => String(f.classId) === String(classId));
      if (status && status !== 'all') fees = fees.filter((f) => f.status === status);
      if (month && month !== 'all') fees = fees.filter((f) => f.month === month);
      if (year && year !== 'all') fees = fees.filter((f) => String(f.year) === String(year));
      if (search) {
        const q = String(search).toLowerCase();
        fees = fees.filter(
          (f) => [f.studentName, f.fatherName, f.admissionNumber].some((v) => String(v ?? '').toLowerCase().includes(q))
            || String(f.id).toLowerCase() === q
        );
      }

      return decorate(fees.slice(0, limit));
    },

    /**
     * Generates the month's vouchers for one class or for everyone. Students already billed for
     * that month and students who have left are skipped.
     */
    generateFees({ month, year, classId, studentIds } = {}) {
      const db = load();
      const m = month || 'Unknown';
      const y = year || String(new Date().getFullYear());
      const existing = db.fees.filter((f) => f.month === m && String(f.year) === String(y));
      const alreadyBilled = new Set(existing.map((f) => String(f.studentId)));

      let targets = db.students.filter((s) => !E.isLeft(s));
      if (Array.isArray(studentIds) && studentIds.length) {
        targets = targets.filter((s) => studentIds.some((rid) => String(rid) === String(s.id)));
      } else if (classId && classId !== 'all') {
        targets = targets.filter((s) => String(s.classId) === String(classId));
      }

      const issued = new Date();
      const dueDate = new Date(issued.getTime() + db.settings.dueDays * 24 * 60 * 60 * 1000);
      const classes = classesById();

      let count = 0;
      for (const student of targets) {
        if (alreadyBilled.has(String(student.id))) continue;
        const voucher = E.newVoucher(
          student,
          E.classLabel(classes.get(String(student.classId)), student.classId),
          m,
          y,
          issued,
          dueDate
        );
        E.insertIfNew(db, voucher);
        count++;
      }
      save();
      return { count, month: m, year: y };
    },

    /** Replaces the charges on one voucher. */
    setCharges(voucherId, charges) {
      const db = load();
      const parsed = E.parseCharges(charges);
      if (typeof parsed === 'string') throw new E.Refused(parsed);
      const result = E.setVoucherCharges(db, voucherId, parsed);
      save();
      return result;
    },

    /** Adds one charge to many vouchers at once (an exam fee for a whole class, say). */
    addCharge(voucherIds, charge) {
      const db = load();
      const parsed = E.parseCharges([charge]);
      if (typeof parsed === 'string') throw new E.Refused(parsed);
      const result = E.addChargeToVouchers(db, voucherIds, parsed[0]);
      save();
      return { added: result.added.length, skipped: result.skipped };
    },

    /** Deletes a voucher and takes back every receipt that touched it. */
    reverseVoucher(voucherId) {
      const db = load();
      const result = E.reverseVoucher(db, voucherId);
      save();
      return result;
    },

    /** Takes a payment and issues the receipt for it. */
    receivePayment(voucherId, input) {
      const db = load();
      const session = { username: 'demo.admin', displayName: 'Demo Admin' };
      const result = E.receivePayment(db, voucherId, {
        paidTuition: E.num(input.paidTuition),
        paidAC: E.num(input.paidAC),
        waiveFine: !!input.waiveFine,
        advance: !!input.advance,
        monthlyCharges: input.monthlyCharges !== false,
      }, session);
      save();
      return result;
    },

    /** Receipts, newest first. */
    payments() {
      return [...load().payments].sort((a, b) => b.id - a.id).map((p) => ({ ...p }));
    },

    /** Wipes the demo data and starts again. */
    reset,

    /** Only for the demo: wipes the saved state too. */
    hardReset() {
      state = null;
      try {
        root.localStorage?.removeItem(STORAGE_KEY);
      } catch (err) { /* ignore */ }
      return reset();
    },
  };

  root.VGDemoApi = api;
})(typeof self !== 'undefined' ? self : this);
