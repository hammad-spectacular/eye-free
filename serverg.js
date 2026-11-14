const express = require('express')
const cors = require('cors')
const pool = require('./db')
const path = require('path')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')
const crypto = require('crypto')
const nodemailer = require('nodemailer')
const rateLimit = require('express-rate-limit')
require('dotenv').config()
const { requireAuth, setPool, isCoordinator, branchFilter, requireWritableBranch } = require('./authMiddleware')
const { createFileStore } = require('./timetable/tt2/store')
const { createPgTt2Store } = require('./timetable/tt2/store.pg.tt2')
const { createTt2Router } = require('./timetable/tt2/routes')
const { createFinanceRouter } = require('./finance-routes')
const { createFeeRouter } = require('./fee-routes')

const app = express()
app.set('trust proxy', 1)
const JWT_SECRET = process.env.JWT_SECRET
console.log('JWT_SECRET loaded:', JWT_SECRET ? 'YES' : 'MISSING')
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Set it in Railway environment variables.')
  process.exit(1)
}
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12')
const JWT_EXPIRY = '8h'

// Inject pool into auth middleware so it can verify token_generation
setPool(pool)

// ============================================
// NODEMAILER SETUP
// ============================================
let mailTransporter = null
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: (process.env.SMTP_PORT || '587') === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  })
  console.log('Nodemailer transporter configured with SMTP_HOST:', process.env.SMTP_HOST)
} else {
  console.warn('SMTP not configured — email recovery is unavailable until SMTP is configured')
}

const APP_URL = process.env.APP_URL || 'http://localhost:3000'
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@theeye.app'
const RESET_TOKEN_EXPIRY_MINUTES = 30
const DEFAULT_STUDENT_LIMIT = Math.max(1, Number.parseInt(process.env.DEFAULT_STUDENT_LIMIT, 10) || 500)
const DEFAULT_TEACHER_LIMIT = Math.max(1, Number.parseInt(process.env.DEFAULT_TEACHER_LIMIT, 10) || 50)

// ============================================
// RATE LIMITER — forgot-password
// ============================================
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 requests per IP per window
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
})

const adminRecoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many recovery requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
})

const bulkCreateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Too many bulk-create requests. Maximum 5 per minute.' },
  standardHeaders: true,
  legacyHeaders: false
})

const ACCOUNT_TABLES = {
  admin: 'admins',
  super_admin: 'admins',
  teacher: 'teachers',
  student: 'students'
}

function tableForRole(role) {
  return ACCOUNT_TABLES[role] || null
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!email) return null
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined
  return email
}

// Is a portal switched on for this school?
// An explicit grant row always wins. With no row we fall back to the catalogue default,
// so a brand new school is usable immediately. If the feature is missing from the
// catalogue entirely we fail OPEN (allow) rather than locking a real school out over a
// data problem - a broken catalogue must never become "nobody can log in".
const PORTAL_FEATURE_FOR_ROLE = { student: 'student_portal', teacher: 'teacher_portal', coordinator: 'coordinator_portal' }

async function isPortalEnabled(tenantId, role) {
  const featureKey = PORTAL_FEATURE_FOR_ROLE[role]
  if (!featureKey) return true
  try {
    const r = await pool.query(
      `SELECT COALESCE(g.enabled, f.default_enabled) AS enabled
       FROM tenant_features f
       LEFT JOIN tenant_grants g ON g.feature_key = f.key AND g.school_id = $1
       WHERE f.key = $2`,
      [tenantId, featureKey]
    )
    if (r.rows.length === 0) return true
    return r.rows[0].enabled === true
  } catch (err) {
    console.error('Portal feature lookup failed:', err.message)
    return true
  }
}

function generateTempPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const specials = '!@#$%^&*'
  const pick = source => source[crypto.randomInt(source.length)]
  const password = Array.from({ length: 14 }, () => pick(chars)).concat(pick(specials))
  for (let index = password.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1)
    ;[password[index], password[swapIndex]] = [password[swapIndex], password[index]]
  }
  return password.join('')
}

// Haversine formula to calculate distance between two coordinates in meters
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000 // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
           Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
           Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/**
 * A school that has not been granted a portal must not be handed portal logins.
 * We still create the person and reserve their stable login_id, but leave
 * password_hash NULL and never return a plaintext password. The existing
 * issue-credentials endpoint picks up exactly these rows (login_id IS NULL OR
 * password_hash IS NULL) once the Super Admin switches the portal on.
 *
 * So: no portal -> no credentials to leak, copy, or hand out. Portal granted ->
 * the school admin's normal "Get credentials" flow fills the gap.
 */
async function mintCredentialIfPortalEnabled(tenantId, role) {
  if (await isPortalEnabled(tenantId, role)) {
    const tempPassword = generateTempPassword()
    return { tempPassword, passwordHash: await bcrypt.hash(tempPassword, BCRYPT_ROUNDS) }
  }
  return { tempPassword: null, passwordHash: null }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

// Human-readable error messages
function handleApiError(err, req) {
  const message = err.message || ''
  const user = req.user || {}
  
  // Log detailed error for debugging
  console.error(`API Error [${req.method} ${req.path}]:`, {
    user_id: user.user_id,
    tenant_id: user.tenant_id,
    role: user.role,
    error: message,
    code: err.code
  })
  
  // Map known errors to human-readable messages
  if (message.includes('violates foreign key constraint') || message.includes('qr_attendance_sessions_tenant_id_fkey')) {
    return { error: 'We could not find your school. Please log in again.', code: 'SCHOOL_NOT_FOUND' }
  }
  if (message.includes('invalid token') || message.includes('jwt') || message.includes('Unauthorized')) {
    return { error: 'Your session ended. Please log in again.', code: 'SESSION_EXPIRED' }
  }
  if (message.includes('Code expired') || message.includes('already marked today')) {
    return { error: message, code: 'ATTENDANCE_ERROR' }
  }
  if (message.includes('Location is required')) {
    return { error: 'Location is required to mark attendance.', code: 'LOCATION_REQUIRED' }
  }
  if (message.includes('too far')) {
    return { error: 'You are too far from school.', code: 'TOO_FAR' }
  }
  
  // Generic message for unknown errors
  return { error: 'Something went wrong. Please try again.', code: 'UNKNOWN_ERROR' }
}

function parsePositiveLimit(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

async function fetchCapacity(q, tenantId) {
  const result = await q.query(
    `SELECT student_limit, teacher_limit,
            (SELECT COUNT(*) FROM students WHERE tenant_id = o.school_code) AS student_count,
            (SELECT COUNT(*) FROM teachers WHERE tenant_id = o.school_code) AS teacher_count
     FROM organizations o WHERE o.school_code = $1`,
    [tenantId]
  )
  return result.rows[0] || null
}

// Amount to be collected for one month, derived from a fee structure.
// admission_fee is deliberately excluded: it is a one-time charge, so adding it
// to every month would re-bill it. Never returns a negative amount.
function monthlyAmountDue(fs) {
  if (!fs) return 0
  const monthly   = Number(fs.monthly_fee)   || 0
  const transport = Number(fs.transport_fee) || 0
  const discount  = Number(fs.discount)      || 0
  return Math.max(0, monthly + transport - discount)
}

// The school's calendar day, as YYYY-MM-DD.
//
// Attendance used to be dated by the browser, so a device in a timezone behind
// UTC filed the day's attendance under the previous date. A row created at
// 08:46 PKT landed on the 25th instead of the 26th, and because the portal
// simply shows the most recent record, it looked like the portal was a day
// behind. The school timezone is the single source of truth for "today" now.
// Keep in sync with SCHOOL_TIMEZONE in the public pages.
const SCHOOL_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Karachi'
function schoolToday(date = new Date()) {
  // 'en-CA' formats as YYYY-MM-DD, unlike toLocaleDateString whose order varies.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHOOL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

// Rejects a roll number or full name that is already used by another student in
// the same school. excludeId lets the edit paths ignore the student being edited.
// Returns an error string, or null when the values are acceptable.
async function findStudentDuplicate(q, tenantId, { roll_no, name }, excludeId = null) {
  if (roll_no !== undefined && roll_no !== null && String(roll_no).trim()) {
    const dupeRoll = await q.query(
      `SELECT id, name FROM students
       WHERE tenant_id = $1
         AND lower(btrim(roll_no)) = lower(btrim($2))
         AND ($3::int IS NULL OR id <> $3::int)
       LIMIT 1`,
      [tenantId, String(roll_no).trim(), excludeId]
    )
    if (dupeRoll.rows.length) {
      return `Roll number "${String(roll_no).trim()}" is already used by another student in this school. Please choose a different one.`
    }
  }

  if (name !== undefined && name !== null && String(name).trim()) {
    const dupeName = await q.query(
      `SELECT id, roll_no FROM students
       WHERE tenant_id = $1
         AND lower(btrim(regexp_replace(name, '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace($2, '\\s+', ' ', 'g')))
         AND ($3::int IS NULL OR id <> $3::int)
       LIMIT 1`,
      [tenantId, String(name).trim(), excludeId]
    )
    if (dupeName.rows.length) {
      return `A student named "${String(name).trim()}" already exists in this school. Names must be unique.`
    }
  }

  return null
}

async function capacityViolation(q, tenantId, type, batchSize = 1) {
  const cap = await fetchCapacity(q, tenantId)
  if (!cap) return null
  const isStudent = type === 'student'
  // Students are a soft, exceedable ceiling. A school may grow past its plan, and
  // is told about it through capacityNotice() instead of being blocked. This is
  // deliberate: the school-wide student limit is guidance, not a wall. Teachers
  // remain a hard limit.
  if (isStudent) return null
  const limit = Number(cap[isStudent ? 'student_limit' : 'teacher_limit'])
  const current = Number(cap[isStudent ? 'student_count' : 'teacher_count'])
  const needing = Math.max(1, Math.floor(Number(batchSize) || 1))
  if (current + needing <= limit) return null
  const label = isStudent ? 'Student' : 'Teacher'
  if (needing === 1) return `${label} capacity reached (${limit}). Contact Super Admin to increase your capacity.`
  return `Not enough ${label.toLowerCase()} capacity: ${current} / ${limit} used, and this batch of ${needing} would exceed the limit. Contact Super Admin to increase your capacity.`
}

// Capacity is a hard limit, but we nudge the school before they hit it. The soft
// threshold is 80% of the limit, so a 500-student school is warned at 400 and a
// 50-teacher school at 40. One rule, whatever the size of the school.
const CAPACITY_SOFT_RATIO = 0.8

// Returns a warning string once usage crosses the soft threshold, else null.
// This never blocks anything - capacityViolation() owns the hard limit.
async function capacityNotice(q, tenantId, type) {
  const cap = await fetchCapacity(q, tenantId)
  if (!cap) return null
  const isStudent = type === 'student'
  const limit = Number(cap[isStudent ? 'student_limit' : 'teacher_limit'])
  const current = Number(cap[isStudent ? 'student_count' : 'teacher_count'])
  if (!Number.isFinite(limit) || limit <= 0) return null
  if (current < limit * CAPACITY_SOFT_RATIO) return null
  const label = isStudent ? 'students' : 'teachers'
  if (current >= limit) {
    return `You are using ${current} of ${limit} ${label}. Upgrade your plan for more space.`
  }
  return `You are using ${current} of ${limit} ${label}. Upgrade your plan for more space.`
}

// How many branches a school has. Drives the UI rule the school agreed to:
// no branches means branch_id stays NULL and the field is hidden; one or more
// means a branch must be chosen when creating a student or teacher.
async function tenantHasBranches(q, tenantId) {
  const r = await q.query('SELECT 1 FROM branches WHERE school_id = $1 LIMIT 1', [tenantId])
  return r.rows.length > 0
}

// Validates a branch chosen for a write. Returns { error } or { branch }.
async function resolveBranchForWrite(q, tenantId, branchId) {
  const hasBranches = await tenantHasBranches(q, tenantId)
  if (branchId === undefined || branchId === null || branchId === '') {
    if (!hasBranches) return { branch: null }   // school-wide is valid
    return { error: 'Please choose a branch.' }
  }
  const id = Number(branchId)
  if (!Number.isInteger(id)) return { error: 'Please choose a branch.' }
  const r = await q.query(
    'SELECT id, name, status FROM branches WHERE id = $1 AND school_id = $2',
    [id, tenantId]
  )
  if (r.rows.length === 0) return { error: 'Please choose a branch.' }
  const branch = r.rows[0]
  if (branch.status === 'deactivated') {
    return { error: `Branch "${branch.name}" has been deactivated by the Super Admin and cannot accept new records.` }
  }
  return { branch }
}

function parseFullId(full_id) {
  const value = String(full_id || '').trim().toUpperCase()
  if (!value) return { tenant_id: '', login_id: '', isValid: false }

  if (value === 'ADM' || value === 'SUPER-ADM') {
    return { tenant_id: 'SUPER', login_id: 'ADM', isValid: true }
  }

  const lastDash = value.lastIndexOf('-')
  if (lastDash <= 0 || lastDash === value.length - 1) {
    return { tenant_id: '', login_id: '', isValid: false }
  }

  const tenant_id = value.substring(0, lastDash)
  const login_id = value.substring(lastDash + 1)

  if (!tenant_id || !login_id) {
    return { tenant_id: '', login_id: '', isValid: false }
  }

  return { tenant_id, login_id, isValid: true }
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin')
  const expectedOrigin = `${req.protocol}://${req.get('host')}`
  if (origin && origin !== expectedOrigin && origin !== APP_URL.replace(/\/$/, '')) {
    return res.status(403).send('Invalid request origin')
  }
  next()
}

async function issueEmailVerification(user) {
  if (!mailTransporter || !user.email) return false
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  await pool.query(
    `UPDATE email_verification_tokens SET used = true
     WHERE user_id = $1 AND user_role = $2 AND used = false`,
    [user.id, user.role]
  )
  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, user_role, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
    [user.id, user.role, tokenHash]
  )
  const verificationUrl = `${APP_URL}/verify-email.html?token=${rawToken}`
  await mailTransporter.sendMail({
    from: SMTP_FROM,
    to: user.email,
    subject: 'Verify your recovery email — The Eye',
    text: `Verify this email address for password recovery: ${verificationUrl}\n\nThis link expires in 24 hours.`,
    html: `<p>Verify this email address for password recovery.</p><p><a href="${verificationUrl}">Verify email address</a></p><p>This link expires in 24 hours.</p>`
  })
  return true
}

// ============================================
// CORS CONFIGURATION
// ============================================
// FRONTEND_URL: The production frontend URL (Vercel)
// Additional allowed origins can be comma-separated in ALLOWED_ORIGINS env var
const FRONTEND_URL = process.env.FRONTEND_URL || ''
const ADDITIONAL_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

app.use(cors({
  origin: (origin, callback) => {
    // Same-origin and server-to-server requests have no Origin header
    if (!origin) return callback(null, true)
    
    // Production Vercel frontend URL
    if (FRONTEND_URL && origin === FRONTEND_URL) return callback(null, true)
    
    // Legacy AWS frontends (for rollback) - remove after migration confirmed
    // 'http://16.16.104.177',  // AWS frontend (deprecated)
    // 'http://13.50.106.16'    // AWS frontend (deprecated)
    
    // Vercel preview deployments use unique subdomains
    if (/^https:\/\/[\w-]+\.vercel\.app$/.test(origin)) return callback(null, true)
    
    // Local dev servers (like Live Server on any port, localhost, or local IP)
    if (/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin)) return callback(null, true)
    
    // Additional origins from environment variable
    if (ADDITIONAL_ORIGINS.includes(origin)) return callback(null, true)
    
    callback(null, false)
  },
  credentials: true
}))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())

  // HTML is never cached. The permission switches live inside these pages, so a browser
  // sitting on a cached admin.html keeps showing tabs the Super Admin has since switched
  // off, which looks exactly like the feature "not working". No-store costs nothing here
  // and removes that whole class of confusion.
  app.use(express.static('public', {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate')
      }
    }
  }))

const tt2Store = createPgTt2Store(pool)
app.use('/tt2/config', express.static(path.join(__dirname, 'timetable', 'tt2', 'config')))
app.use('/tt2', express.static(path.join(__dirname, 'timetable', 'tt2', 'public')))

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

// --- Fee voucher generator ---------------------------------------------------
// The page and its scripts live in the project root, next to the fee APIs they
// talk to. They are served by name so the browser gets the same files the
// server works with, and so no whole directory is exposed. The page itself is
// picked up by the catch-all below.
app.get('/voucher-engine.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'voucher-engine.js'))
})
app.get('/voucher-api.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'voucher-api.js'))
})
app.get('/voucher-demo-api.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'voucher-demo-api.js'))
})

// Catch-all for .html pages — only matches paths that look like page names,
// NOT API routes. API routes (all start with /api/) are defined after this
// section and take precedence because Express matches in definition order.
app.get('/:page.html', (req, res, next) => {
  // Skip API routes — they are handled by their own route handlers below
  if (req.params.page.startsWith('api/')) return next();
  const safePage = req.params.page.replace(/[^a-zA-Z0-9-_]/g, '');
  res.sendFile(path.join(__dirname, `${safePage}.html`), (err) => {
    if (err) next();
  });
})

const tt2Auth = requireAuth(['admin', 'super_admin', 'coordinator'])

// Feature check middleware for tt2
async function tt2FeatureCheck(req, res, next) {
  try {
    const tenantId = req.user.tenant_id
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenantId, 'timetable']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }
    next()
  } catch (err) {
    console.error('tt2 feature check error:', err)
    next() // Allow access on error to avoid blocking
  }
}

// Get enabled features for the logged-in user's tenant
app.get('/api/features', requireAuth(['admin', 'super_admin', 'coordinator', 'teacher', 'student']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id
    const result = await pool.query(
      'SELECT feature_key FROM tenant_grants WHERE school_id = $1 AND enabled = true',
      [tenantId]
    )
    const features = result.rows.map(row => row.feature_key)
    res.json({ features })
  } catch (err) {
    console.error('Error fetching features:', err)
    res.status(500).json({ error: 'Could not load features. Please try again.' })
  }
})

app.use('/api/tt2/meta', tt2Auth)
app.use('/api/tt2', tt2FeatureCheck, createTt2Router({
  store: tt2Store,
  pool,
  auth: tt2Auth
}))
app.use('/api/finance', createFinanceRouter({ pool, requireAuth }))
app.use('/api/fees', createFeeRouter({ pool, requireAuth }))

// ============================================
// CREATE TABLES ON STARTUP
// ============================================

// Create teacher_attendance table for QR-based teacher check-in
async function createTeacherAttendanceTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teacher_attendance (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
      date DATE NOT NULL,
      check_in_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      check_out_time TIMESTAMPTZ,
      location_lat NUMERIC(10, 6),
      location_lng NUMERIC(10, 6),
      qr_code_data TEXT,
      source VARCHAR(20) DEFAULT 'qr',
      is_incomplete BOOLEAN DEFAULT false,
      is_manual BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(teacher_id, date)
    );
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_teacher_attendance_teacher ON teacher_attendance(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_teacher_attendance_tenant ON teacher_attendance(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_teacher_attendance_date ON teacher_attendance(date);
  `)

  // Create QR attendance sessions table for code generation
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_attendance_sessions (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
      token VARCHAR(64) UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_qr_sessions_tenant ON qr_attendance_sessions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_qr_sessions_token ON qr_attendance_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_qr_sessions_active ON qr_attendance_sessions(is_active) WHERE is_active = true;
  `)

  // Create QR requirement setting table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qr_attendance_settings (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(10) UNIQUE NOT NULL REFERENCES organizations(school_code) ON DELETE CASCADE,
      require_checkout BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // Create manual changes history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teacher_attendance_manual_changes (
      id SERIAL PRIMARY KEY,
      attendance_id INTEGER NOT NULL REFERENCES teacher_attendance(id) ON DELETE CASCADE,
      changed_by INTEGER NOT NULL REFERENCES admins(id) ON DELETE SET NULL,
      changed_by_role VARCHAR(20) NOT NULL,
      old_check_in_time TIMESTAMPTZ,
      new_check_in_time TIMESTAMPTZ,
      old_check_out_time TIMESTAMPTZ,
      new_check_out_time TIMESTAMPTZ,
      old_status VARCHAR(20),
      new_status VARCHAR(20),
      note TEXT NOT NULL,
      changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_manual_changes_attendance ON teacher_attendance_manual_changes(attendance_id);
    CREATE INDEX IF NOT EXISTS idx_manual_changes_by ON teacher_attendance_manual_changes(changed_by);
    CREATE INDEX IF NOT EXISTS idx_manual_changes_date ON teacher_attendance_manual_changes(changed_at);
  `)
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      section VARCHAR(50)
    );

    CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      class_id INTEGER REFERENCES classes(id)
    );

    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      roll_no VARCHAR(50),
      phone VARCHAR(20),
      class_id INTEGER REFERENCES classes(id)
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id),
      teacher_id INTEGER REFERENCES teachers(id),
      date DATE NOT NULL,
      status VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, date)
    );

    CREATE TABLE IF NOT EXISTS homework (
      id SERIAL PRIMARY KEY,
      subject VARCHAR(120) NOT NULL,
      task TEXT NOT NULL,
      class_id INTEGER REFERENCES classes(id),
      teacher_id INTEGER REFERENCES teachers(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(120),
      message TEXT NOT NULL,
      class_id INTEGER REFERENCES classes(id),
      teacher_id INTEGER REFERENCES teachers(id),
      author VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
  await pool.query(`
    ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES teachers(id),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS section VARCHAR(50);
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      school_code VARCHAR(4) UNIQUE NOT NULL,
      school_name VARCHAR(200) NOT NULL,
      contact_email VARCHAR(200),
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS student_limit INTEGER NOT NULL DEFAULT ${DEFAULT_STUDENT_LIMIT};
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS teacher_limit INTEGER NOT NULL DEFAULT ${DEFAULT_TEACHER_LIMIT};
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS location_lat NUMERIC(10, 6);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS location_lng NUMERIC(10, 6);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS location_radius_meters INTEGER DEFAULT 50;
    -- teacher_limit stays a wall, so keep it at or above the current count to avoid
    -- locking a school out of its own existing data. student_limit is deliberately
    -- NOT raised to match: it is the advisory combined ceiling, and a school that
    -- has outgrown it should still see the real number (e.g. 520 / 500).
    UPDATE organizations SET teacher_limit = GREATEST(teacher_limit, (SELECT COUNT(*) FROM teachers t WHERE t.tenant_id = organizations.school_code));

    CREATE TABLE IF NOT EXISTS school_requests (
      id SERIAL PRIMARY KEY,
      school_name VARCHAR(200) NOT NULL,
      contact_person VARCHAR(100) NOT NULL,
      contact_email VARCHAR(200) NOT NULL,
      message TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      login_id VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'admin',
      tenant_id VARCHAR(10) NOT NULL,
      is_first_login BOOLEAN DEFAULT true,
      phone VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)

  await pool.query(`
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS login_id VARCHAR(50) UNIQUE;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'teacher';
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(10);
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS is_first_login BOOLEAN DEFAULT true;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT false;
  `)

  await pool.query(`
    ALTER TABLE students ADD COLUMN IF NOT EXISTS login_id VARCHAR(50) UNIQUE;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
    ALTER TABLE students ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'student';
    ALTER TABLE students ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(10);
    ALTER TABLE students ADD COLUMN IF NOT EXISTS is_first_login BOOLEAN DEFAULT true;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT false;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
  `)

  // Migrate roll_no uniqueness to be scoped to tenant_id
  await pool.query(`
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_roll_no_key;
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_tenant_roll_no_key;
  `)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_tenant_roll_key') THEN
        ALTER TABLE students ADD CONSTRAINT students_tenant_roll_key UNIQUE (tenant_id, roll_no);
      END IF;
    END $$;
  `)

  await pool.query(`
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(10);
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(10);
    ALTER TABLE homework ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(10);
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(10);
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_email VARCHAR(200);
  `)

  // --- Branches -------------------------------------------------------------
  // A school may run one or more branches. Billing is per student, so a branch
  // never carries its own capacity limit; the limit stays on the organization.
  //
  // A branch is created active and is usable immediately, with no approval step.
  // The Super Admin sees it in a passive review queue and can flag or deactivate
  // it afterwards if something looks wrong. Deactivating freezes data entry but
  // keeps existing rows readable.
  //
  // branch_id is nullable everywhere on purpose: a school with no branches keeps
  // every record school-wide, and existing rows are never force-assigned.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS branches (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      school_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INTEGER,
      reviewed_at TIMESTAMP,
      deactivation_reason TEXT,
      UNIQUE (school_id, name)
    );
  `)

  await pool.query(`
    ALTER TABLE students   ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
    ALTER TABLE teachers   ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
    ALTER TABLE classes    ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;

    -- A coordinator may be tied to one branch or, with branch_id NULL, appointed
    -- to the whole school. School admins also keep branch_id NULL.
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS grant_management BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS grant_credentials BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_branches_school ON branches(school_id);
    CREATE INDEX IF NOT EXISTS idx_students_branch ON students(branch_id);
    CREATE INDEX IF NOT EXISTS idx_teachers_branch ON teachers(branch_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_branch ON attendance(branch_id);
    CREATE INDEX IF NOT EXISTS idx_admins_branch ON admins(branch_id);
  `)

  // A coordinator can be management-only, with no login at all. The existing
  // NOT NULL on login_id would make that insert impossible, so the column is
  // relaxed here rather than by inventing placeholder credentials.
  // Password hashes follow the same rule for the same reason. Login already
  // rejects any account with a NULL login_id or password_hash.
  await pool.query(`
    ALTER TABLE admins ALTER COLUMN login_id DROP NOT NULL;
    ALTER TABLE admins ALTER COLUMN password_hash DROP NOT NULL;
  `)

  // --- Tenant feature grants -------------------------------------------------
  // Which modules a school is allowed to use. The Super Admin owns this.
  //
  // The catalogue of features lives in the database rather than in the frontend, so
  // adding a module later is a data change and every screen that renders the list
  // picks it up automatically. A school that has no row for a feature falls back to
  // the default below, which means a brand new school is usable from day one instead
  // of locked out of everything.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_features (
      key VARCHAR(40) PRIMARY KEY,
      label VARCHAR(80) NOT NULL,
      description TEXT,
      default_enabled BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_grants (
      school_id VARCHAR(10) NOT NULL REFERENCES organizations(school_code) ON DELETE CASCADE,
      feature_key VARCHAR(40) NOT NULL REFERENCES tenant_features(key) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT false,
      updated_by INTEGER,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (school_id, feature_key)
    );
  `)

  // Seeded with INSERT ... ON CONFLICT DO NOTHING so restarts never overwrite a label
  // or reset a default that has since been changed deliberately.
  //
  // The student and teacher portals default to false on purpose: they hand out working
  // sign-ins nobody asked for, so a school gets them only when the Super Admin grants
  // them. The Coordinator Portal defaults ON because it is an admin-panel tool first -
  // the school admin creates and manages coordinators from the Coordinators tab - and
  // the Super Admin can still switch it off per school in the features screen.
  await pool.query(`
    INSERT INTO tenant_features (key, label, description, default_enabled, sort_order) VALUES
      ('attendance',              'Attendance',              'Daily attendance marking and records',                    true,  10),
      ('student_management',      'Student Management',      'Add, edit and remove students',                           true,  20),
      ('student_portal',          'Student Portal',          'Student sign-in to see their own records',               false, 30),
      ('teacher_management',      'Teacher Management',      'Add, edit and remove teachers',                           true,  40),
      ('teacher_portal',          'Teacher Portal',          'Teacher sign-in and class tools',                         false, 50),
      ('fees',                    'Fees',                    'Fee structures, invoices and payments',                true,  60),
      ('whatsapp',                'WhatsApp',                'WhatsApp notifications and messaging',                  false, 70),
      ('biometric',               'Biometric',               'Biometric attendance device integration',               false, 80),
      ('coordinator_management',  'Coordinator Management',  'Add, edit and remove coordinators',                       true,  85),
      ('coordinator_portal',      'Coordinator Portal',      'Attendance-only coordinators for branch staff',            true,   90),
      ('qr_attendance',           'QR Attendance',            'QR-based staff check-in and attendance tracking',        false, 95),
      ('timetable',               'Timetable',               'Automated timetable generator',                         false, 100)
    ON CONFLICT (key) DO NOTHING;
  `)

  // Older installs seeded coordinator_portal as default-off, and the ON CONFLICT
  // above never rewrites an existing row - so re-point the catalogue default here.
  // This only moves the FALLBACK for schools with no explicit decision: a school the
  // Super Admin deliberately switched off keeps its tenant_grants row (enabled=false),
  // and an explicit row always wins over the catalogue default.
  await pool.query(`
    UPDATE tenant_features SET default_enabled = true WHERE key = 'coordinator_portal';
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_grants_school ON tenant_grants(school_id);
  `)


  await pool.query(`
    CREATE TABLE IF NOT EXISTS fee_structures (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL,
      target_id INTEGER NOT NULL,
      monthly_fee NUMERIC(10, 2) DEFAULT 0,
      admission_fee NUMERIC(10, 2) DEFAULT 0,
      transport_fee NUMERIC(10, 2) DEFAULT 0,
      discount NUMERIC(10, 2) DEFAULT 0,
      tenant_id VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fee_payments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      month VARCHAR(7) NOT NULL,
      amount_due NUMERIC(10, 2) DEFAULT 0,
      amount_paid NUMERIC(10, 2) DEFAULT 0,
      status VARCHAR(20) DEFAULT 'unpaid',
      payment_method VARCHAR(50),
      payment_date DATE,
      notes TEXT,
      tenant_id VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, month, tenant_id)
    );
  `)

  // --- Fee voucher generator: vouchers, receipts and per-school fee settings ---
  // Every row carries its tenant, so one academy's money can never be mixed
  // with another's. `ref_id` is the number the fee engine works with (and the
  // number printed on the challan); `id` stays the database's own key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fee_vouchers (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(10) NOT NULL,
      ref_id INTEGER NOT NULL,
      student_id INTEGER,
      class_id INTEGER,
      student_name VARCHAR(150),
      father_name VARCHAR(150),
      admission_number VARCHAR(60),
      class_name VARCHAR(150),
      month VARCHAR(20) NOT NULL,
      year VARCHAR(10) NOT NULL,
      amount NUMERIC(12, 2) DEFAULT 0,
      base_amount NUMERIC(12, 2) DEFAULT 0,
      discount NUMERIC(12, 2) DEFAULT 0,
      charges JSONB DEFAULT '[]'::jsonb,
      status VARCHAR(20) DEFAULT 'Unpaid',
      issue_date TIMESTAMPTZ,
      due_date TIMESTAMPTZ,
      payment_date TIMESTAMPTZ,
      total_received NUMERIC(12, 2) DEFAULT 0,
      paid_tuition NUMERIC(12, 2) DEFAULT 0,
      paid_ac NUMERIC(12, 2) DEFAULT 0,
      fine_charged NUMERIC(12, 2),
      fine_waived BOOLEAN DEFAULT false,
      remaining_annual_charges NUMERIC(12, 2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fee_vouchers_tenant_period ON fee_vouchers(tenant_id, year, month);
    CREATE INDEX IF NOT EXISTS idx_fee_vouchers_tenant_student ON fee_vouchers(tenant_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_fee_vouchers_tenant_class ON fee_vouchers(tenant_id, class_id);

    CREATE TABLE IF NOT EXISTS fee_receipts (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(10) NOT NULL,
      ref_id INTEGER NOT NULL,
      receipt_no VARCHAR(40) NOT NULL,
      voucher_id INTEGER,
      student_id INTEGER,
      student_name VARCHAR(150),
      class_name VARCHAR(150),
      month VARCHAR(20),
      year VARCHAR(10),
      paid_tuition NUMERIC(12, 2) DEFAULT 0,
      paid_ac NUMERIC(12, 2) DEFAULT 0,
      amount NUMERIC(12, 2) DEFAULT 0,
      allocations JSONB DEFAULT '[]'::jsonb,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      received_by VARCHAR(100),
      received_by_name VARCHAR(150),
      reversed_at TIMESTAMPTZ,
      reversed_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tenant_id, ref_id),
      UNIQUE (tenant_id, receipt_no)
    );
    CREATE INDEX IF NOT EXISTS idx_fee_receipts_tenant ON fee_receipts(tenant_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fee_receipts_tenant_student ON fee_receipts(tenant_id, student_id);

    CREATE TABLE IF NOT EXISTS fee_settings (
      tenant_id VARCHAR(10) PRIMARY KEY,
      due_days INTEGER DEFAULT 10,
      late_fine NUMERIC(12, 2) DEFAULT 0,
      branding JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // Fix existing admin login_id values that were stored as the full concatenated ID
  await pool.query(`
    UPDATE admins SET login_id = 'ADM' WHERE tenant_id = 'SUPER' AND login_id = 'SUPER-ADM'
  `)

  // Fix existing regular admin login_id values that were stored with full concatenated IDs (e.g. 'HARV-ADM' -> 'ADM')
  await pool.query(`
    UPDATE admins 
    SET login_id = SUBSTRING(login_id FROM POSITION('-' IN login_id) + 1)
    WHERE login_id LIKE '%-%'
      AND role <> 'super_admin';
  `)

  // Fix existing teacher/student login_id values that were stored with full concatenated IDs (e.g. 'APSC-T001' -> 'T001')
  await pool.query(`
    UPDATE teachers 
    SET login_id = SUBSTRING(login_id FROM POSITION('-' IN login_id) + 1)
    WHERE login_id LIKE '%-%';

    UPDATE students 
    SET login_id = SUBSTRING(login_id FROM POSITION('-' IN login_id) + 1)
    WHERE login_id LIKE '%-%';
  `)

  // Fix global UNIQUE constraints on login_id to be scoped per tenant_id
  await pool.query(`
    ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_login_id_key;
    ALTER TABLE teachers DROP CONSTRAINT IF EXISTS teachers_login_id_key;
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_login_id_key;
  `)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_tenant_login_key') THEN
        ALTER TABLE admins ADD CONSTRAINT admins_tenant_login_key UNIQUE (tenant_id, login_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teachers_tenant_login_key') THEN
        ALTER TABLE teachers ADD CONSTRAINT teachers_tenant_login_key UNIQUE (tenant_id, login_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_tenant_login_key') THEN
        ALTER TABLE students ADD CONSTRAINT students_tenant_login_key UNIQUE (tenant_id, login_id);
      END IF;
    END $$;
  `)

  // ============================================
  // PASSWORD RESET: email columns, token_generation, reset tokens table
  // ============================================
  await pool.query(`
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS email VARCHAR(200);
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS email VARCHAR(200);
    ALTER TABLE students ADD COLUMN IF NOT EXISTS email VARCHAR(200);
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
  `)

  await pool.query(`
    ALTER TABLE admins ADD COLUMN IF NOT EXISTS token_generation INTEGER DEFAULT 0;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS token_generation INTEGER DEFAULT 0;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS token_generation INTEGER DEFAULT 0;
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      user_role VARCHAR(20) NOT NULL,
      token_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      user_role VARCHAR(20) NOT NULL,
      token_hash VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_password_reset_audit (
      id SERIAL PRIMARY KEY,
      actor_id INTEGER NOT NULL,
      actor_role VARCHAR(20) NOT NULL,
      target_id INTEGER NOT NULL,
      target_role VARCHAR(20) NOT NULL,
      tenant_id VARCHAR(10) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS password_reset_tokens_active_lookup_idx
      ON password_reset_tokens (user_id, user_role, used, expires_at);
    CREATE INDEX IF NOT EXISTS email_verification_tokens_active_lookup_idx
      ON email_verification_tokens (user_id, user_role, used, expires_at);
  `)

  // Ensure token_generation is initialized for existing users
  await pool.query(`UPDATE admins SET token_generation = 0 WHERE token_generation IS NULL`)
  await pool.query(`UPDATE teachers SET token_generation = 0 WHERE token_generation IS NULL`)
  await pool.query(`UPDATE students SET token_generation = 0 WHERE token_generation IS NULL`)

  // A class must have at most ONE assigned teacher. Without this, two teachers can
  // share a class_id, which duplicates every attendance row for that class and makes
  // the student portal show whichever teacher happens to have the lowest id.
  // Resolve existing conflicts by keeping the most recently created teacher.
  const dupeClasses = await pool.query(`
    SELECT class_id, tenant_id, COUNT(*) AS n,
           ARRAY_AGG(id ORDER BY id) AS teacher_ids
    FROM teachers
    WHERE class_id IS NOT NULL
    GROUP BY class_id, tenant_id
    HAVING COUNT(*) > 1
  `)
  if (dupeClasses.rows.length) {
    for (const row of dupeClasses.rows) {
      const keep = row.teacher_ids[row.teacher_ids.length - 1]
      const drop = row.teacher_ids.slice(0, -1)
      await pool.query(
        'UPDATE teachers SET class_id = NULL WHERE id = ANY($1::int[]) AND tenant_id = $2',
        [drop, row.tenant_id]
      )
      console.warn(
        `[migration] class ${row.class_id} had ${row.n} teachers; kept ${keep}, unassigned ${drop.join(', ')}`
      )
    }
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS teachers_one_class_per_tenant_idx
      ON teachers (class_id) WHERE class_id IS NOT NULL
  `)

  // Migration 20261101_datesheets_and_complaints
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datesheets (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(100) NOT NULL,
      branch_id INTEGER,
      title VARCHAR(255) NOT NULL,
      scope VARCHAR(100) NOT NULL,
      class_name VARCHAR(100),
      revision INTEGER NOT NULL DEFAULT 1,
      data JSONB NOT NULL,
      published_by INTEGER,
      published_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_datesheets_tenant ON datesheets(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_datesheets_scope ON datesheets(scope);

    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      tenant_id VARCHAR(100) NOT NULL,
      branch_id INTEGER,
      role VARCHAR(50) NOT NULL,
      user_id INTEGER,
      author_name VARCHAR(150),
      category VARCHAR(100) NOT NULL,
      subject VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      is_anonymous BOOLEAN DEFAULT false,
      status VARCHAR(50) DEFAULT 'pending',
      admin_notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_complaints_tenant ON complaints(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_complaints_role ON complaints(role);
    CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
  `);

  // Create teacher attendance table for QR-based check-in
  await createTeacherAttendanceTable()

  console.log('Tables ready')
}


// ============================================
// HEALTH CHECK (used by frontend / deploy verification)
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'serverg', auth: true, ts: Date.now() })
})

// ============================================
// AUTH ROUTES
// ============================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { password, tenant_id: bodyTenantId, login_id: bodyLoginId } = req.body || {}
    let full_id = (req.body.full_id || '').trim()
    if (!full_id && bodyTenantId && bodyLoginId) {
      full_id = `${bodyTenantId}-${bodyLoginId}`.trim()
    }
    if (!full_id && bodyLoginId) {
      full_id = String(bodyLoginId).trim()
    }
    const parsed = parseFullId(full_id)
    const tenant_id = parsed.tenant_id
    const login_id = parsed.login_id
    if (!parsed.isValid || !password) {
      return res.status(400).json({ error: 'Full ID and Password are required' })
    }

    // Branch scope and per-user grants only exist on admins. Students and
    // teachers get NULL/FALSE so the UNION types line up, and so a coordinator
    // is the only role that is ever branch-scoped or grant-gated.
    const result = await pool.query(`
      SELECT id, password_hash, role, is_first_login, is_frozen, token_generation,
             NULL::INTEGER AS branch_id, FALSE AS grant_management, FALSE AS grant_credentials,
             1 AS src_order
      FROM students
      WHERE tenant_id = $1 AND login_id = $2
      UNION ALL
      SELECT id, password_hash, role, is_first_login, COALESCE(is_frozen, false) AS is_frozen, token_generation,
             NULL::INTEGER, FALSE, FALSE, 2 AS src_order
      FROM teachers
      WHERE tenant_id = $1 AND login_id = $2
      UNION ALL
      SELECT id, password_hash, role, is_first_login, FALSE AS is_frozen, token_generation,
             branch_id, grant_management, grant_credentials, 3 AS src_order
      FROM admins
      WHERE tenant_id = $1 AND login_id = $2
      ORDER BY src_order
      LIMIT 1
    `, [tenant_id, login_id])

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid Organization, ID, or Password' })
    }

    const user = result.rows[0]

    // A coordinator the school has not given credentials to is a person record
    // only - there is no login for them, so refuse here rather than let them in.
    if (user.role === 'coordinator' && !user.grant_credentials) {
      return res.status(403).json({ error: 'Login has not been enabled for your account. Please contact your admin.' })
    }

    // A coordinator works school-wide when they have no branch; with one, their
    // scope is that branch. Either way the login is valid here.

    // A person enrolled while their portal was switched off has a login_id but no
    // password yet. They were never given one, so say that instead of comparing
    // against NULL and throwing a 500.
    if (!user.password_hash) {
      return res.status(403).json({
        error: 'No login has been set up for this account yet. Please contact your school admin.',
        credentials_not_issued: true
      })
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash)
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid Organization, ID, or Password' })
    }

    if (user.is_frozen === true) {
      return res.status(403).json({ error: 'Your account has been frozen. Please contact administration.' })
    }

    // A portal that the school has not been given is switched off, and its people
    // cannot sign in. This blocks the SIGN IN only - the student and teacher records,
    // their classes and their attendance are all left exactly as they are, and the
    // school can get in the moment a Super Admin grants the portal.
    const portalOn = await isPortalEnabled(tenant_id, user.role)
    if (!portalOn) {
      const label = user.role === 'student' ? 'Student' : user.role === 'coordinator' ? 'Coordinator' : 'Teacher'
      return res.status(403).json({
        error: `The ${label} Portal has not been enabled for your school yet. Please ask your school admin to request it.`,
        portal_disabled: true
      })
    }

    const redirectMap = {
      super_admin: '/super-admin.html',
      admin: '/admin.html',
      teacher: '/teacher.html',
      student: '/student.html',
      coordinator: '/coordinator.html'
    }
    let redirect_url = redirectMap[user.role] || '/index.html'
    
    // If first login, redirect to change password page
    if (user.is_first_login) {
      redirect_url = '/change-password.html'
    }

    const token = jwt.sign(
      {
        user_id: user.id,
        role: user.role,
        tenant_id: tenant_id,
        login_id: login_id,
        is_first_login: user.is_first_login,
        token_generation: user.token_generation || 0,
        // Carried on the token so the branch scope survives a password change or
        // token refresh. Every jwt.sign below must include these.
        branch_id: user.branch_id === undefined ? null : user.branch_id,
        grant_management: user.grant_management === true,
        grant_credentials: user.grant_credentials === true
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    )

    const isProd = process.env.NODE_ENV === 'production'
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000
    })

    return res.status(200).json({
      success: true,
      token,
      role: user.role,
      is_first_login: user.is_first_login,
      redirect_url
    })


  } catch (err) {
    console.error('Login error:', err)
    return res.status(500).json({ error: 'Internal server error: ' + err.message })
  }
})

// POST /api/auth/change-password
app.post('/api/auth/change-password', requireAuth(), async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body || {}

    if (!new_password || !confirm_password) {
      return res.status(400).json({ error: 'New password and confirmation are required' })
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'New passwords do not match' })
    }

    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    // Check for at least one special character
    const specialChars = /[!@#$%^&*(),.?":{}|<>]/
    if (!specialChars.test(new_password)) {
      return res.status(400).json({ error: 'Password must contain at least one special character (!@#$%^&*(),.?":{}|<>)' })
    }

    const { user_id, role, tenant_id, login_id } = req.user
    let selectQuery = ''
    let updateQuery = ''

    if (role === 'super_admin' || role === 'admin' || role === 'coordinator') {
      // Coordinators live in the admins table too, so they share this path.
      selectQuery = 'SELECT password_hash, token_generation, is_first_login FROM admins WHERE id = $1'
      updateQuery = 'UPDATE admins SET password_hash = $1, is_first_login = false, token_generation = COALESCE(token_generation, 0) + 1 WHERE id = $2 RETURNING token_generation'
    } else if (role === 'teacher') {
      selectQuery = 'SELECT password_hash, token_generation, is_first_login FROM teachers WHERE id = $1'
      updateQuery = 'UPDATE teachers SET password_hash = $1, is_first_login = false, token_generation = COALESCE(token_generation, 0) + 1 WHERE id = $2 RETURNING token_generation'
    } else if (role === 'student') {
      selectQuery = 'SELECT password_hash, token_generation, is_first_login FROM students WHERE id = $1'
      updateQuery = 'UPDATE students SET password_hash = $1, is_first_login = false, token_generation = COALESCE(token_generation, 0) + 1 WHERE id = $2 RETURNING token_generation'
    } else {
      return res.status(400).json({ error: 'Invalid role' })
    }

    const result = await pool.query(selectQuery, [user_id])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = result.rows[0]
    const isFirstLogin = user.is_first_login === true

    if (!isFirstLogin) {
      // Only require current password for non-first-time logins
      if (!current_password) {
        return res.status(400).json({ error: 'Please enter your current password' })
      }
      const validCurrent = await bcrypt.compare(current_password, user.password_hash)
      if (!validCurrent) {
        return res.status(400).json({ error: 'Current password is incorrect' })
      }
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS)

    const updateResult = await pool.query(updateQuery, [newHash, user_id])
    const tokenGeneration = updateResult.rows[0].token_generation

const token = jwt.sign(
        {
          user_id,
          role,
          tenant_id,
          login_id,
          is_first_login: false,
          token_generation: tokenGeneration,
          // Must be re-read from req.user, not echoed from the old token, so a
          // coordinator keeps (or loses) their branch scope after a reset.
          branch_id: req.user.branch_id === undefined ? null : req.user.branch_id,
          grant_management: req.user.grant_management === true,
          grant_credentials: req.user.grant_credentials === true
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      )

      const isProd = process.env.NODE_ENV === 'production'
      res.cookie('auth_token', token, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        path: '/',
        maxAge: 8 * 60 * 60 * 1000
      })

      const redirectMap = { super_admin: '/super-admin.html', admin: '/admin.html', teacher: '/teacher.html', student: '/student.html', coordinator: '/coordinator.html' }
      const redirect_url = redirectMap[role] || '/'

    res.json({ success: true, token, redirect_url, message: 'Password changed successfully' })
  } catch (err) {
    console.error('Change password error:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production'
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/'
  })
  return res.status(200).json({ success: true })
})

// ============================================
// POST /api/auth/forgot-password
// ============================================
app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const GENERIC_MSG = 'If a verified recovery email is registered for that account, a reset link has been sent. Otherwise, contact your administrator.'
  try {
    let full_id = (req.body?.full_id || '').trim()
    if (!full_id) {
      return res.status(400).json({ error: 'Full ID is required' })
    }

    const parsed = parseFullId(full_id)
    const tenant_id = parsed.tenant_id
    const login_id = parsed.login_id

    if (!parsed.isValid) {
      // Don't reveal that the ID format is wrong — return generic message
      return res.json({ success: true, message: GENERIC_MSG })
    }

    // Look up user across all tables
    const result = await pool.query(`
      SELECT id, role, email, email_verified_at, 1 AS src_order FROM students WHERE tenant_id = $1 AND login_id = $2
      UNION ALL
      SELECT id, role, email, email_verified_at, 2 AS src_order FROM teachers WHERE tenant_id = $1 AND login_id = $2
      UNION ALL
      SELECT id, role, email, email_verified_at, 3 AS src_order FROM admins WHERE tenant_id = $1 AND login_id = $2
      ORDER BY src_order
      LIMIT 1
    `, [tenant_id, login_id])

    if (result.rows.length === 0) {
      return res.json({ success: true, message: GENERIC_MSG })
    }

    const user = result.rows[0]

    if (!user.email || !user.email_verified_at) {
      return res.json({ success: true, message: GENERIC_MSG })
    }

    // Generate cryptographically secure token
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000)

    // Store only the hash
    await pool.query(
      `UPDATE password_reset_tokens SET used = true
       WHERE user_id = $1 AND user_role = $2 AND used = false`,
      [user.id, user.role]
    )
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, user_role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, user.role, tokenHash, expiresAt]
    )

    const resetUrl = `${APP_URL}/reset-password.html?token=${rawToken}`

    // Send email
    if (mailTransporter) {
      try {
        await mailTransporter.sendMail({
          from: SMTP_FROM,
          to: user.email,
          subject: 'Password Reset — The Eye',
          text: `You requested a password reset.\n\nClick the link below to reset your password:\n${resetUrl}\n\nThis link expires in ${RESET_TOKEN_EXPIRY_MINUTES} minutes.\nIf you did not request this, ignore this email.`,
          html: `<p>You requested a password reset.</p><p><a href="${resetUrl}">Click here to reset your password</a></p><p>This link expires in ${RESET_TOKEN_EXPIRY_MINUTES} minutes.</p><p>If you did not request this, ignore this email.</p>`
        })
      } catch (emailErr) {
        console.error('Failed to send reset email:', emailErr.message)
      }
    }

    res.json({ success: true, message: GENERIC_MSG })
  } catch (err) {
    console.error('Forgot password error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/api/auth/verify-email', async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(String(req.body.token || '')).digest('hex')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT id, user_id, user_role FROM email_verification_tokens
       WHERE token_hash = $1 AND used = false AND expires_at > NOW() FOR UPDATE`,
      [tokenHash]
    )
    if (result.rows.length !== 1) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Invalid or expired verification link' })
    }
    const record = result.rows[0]
    const table = tableForRole(record.user_role)
    if (!table) throw new Error('Invalid verification role')
    await client.query(`UPDATE ${table} SET email_verified_at = NOW() WHERE id = $1`, [record.user_id])
    await client.query('UPDATE email_verification_tokens SET used = true WHERE id = $1', [record.id])
    await client.query('COMMIT')
    res.json({ success: true, message: 'Email verified. You can now use it for password recovery.' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Email verification error:', err.message)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// ============================================
// POST /api/auth/reset-password
// ============================================
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, new_password, confirm_password } = req.body

    if (!token) {
      return res.status(400).json({ error: 'Reset token is required' })
    }

    if (!new_password || !confirm_password) {
      return res.status(400).json({ error: 'New password and confirmation are required' })
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match' })
    }

    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    const specialChars = /[!@#$%^&*(),.?":{}|<>]/
    if (!specialChars.test(new_password)) {
      return res.status(400).json({ error: 'Password must contain at least one special character' })
    }

    // Hash the provided token and look it up
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tokenResult = await client.query(
        `SELECT id, user_id, user_role FROM password_reset_tokens
         WHERE token_hash = $1 AND used = false AND expires_at > NOW() FOR UPDATE`,
        [tokenHash]
      )
      if (tokenResult.rows.length !== 1) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Invalid or expired reset link' })
      }
      const resetRecord = tokenResult.rows[0]
      const role = resetRecord.user_role
      const table = tableForRole(role)
      if (!table) throw new Error('Invalid reset role')
      await client.query(
        `UPDATE ${table} SET password_hash = $1, is_first_login = false, token_generation = COALESCE(token_generation, 0) + 1 WHERE id = $2`,
        [newHash, resetRecord.user_id]
      )

      // Mark token as used
      await client.query(
        `UPDATE password_reset_tokens SET used = true WHERE id = $1`,
        [resetRecord.id]
      )

      await client.query('COMMIT')
    } catch (txErr) {
      await client.query('ROLLBACK')
      throw txErr
    } finally {
      client.release()
    }

    res.json({ success: true, message: 'Password has been reset successfully. You can now log in with your new password.' })
  } catch (err) {
    console.error('Reset password error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/auth/me
app.get('/api/auth/me', async (req, res) => {
  try {
    let token = null
    const authHeader = req.headers['authorization']
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7)
    } else if (req.cookies?.auth_token) {
      token = req.cookies.auth_token
    }

    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const decoded = jwt.verify(token, JWT_SECRET)
    console.log('DEBUG /api/auth/me - decoded role:', decoded.role, 'user_id:', decoded.user_id)

   let table = ''
   if (decoded.role === 'super_admin' || decoded.role === 'admin' || decoded.role === 'coordinator') table = 'admins'
   else if (decoded.role === 'teacher') table = 'teachers'
   else if (decoded.role === 'student') table = 'students'

    let is_first_login = decoded.is_first_login
    let token_generation = decoded.token_generation || 0
    if (table) {
      const result = await pool.query(
        `SELECT is_first_login, token_generation FROM ${table} WHERE id = $1`,
        [decoded.user_id]
      )
      if (result.rows.length > 0) {
        is_first_login = result.rows[0].is_first_login
        token_generation = result.rows[0].token_generation || 0
      }

      // Reject tokens with stale generation (password was reset)
      if (decoded.token_generation !== undefined && decoded.token_generation !== token_generation) {
        return res.status(401).json({ error: 'Session invalidated. Please log in again.' })
      }
    }

    const freshToken = jwt.sign(
      {
        user_id: decoded.user_id,
        role: decoded.role,
        tenant_id: decoded.tenant_id,
        login_id: decoded.login_id,
        is_first_login,
        token_generation,
        // Carried forward from the incoming token so a refresh never widens or
        // narrows a coordinator's scope.
        branch_id: decoded.branch_id === undefined ? null : decoded.branch_id,
        grant_management: decoded.grant_management === true,
        grant_credentials: decoded.grant_credentials === true
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    )

    res.cookie('auth_token', freshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
      maxAge: 8 * 60 * 60 * 1000
    })

    return res.status(200).json({
      id: decoded.user_id,
      role: decoded.role,
      is_first_login,
      token: freshToken
    })

  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid' })
  }
})

// POST /api/auth/create-teacher
// Enrolment belongs to the school admin, not the platform owner. A super admin is not
// a member of any school, so their token carries tenant_id 'SUPER' - a tenant that is
// not a school. Letting them call this would create the row in a tenant that does not
// exist, which is why the role is deliberately not accepted here. See admin.html, which
// turns a super admin away with a readable reason instead of a 403 mid-form.

// Smallest unused login number (S001, T001, ...) for a tenant. Only currently stored
// rows count, so a student/teacher that was deleted frees its number and the next
// allocation reuses it - the sequence stays tight instead of climbing forever as
// records come and go. login_id is only a credential (nothing references the string),
// so reuse is safe; per-tenant uniqueness is enforced by the database.
async function nextFreeLoginNumber(queryable, table, prefix, tenantId, extraTaken = null) {
  const res = await queryable.query(
    `SELECT login_id FROM ${table} WHERE tenant_id = $1 AND login_id IS NOT NULL`,
    [tenantId]
  )
  const used = new Set(extraTaken || [])
  for (const row of res.rows) {
    const m = /(?:^|-)([ST])(\d+)$/.exec(row.login_id)
    if (m && m[1] === prefix) used.add(parseInt(m[2], 10))
  }
  let n = 1
  while (used.has(n)) n += 1
  return n
}

app.post('/api/auth/create-teacher', requireAuth(['admin']), async (req, res) => {
  try {
    const { name, phone, class_id } = req.body
    const email = normalizeEmail(req.body.email)
    if (!name) return res.status(400).json({ error: 'Teacher name is required' })
    if (email === undefined) return res.status(400).json({ error: 'Enter a valid email address' })

    const tenant_id = req.user.tenant_id

    const capErr = await capacityViolation(pool, tenant_id, 'teacher')
    if (capErr) return res.status(400).json({ error: capErr })

    // Branch rule: no branches means school-wide (branch_id stays null); one or
    // more means the school must say which branch this teacher belongs to.
    const branchPick = await resolveBranchForWrite(pool, tenant_id, req.body.branch_id)
    if (branchPick.error) return res.status(400).json({ error: branchPick.error })
    const branchId = branchPick.branch ? branchPick.branch.id : null

    // A class in another branch cannot take this teacher, so the two must agree.
    if (class_id) {
      const selectedClass = await pool.query(
        'SELECT branch_id FROM classes WHERE id = $1 AND tenant_id = $2',
        [class_id, tenant_id]
      )
      if (selectedClass.rows.length === 0) return res.status(400).json({ error: 'Class not found' })
      if (branchId && selectedClass.rows[0].branch_id && selectedClass.rows[0].branch_id !== branchId) {
        return res.status(400).json({ error: 'That class belongs to a different branch.' })
      }
    }

    // One teacher per class: assigning a new teacher takes the class over.
    if (class_id) {
      const prevHolder = await pool.query(
        'SELECT id FROM teachers WHERE class_id = $1 AND tenant_id = $2',
        [class_id, tenant_id]
      )
      for (const h of prevHolder.rows) {
        await pool.query('UPDATE teachers SET class_id = NULL WHERE id = $1', [h.id])
      }
    }

    const nextNum = await nextFreeLoginNumber(pool, 'teachers', 'T', tenant_id)

    const shortId = `T${String(nextNum).padStart(3, '0')}`
    const teacherId = `${tenant_id}-${shortId}`
    const { tempPassword, passwordHash } = await mintCredentialIfPortalEnabled(tenant_id, 'teacher')

    const result = await pool.query(
      `INSERT INTO teachers (name, phone, class_id, login_id, password_hash, role, tenant_id, branch_id, is_first_login, email, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, 'teacher', $6, $7, true, $8, NULL)
       RETURNING id, name, phone, class_id, login_id, role, tenant_id, branch_id, is_first_login, email, email_verified_at`,
      [name, phone || null, class_id || null, shortId, passwordHash, tenant_id, branchId, email]
    )
    if (email) issueEmailVerification(result.rows[0]).catch(err => console.error('Verification email send failed:', err.message))
    // capacity_notice is advisory only - the record is created either way.
    const body = {
      success: true,
      teacher_id: teacherId,
      teacher: result.rows[0],
      credentials_issued: tempPassword !== null,
      capacity_notice: await capacityNotice(pool, tenant_id, 'teacher')
    }
    if (tempPassword !== null) {
      body.temp_password = tempPassword
    }
    res.json(body)
  } catch (err) {
    console.error('Create teacher error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/auth/create-student
app.post('/api/auth/create-student', requireAuth(['admin']), async (req, res) => {
  try {
    const { name, roll_no, phone, class_id } = req.body
    const email = normalizeEmail(req.body.email)
    if (!name) return res.status(400).json({ error: 'Student name is required' })
    if (email === undefined) return res.status(400).json({ error: 'Enter a valid email address' })

    const tenant_id = req.user.tenant_id

    const capErr = await capacityViolation(pool, tenant_id, 'student')
    if (capErr) return res.status(400).json({ error: capErr })

    // Branch rule: no branches means school-wide (branch_id stays null); one or
    // more means the school must say which branch this student belongs to.
    const branchPick = await resolveBranchForWrite(pool, tenant_id, req.body.branch_id)
    if (branchPick.error) return res.status(400).json({ error: branchPick.error })
    const branchId = branchPick.branch ? branchPick.branch.id : null

    if (class_id && branchId) {
      const classBranch = await pool.query(
        'SELECT branch_id FROM classes WHERE id = $1 AND tenant_id = $2',
        [class_id, tenant_id]
      )
      if (classBranch.rows.length === 0) return res.status(400).json({ error: 'Class not found' })
      if (classBranch.rows[0].branch_id && classBranch.rows[0].branch_id !== branchId) {
        return res.status(400).json({ error: 'That class belongs to a different branch.' })
      }
    }

    const dupErr = await findStudentDuplicate(pool, tenant_id, { roll_no, name })
    if (dupErr) return res.status(400).json({ error: dupErr })

    const nextNum = await nextFreeLoginNumber(pool, 'students', 'S', tenant_id)
    const shortId = `S${String(nextNum).padStart(3, '0')}`
    const studentId = `${tenant_id}-${shortId}`
    const { tempPassword, passwordHash } = await mintCredentialIfPortalEnabled(tenant_id, 'student')

    const result = await pool.query(
      `INSERT INTO students (name, roll_no, phone, class_id, login_id, password_hash, role, tenant_id, branch_id, is_first_login, email, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'student', $7, $8, true, $9, NULL)
       RETURNING id, name, roll_no, phone, class_id, login_id, role, tenant_id, branch_id, is_first_login, email, email_verified_at`,
      [name, roll_no || null, phone || null, class_id || null, shortId, passwordHash, tenant_id, branchId, email]
    )
    if (email) issueEmailVerification(result.rows[0]).catch(err => console.error('Verification email send failed:', err.message))
    const body = {
      success: true,
      student_id: studentId,
      student: result.rows[0],
      credentials_issued: tempPassword !== null,
      capacity_notice: await capacityNotice(pool, tenant_id, 'student')
    }
    if (tempPassword !== null) {
      body.temp_password = tempPassword
    }
    res.json(body)
  } catch (err) {
    console.error('Create student error:', err)

    if (err.code === '23505' && err.constraint === 'students_tenant_roll_key') {
      return res.status(400).json({ error: `Roll number "${roll_no}" is already used by another student in this school. Please choose a different one.` })
    }

    res.status(500).json({ error: 'Something went wrong while creating the student. Please try again.' })
  }
})

// Parse an explicit names list for the bulk creators. The admin modal sends
// names: [] - typed one by one (Enter to add) or read from an uploaded CSV's
// first column. Names are trimmed, whitespace-collapsed and capped at 100 chars
// to match the students/teachers.name column. Duplicates are allowed on purpose:
// two students can legitimately share a name.
function extractBulkNames(body) {
  if (!Array.isArray(body.names)) return null
  return body.names
    .map(n => String(n).trim().replace(/\s+/g, ' ').slice(0, 100))
    .filter(n => n.length > 0)
}

// POST /api/auth/bulk-create-students
app.post('/api/auth/bulk-create-students', requireAuth(['admin', 'super_admin']), bulkCreateLimiter, async (req, res) => {
  // Names-first: an explicit list. Without one the legacy count body still works
  // and generates "Student 1", "Student 2", ... placeholders.
  const names = extractBulkNames(req.body);
  const count = names ? names.length : parseInt(req.body.count, 10);
  const class_id = req.body.class_id;
  if (isNaN(count) || count < 1) return res.status(400).json({ error: names ? 'Add at least one name first' : 'Valid count is required' });
  if (count > 500) return res.status(400).json({ error: 'Maximum 500 accounts per batch' });
  if (!class_id) return res.status(400).json({ error: 'class_id is required' });

  const tenant_id = req.user.tenant_id;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const capErr = await capacityViolation(client, tenant_id, 'student', count);
    if (capErr) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: capErr });
    }

    // A batch lands in one branch, so it has to clear the same branch gate as a single
    // create: optional while the school has no branches, required once it has one.
    const branchPick = await resolveBranchForWrite(client, tenant_id, req.body.branch_id);
    if (branchPick.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: branchPick.error });
    }
    const branchId = branchPick.branch ? branchPick.branch.id : null;

    // Fill the lowest free S-number first (the whole batch is planned before any
    // insert, so a cursor over the used set covers deletions and prior allocations).
    const usedLoginRows = await client.query(
      `SELECT login_id FROM students WHERE tenant_id = $1 AND login_id IS NOT NULL`,
      [tenant_id]
    );
    const usedLoginNums = new Set();
    for (const row of usedLoginRows.rows) {
      const m = /(?:^|-)([ST])(\d+)$/.exec(row.login_id);
      if (m && m[1] === 'S') usedLoginNums.add(parseInt(m[2], 10));
    }
    let cursor = 1;

    const createdAccounts = [];
    const values = [];
    let paramIndex = 1;
    const queryParams = [];

    // One decision for the whole batch: if the portal is off, nobody gets a password.
    const { tempPassword: batchTempPassword, passwordHash: batchHash } =
      await mintCredentialIfPortalEnabled(tenant_id, 'student');

    for (let i = 0; i < count; i++) {
      while (usedLoginNums.has(cursor)) cursor += 1;
      const shortId = `S${String(cursor).padStart(3, '0')}`;
      usedLoginNums.add(cursor);
      cursor += 1;
      const name = names ? names[i] : `Student ${i + 1}`;

      // name, roll_no, phone, class_id, login_id, password_hash, role, tenant_id, is_first_login, email, branch_id
      queryParams.push(name, null, null, class_id, shortId, batchHash, tenant_id, branchId);
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, 'student', $${paramIndex++}, true, NULL, $${paramIndex++})`);
      const acct = { login_id: `${tenant_id}-${shortId}`, db_login_id: shortId, name };
      if (batchTempPassword !== null) acct.temp_password = batchTempPassword;
      createdAccounts.push(acct);
    }

    const insertQuery = `
      INSERT INTO students (name, roll_no, phone, class_id, login_id, password_hash, role, tenant_id, is_first_login, email, branch_id)
      VALUES ${values.join(', ')}
      RETURNING id, login_id
    `;

    const insertResult = await client.query(insertQuery, queryParams);
    await client.query('COMMIT');

    // Map generated ids back onto the accounts by login_id (robust against row order).
    const idByLoginId = new Map();
    for (const row of insertResult.rows) {
      idByLoginId.set(row.login_id, row.id);
    }
    for (const acct of createdAccounts) {
      acct.id = idByLoginId.get(acct.db_login_id) ?? null;
      delete acct.db_login_id;
    }

    const bulkStudentBody = { success: true, accounts: createdAccounts, credentials_issued: batchTempPassword !== null };
    res.json(bulkStudentBody);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bulk create student error:', err);
    res.status(500).json({ error: 'Server error during bulk creation' });
  } finally {
    client.release();
  }
});

// POST /api/auth/bulk-create-teachers
app.post('/api/auth/bulk-create-teachers', requireAuth(['admin', 'super_admin']), bulkCreateLimiter, async (req, res) => {
  // Names-first: an explicit list. Without one the legacy count body still works
  // and generates "Teacher 1", "Teacher 2", ... placeholders.
  const names = extractBulkNames(req.body);
  const count = names ? names.length : parseInt(req.body.count, 10);
  if (isNaN(count) || count < 1) return res.status(400).json({ error: names ? 'Add at least one name first' : 'Valid count is required' });
  if (count > 500) return res.status(400).json({ error: 'Maximum 500 accounts per batch' });
  // These are read from the body below. Without this destructuring `phone` and
  // `class_id` are undefined identifiers and the insert 500s.
  const phone = req.body.phone || null;
  const class_id = req.body.class_id != null ? parseInt(req.body.class_id, 10) : null;

  const tenant_id = req.user.tenant_id;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const capErr = await capacityViolation(client, tenant_id, 'teacher', count);
    if (capErr) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: capErr });
    }

    // Same branch gate as a single teacher create.
    const branchPick = await resolveBranchForWrite(client, tenant_id, req.body.branch_id);
    if (branchPick.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: branchPick.error });
    }
    const branchId = branchPick.branch ? branchPick.branch.id : null;

    // Fill the lowest free T-number first (see nextFreeLoginNumber rationale).
    const usedLoginRows = await client.query(
      `SELECT login_id FROM teachers WHERE tenant_id = $1 AND login_id IS NOT NULL`,
      [tenant_id]
    );
    const usedLoginNums = new Set();
    for (const row of usedLoginRows.rows) {
      const m = /(?:^|-)([ST])(\d+)$/.exec(row.login_id);
      if (m && m[1] === 'T') usedLoginNums.add(parseInt(m[2], 10));
    }
    let cursor = 1;

    const createdAccounts = [];
    const values = [];
    let paramIndex = 1;
    const queryParams = [];

    // One decision for the whole batch: if the portal is off, nobody gets a password.
    const { tempPassword: batchTempPassword, passwordHash: batchHash } =
      await mintCredentialIfPortalEnabled(tenant_id, 'teacher');

    for (let i = 0; i < count; i++) {
      while (usedLoginNums.has(cursor)) cursor += 1;
      const shortId = `T${String(cursor).padStart(3, '0')}`;
      usedLoginNums.add(cursor);
      cursor += 1;
      const name = names ? names[i] : `Teacher ${i + 1}`;

      // name, phone, class_id, login_id, password_hash, role, tenant_id, is_first_login, email, branch_id
      queryParams.push(name, phone || null, class_id || null, shortId, batchHash, tenant_id, branchId);
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, 'teacher', $${paramIndex++}, true, NULL, $${paramIndex++})`);
      const acct = { login_id: `${tenant_id}-${shortId}`, name };
      if (batchTempPassword !== null) acct.temp_password = batchTempPassword;
      createdAccounts.push(acct);
    }

    const insertQuery = `
      INSERT INTO teachers (name, phone, class_id, login_id, password_hash, role, tenant_id, is_first_login, email, branch_id)
      VALUES ${values.join(', ')}
    `;

    await client.query(insertQuery, queryParams);
    await client.query('COMMIT');

    const bulkBody = { success: true, accounts: createdAccounts, credentials_issued: batchTempPassword !== null };
    res.json(bulkBody);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bulk create teacher error:', err);
    res.status(500).json({ error: 'Server error during bulk creation' });
  } finally {
    client.release();
  }
});

// This endpoint intentionally renders a one-time, no-store HTML document instead
// of returning a password in a JSON API response. It is opened by an authorized
// administrator in a separate window after they have verified the user offline.
app.post('/admin/recovery-reveal', requireAuth(['admin', 'super_admin']), requireSameOrigin, adminRecoveryLimiter, async (req, res) => {
  const targetId = Number.parseInt(req.body.target_id, 10)
  const targetRole = String(req.body.target_role || '')
  const table = tableForRole(targetRole)
  if (!Number.isInteger(targetId) || !table || targetRole === 'super_admin') {
    return res.status(400).send('Invalid recovery request')
  }
  if (req.user.role === 'admin' && !['student', 'teacher'].includes(targetRole)) {
    return res.status(403).send('You are not permitted to reset this account')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const scope = req.user.role === 'admin' ? ' AND tenant_id = $2' : ''
    const params = req.user.role === 'admin' ? [targetId, req.user.tenant_id] : [targetId]
    const target = await client.query(
      `SELECT id, name, tenant_id FROM ${table} WHERE id = $1${scope} FOR UPDATE`,
      params
    )
    if (target.rows.length !== 1) {
      await client.query('ROLLBACK')
      return res.status(404).send('Account not found')
    }
    const temporaryPassword = generateTempPassword()
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS)
    await client.query(
      `UPDATE ${table}
       SET password_hash = $1, is_first_login = true, token_generation = COALESCE(token_generation, 0) + 1
       WHERE id = $2`,
      [passwordHash, targetId]
    )
    await client.query(
      `UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND user_role = $2 AND used = false`,
      [targetId, targetRole]
    )
    await client.query(
      `INSERT INTO admin_password_reset_audit (actor_id, actor_role, target_id, target_role, tenant_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.user_id, req.user.role, targetId, targetRole, target.rows[0].tenant_id]
    )
    await client.query('COMMIT')

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'Content-Type': 'text/html; charset=utf-8'
    })
    return res.send(`<!doctype html><title>Temporary password</title><meta name="robots" content="noindex"><style>body{font-family:system-ui;max-width:560px;margin:48px auto;padding:24px;color:#172033}code{display:block;padding:18px;background:#f1f5f9;border-radius:8px;font-size:22px;word-break:break-all}.warn{color:#9a6700}</style><h1>Temporary password</h1><p>Provide this password to <strong>${escapeHtml(target.rows[0].name || 'the user')}</strong> through an approved private channel. It is shown only in this window.</p><code>${escapeHtml(temporaryPassword)}</code><p class="warn">They must change it on first login. Close this window after recording it.</p><script>window.addEventListener('pagehide',()=>document.body.textContent='Temporary password closed.');</script>`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Admin recovery error:', err.message)
    res.status(500).send('Unable to reset the password')
  } finally {
    client.release()
  }
})

// POST /api/auth/register-school
app.post('/api/auth/register-school', async (req, res) => {
  try {
    const { school_name, contact_person, role, contact_email, message } = req.body

    const normalizedContactPerson = String(contact_person || '').trim()
    const normalizedContactRole = String(role || '').trim()

    if (!school_name || !normalizedContactPerson || !normalizedContactRole || !contact_email) {
      return res.status(400).json({ error: 'School name, contact person, role, and email are required' })
    }

    const existing = await pool.query(
      'SELECT id, status FROM school_requests WHERE contact_email = $1',
      [contact_email]
    )
    if (existing.rows.length > 0) {
      const status = existing.rows[0].status
      if (status === 'pending') {
        return res.status(400).json({ error: 'A request with this email is already pending review.' })
      }
      if (status === 'approved') {
        return res.status(400).json({ error: 'This email has already been approved. Please check your login details.' })
      }
      // if rejected, allow resubmission by deleting the old rejected request first
      await pool.query('DELETE FROM school_requests WHERE id = $1', [existing.rows[0].id])
    }

    const contactPersonValue = `${normalizedContactPerson} (${normalizedContactRole})`

    await pool.query(
      `INSERT INTO school_requests (school_name, contact_person, contact_email, message, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [school_name, contactPersonValue, contact_email, message || null]
    )

    res.json({ success: true, message: 'Your request has been received. You will be contacted shortly.' })
  } catch (err) {
    console.error('Register school error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/auth/approve-school
app.post('/api/auth/approve-school', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { request_id, school_code, school_name, student_limit, teacher_limit } = req.body

    if (!request_id || !school_code || !school_name) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    const code = school_code.toUpperCase()
    if (!/^[A-Z]{4}$/.test(code)) {
      return res.status(400).json({ error: 'School code must be exactly 4 uppercase letters' })
    }

    const parsedStudentLimit = parsePositiveLimit(student_limit, DEFAULT_STUDENT_LIMIT)
    const parsedTeacherLimit = parsePositiveLimit(teacher_limit, DEFAULT_TEACHER_LIMIT)
    if (parsedStudentLimit === null) {
      return res.status(400).json({ error: 'Student capacity must be a positive whole number' })
    }
    if (parsedTeacherLimit === null) {
      return res.status(400).json({ error: 'Teacher capacity must be a positive whole number' })
    }

    const requestResult = await pool.query('SELECT contact_person, contact_email FROM school_requests WHERE id = $1', [request_id])
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'School request not found' })
    }

    const contactEmail = requestResult.rows[0].contact_email
    const contactPerson = requestResult.rows[0].contact_person || 'Admin'

    const existing = await pool.query('SELECT id FROM organizations WHERE school_code = $1', [code])
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'School code already taken' })
    }

    let tempPasswordToReturn = ''

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      await client.query(
        'INSERT INTO organizations (school_code, school_name, contact_email, status, student_limit, teacher_limit) VALUES ($1, $2, $3, $4, $5, $6)',
        [code, school_name, contactEmail, 'active', parsedStudentLimit, parsedTeacherLimit]
      )

      tempPasswordToReturn = generateTempPassword()
      const passwordHash = await bcrypt.hash(tempPasswordToReturn, BCRYPT_ROUNDS)

      await client.query(
        `INSERT INTO admins (login_id, name, email, password_hash, role, tenant_id, is_first_login, email_verified_at)
         VALUES ('ADM', $1, $2, $3, 'admin', $4, true, NULL)`,
        [contactPerson, normalizeEmail(contactEmail), passwordHash, code]
      )

      await client.query('UPDATE school_requests SET status = $1 WHERE id = $2', ['approved', request_id])

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    res.json({ success: true, admin_id: `${code}-ADM`, temp_password: tempPasswordToReturn })
  } catch (err) {
    console.error('Approve school error:', err)
    res.status(500).json({ error: 'An unexpected error occurred while approving the school. Please try again or contact support.' })
  }
})

// POST /api/auth/reject-school
app.post('/api/auth/reject-school', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { request_id } = req.body
    await pool.query('UPDATE school_requests SET status = $1 WHERE id = $2', ['rejected', request_id])
    res.json({ success: true })
  } catch (err) {
    console.error('Reject school error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET super admin data
app.get('/api/auth/pending-requests', requireAuth(['super_admin']), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM school_requests WHERE status = $1 ORDER BY created_at DESC',
      ['pending']
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/api/auth/active-schools', requireAuth(['super_admin']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM students s WHERE s.tenant_id = o.school_code) AS student_count,
              (SELECT COUNT(*) FROM teachers t WHERE t.tenant_id = o.school_code) AS teacher_count
       FROM organizations o WHERE o.status = 'active' ORDER BY o.created_at DESC`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/auth/update-school-capacity
app.post('/api/auth/update-school-capacity', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { school_code, student_limit, teacher_limit } = req.body
    const code = String(school_code || '').trim().toUpperCase()
    if (!/^[A-Z]{4}$/.test(code)) {
      return res.status(400).json({ error: 'Valid 4-letter school code is required' })
    }

    const hasStudent = !(student_limit === undefined || student_limit === null || student_limit === '')
    const hasTeacher = !(teacher_limit === undefined || teacher_limit === null || teacher_limit === '')
    if (!hasStudent && !hasTeacher) {
      return res.status(400).json({ error: 'Provide at least one capacity value' })
    }
    const parsedStudent = hasStudent ? parsePositiveLimit(student_limit, null) : undefined
    const parsedTeacher = hasTeacher ? parsePositiveLimit(teacher_limit, null) : undefined
    if (parsedStudent === null) return res.status(400).json({ error: 'Student capacity must be a positive whole number' })
    if (parsedTeacher === null) return res.status(400).json({ error: 'Teacher capacity must be a positive whole number' })

    const sets = []
    const params = []
    let index = 1
    if (parsedStudent !== undefined) {
      sets.push(`student_limit = $${index++}`)
      params.push(parsedStudent)
    }
    if (parsedTeacher !== undefined) {
      sets.push(`teacher_limit = $${index++}`)
      params.push(parsedTeacher)
    }
    params.push(code)

    const result = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE school_code = $${index} RETURNING school_code, student_limit, teacher_limit`,
      params
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'School not found' })
    }
    res.json({ success: true, school: result.rows[0] })
  } catch (err) {
    console.error('Update school capacity error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/auth/capacity
app.get('/api/auth/capacity', requireAuth(['admin']), async (req, res) => {
  try {
    const cap = await fetchCapacity(pool, req.user.tenant_id)
    if (!cap) {
      return res.status(404).json({ error: 'School not found' })
    }
    res.json(cap)
  } catch (err) {
    console.error('Fetch capacity error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// --- Branches --------------------------------------------------------------
// A school creates its own branches freely: no approval, usable immediately.
// The Super Admin only ever acts after the fact, from the review queue below.

// GET /api/branches - the caller's school. Super Admin may pass ?school=CODE to
// inspect one school, or omit it to get every branch across every school.
app.get('/api/branches', requireAuth(['admin', 'super_admin', 'coordinator']), async (req, res) => {
  try {
    // A coordinator can only ever see their own branch, whatever they ask for.
    if (isCoordinator(req.user)) {
      const own = await pool.query(
        `SELECT b.*, o.school_name FROM branches b
         JOIN organizations o ON o.school_code = b.school_id
         WHERE b.id = $1 AND b.school_id = $2`,
        [req.user.branch_id, req.user.tenant_id]
      )
      return res.json(own.rows)
    }

    if (req.user.role === 'super_admin') {
      const all = await pool.query(
        `SELECT b.*, o.school_name FROM branches b
         JOIN organizations o ON o.school_code = b.school_id
         ORDER BY (b.reviewed_at IS NULL) DESC, b.created_at DESC`
      )
      return res.json(all.rows)
    }

    const mine = await pool.query(
      `SELECT b.*, o.school_name FROM branches b
       JOIN organizations o ON o.school_code = b.school_id
       WHERE b.school_id = $1 ORDER BY b.name`,
      [req.user.tenant_id]
    )
    res.json(mine.rows)
  } catch (err) {
    console.error('Fetch branches error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/branches - school admin creates a branch, active and usable at once.
app.post('/api/branches', requireAuth(['admin']), requireWritableBranch(), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Branch name is required' })
    if (name.length > 120) return res.status(400).json({ error: 'Branch name is too long' })

    const dupe = await pool.query(
      'SELECT 1 FROM branches WHERE school_id = $1 AND lower(name) = lower($2)',
      [req.user.tenant_id, name]
    )
    if (dupe.rows.length) {
      return res.status(409).json({ error: `A branch named "${name}" already exists` })
    }

    const created = await pool.query(
      `INSERT INTO branches (name, school_id, status, created_by)
       VALUES ($1, $2, 'active', $3) RETURNING *`,
      [name, req.user.tenant_id, req.user.user_id]
    )
    // reviewed_at stays NULL on purpose: that is what puts it in the Super Admin
    // review queue as "newly created". Nothing blocks the school meanwhile.
    res.status(201).json(created.rows[0])
  } catch (err) {
    // school_id is a real foreign key, so a stale tenant can still reach the DB.
    // Report that as a bad request rather than an opaque server error.
    if (err.code === '23503') {
      return res.status(400).json({ error: 'This school account could not be found. Please sign in again.' })
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: `A branch named "${String(req.body.name || '').trim()}" already exists` })
    }
    console.error('Create branch error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/branches/:id - only the status transitions Super Admin owns.
app.patch('/api/branches/:id', requireAuth(['super_admin']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid branch' })

    const { action, reason } = req.body
    const allowed = ['review', 'flag', 'deactivate', 'reactivate']
    if (!allowed.includes(action)) {
      return res.status(400).json({ error: `Action must be one of: ${allowed.join(', ')}` })
    }
    if (action === 'deactivate' && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'A reason is required when deactivating a branch' })
    }

    const existing = await pool.query('SELECT * FROM branches WHERE id = $1', [id])
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Branch not found' })

    let updated
    if (action === 'review') {
      updated = await pool.query(
        `UPDATE branches SET reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $2 RETURNING *`,
        [req.user.user_id, id]
      )
    } else if (action === 'flag') {
      updated = await pool.query(`UPDATE branches SET status = 'flagged' WHERE id = $1 RETURNING *`, [id])
    } else if (action === 'reactivate') {
      // Reopening a branch clears the reason so the school sees a clean history.
      updated = await pool.query(
        `UPDATE branches SET status = 'active', deactivation_reason = NULL WHERE id = $1 RETURNING *`,
        [id]
      )
    } else {
      updated = await pool.query(
        `UPDATE branches SET status = 'deactivated', deactivation_reason = $1
         WHERE id = $2 RETURNING *`,
        [String(reason).trim(), id]
      )
    }

    res.json(updated.rows[0])
  } catch (err) {
    console.error('Update branch error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/branches/:id/admin - Academy Admin deactivates/reactives their own tenant's branch.
// Only allows 'deactivate' and 'reactivate' (not review/flag which Super Admin owns).
// Enforces the branch belongs to the admin's tenant.
app.patch('/api/branches/:id/admin', requireAuth(['admin']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid branch' })

    const { action, reason } = req.body
    const adminAllowed = ['deactivate', 'reactivate']
    if (!adminAllowed.includes(action)) {
      return res.status(403).json({ error: 'You do not have permission for that action.' })
    }

    // Verify this branch belongs to the admin's tenant
    const existing = await pool.query(
      'SELECT * FROM branches WHERE id = $1 AND school_id = $2',
      [id, req.user.tenant_id]
    )
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Branch not found in your academy.' })
    }

    let updated
    if (action === 'reactivate') {
      updated = await pool.query(
        `UPDATE branches SET status = 'active', deactivation_reason = NULL WHERE id = $1 RETURNING *`,
        [id]
      )
    } else {
      // deactivate — reason is optional for admin (Super Admin needs it)
      updated = await pool.query(
        `UPDATE branches SET status = 'deactivated', deactivation_reason = $1 WHERE id = $2 RETURNING *`,
        [reason ? String(reason).trim() : null, id]
      )
    }

    res.json(updated.rows[0])
  } catch (err) {
    console.error('Admin branch update error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// --- Tenant feature grants ---------------------------------------------------
// Phase 1 scope: Super Admin configures what a school is allowed to use, and the
// school admin can read its own list. This is configuration only. Nothing in the
// request path is gated on it yet - enforcement is the next layer, on purpose, so the
// switches can be switched around first and the blast radius of enforcing them later
// is a known, separate change.

// GET /api/tenant-features
//   super admin : every school, with the full feature grid
//   admin       : their own school only
// A missing grant row resolves to the feature's default, so a new school is never
// accidentally locked out of everything.
app.get('/api/tenant-features', requireAuth(['super_admin', 'admin']), async (req, res) => {
  try {
    const isSuper = req.user.role === 'super_admin'
    const params = isSuper ? [] : [req.user.tenant_id]
    const whereSchool = isSuper ? '' : 'WHERE o.school_code = $1'

    const [features, schools, grants] = await Promise.all([
      pool.query('SELECT key, label, description, default_enabled, sort_order FROM tenant_features ORDER BY sort_order, key'),
      pool.query(`SELECT o.school_code, o.school_name, o.status, o.student_limit, o.teacher_limit FROM organizations o ${whereSchool} ORDER BY o.school_name`, params),
      pool.query(
        `SELECT g.school_id, g.feature_key, g.enabled, g.updated_at, g.updated_by
         FROM tenant_grants g
         ${isSuper ? '' : 'WHERE g.school_id = $1'}
         ORDER BY g.school_id, g.feature_key`, params)
    ])

    // How many people exist, and how many are still missing a portal login. This is
    // what lets the Super Admin see, before pressing anything, exactly how many
    // credentials a button is about to hand out.
    const [studentCounts, teacherCounts, coordinatorCounts] = await Promise.all([
      pool.query(
        `SELECT tenant_id, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE login_id IS NULL OR password_hash IS NULL)::int AS needing
         FROM students ${isSuper ? '' : 'WHERE tenant_id = $1'} GROUP BY tenant_id`, params),
      pool.query(
        `SELECT tenant_id, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE login_id IS NULL OR password_hash IS NULL)::int AS needing
         FROM teachers ${isSuper ? '' : 'WHERE tenant_id = $1'} GROUP BY tenant_id`, params),
      pool.query(
        `SELECT tenant_id, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE password_hash IS NULL)::int AS needing
         FROM admins WHERE role = 'coordinator' ${isSuper ? '' : 'AND tenant_id = $1'} GROUP BY tenant_id`, params)
    ])
    const sc = new Map(studentCounts.rows.map(r => [r.tenant_id, r]))
    const tc = new Map(teacherCounts.rows.map(r => [r.tenant_id, r]))
    const cc = new Map(coordinatorCounts.rows.map(r => [r.tenant_id, r]))

    const enabled = new Map()
    for (const g of grants.rows) enabled.set(`${g.school_id}::${g.feature_key}`, g)

    const payload = schools.rows.map(school => ({
      school_id: school.school_code,
      school_name: school.school_name,
      status: school.status,
      students_total: sc.get(school.school_code) ? sc.get(school.school_code).total : 0,
      students_needing: sc.get(school.school_code) ? sc.get(school.school_code).needing : 0,
      students_limit: school.student_limit === null || school.student_limit === undefined ? null : Number(school.student_limit),
      teachers_total: tc.get(school.school_code) ? tc.get(school.school_code).total : 0,
      teachers_needing: tc.get(school.school_code) ? tc.get(school.school_code).needing : 0,
      teachers_limit: school.teacher_limit === null || school.teacher_limit === undefined ? null : Number(school.teacher_limit),
      coordinators_total: cc.get(school.school_code) ? cc.get(school.school_code).total : 0,
      coordinators_needing: cc.get(school.school_code) ? cc.get(school.school_code).needing : 0,
      features: features.rows.map(f => {
        const grant = enabled.get(`${school.school_code}::${f.key}`)
        return {
          key: f.key,
          label: f.label,
          description: f.description,
          // An explicit grant wins; otherwise fall back to the catalogue default.
          enabled: grant ? grant.enabled : f.default_enabled,
          is_default: !grant,
          updated_at: grant ? grant.updated_at : null
        }
      })
    }))

    // can_edit travels with the payload so the UI can render read-only switches
    // instead of handing out live toggles that are guaranteed to bounce off the
    // PATCH's role check. Without it a school admin just sees "Forbidden" per click.
    res.json({ can_edit: isSuper, role: req.user.role, features: features.rows, schools: payload })
  } catch (err) {
    console.error('Fetch tenant features error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/tenant-features - Super Admin only.
app.patch('/api/tenant-features', requireAuth(['super_admin']), async (req, res) => {
  try {
    const schoolId = String(req.body.school_id || '').trim()
    const key = String(req.body.feature_key || '').trim()
    if (!schoolId || !key) {
      return res.status(400).json({ error: 'school_id and feature_key are required' })
    }
    if (typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' })
    }

    const feature = await pool.query('SELECT key FROM tenant_features WHERE key = $1', [key])
    if (feature.rows.length === 0) return res.status(400).json({ error: 'Unknown feature' })

    const school = await pool.query('SELECT school_code FROM organizations WHERE school_code = $1', [schoolId])
    if (school.rows.length === 0) return res.status(404).json({ error: 'School not found' })

    // A portal can never exist without the management feature underneath it. This is a
    // hard business rule, not a convenience: the school does the managing or nobody can
    // sign in — there is no "just the portal, no management" mode. Two consequences:
    //   • switching a portal ON silently switches its management ON too
    //   • switching a management OFF silently switches its portal OFF with it
    // Both updates are returned so the UI re-renders from the payload, never from hope.
    const PORTAL_DEPENDS_ON = {
      student_portal: 'student_management',
      teacher_portal: 'teacher_management',
      coordinator_portal: 'coordinator_management'
    }
    const MANAGEMENT_OWNS = {
      student_management: 'student_portal',
      teacher_management: 'teacher_portal',
      coordinator_management: 'coordinator_portal'
    }
    const cascades = []
    const otherKeys = []
    if (req.body.enabled && PORTAL_DEPENDS_ON[key]) otherKeys.push(PORTAL_DEPENDS_ON[key])
    if (!req.body.enabled && MANAGEMENT_OWNS[key]) otherKeys.push(MANAGEMENT_OWNS[key])
    const changedPairs = [{ key, enabled: req.body.enabled }, ...otherKeys.map(k => ({ key: k, enabled: req.body.enabled }))]
    for (const pair of changedPairs) {
      const saved = await pool.query(
        `INSERT INTO tenant_grants (school_id, feature_key, enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (school_id, feature_key)
         DO UPDATE SET enabled = EXCLUDED.enabled,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = CURRENT_TIMESTAMP
         RETURNING school_id, feature_key, enabled, updated_at`,
        [schoolId, pair.key, pair.enabled, req.user.user_id]
      )
      cascades.push(saved.rows[0])
    }
    res.json({ updated: cascades })
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'That school or feature no longer exists. Please reload the page.' })
    }
    console.error('Update tenant feature error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// --- Admin Bootstrap -------------------------------------------------------
// Returns everything the admin page needs on load in one call:
// branches for the selector, feature grants for tab visibility.
// POST-only roles (coordinator, student, teacher) are intentionally excluded.
app.get('/api/admin/bootstrap', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id
    const isSuper = req.user.role === 'super_admin'

    // Branches: admins see all their own tenant's branches.
    // Super admin sees all branches across all tenants.
    let branchesQuery
    let branchesParams
    if (isSuper) {
      branchesQuery = `
        SELECT b.id, b.name, b.status, b.school_id, o.school_name
        FROM branches b
        JOIN organizations o ON o.school_code = b.school_id
        ORDER BY b.school_id, b.name`
      branchesParams = []
    } else {
      branchesQuery = `
        SELECT b.id, b.name, b.status
        FROM branches b
        WHERE b.school_id = $1
        ORDER BY b.name`
      branchesParams = [tenant_id]
    }

    // Feature grants: every feature key, with the enabled flag resolved
    // against the grant or the catalogue default.
    const grantsQuery = `
      SELECT tg.feature_key, tg.enabled
      FROM tenant_grants tg
      WHERE tg.school_id = $1`
    const featuresQuery = `
      SELECT tf.key, tf.label, tf.sort_order, tf.default_enabled
      FROM tenant_features tf
      ORDER BY tf.sort_order, tf.key`

    const [branchesResult, grantsResult, featuresResult] = await Promise.all([
      pool.query(branchesQuery, branchesParams),
      isSuper ? pool.query('SELECT school_id, feature_key, enabled FROM tenant_grants WHERE school_id = $1', [tenant_id]) : pool.query(grantsQuery, [tenant_id]),
      pool.query(featuresQuery)
    ])

    // Build enabled map: explicit grant wins, else catalogue default
    const enabledMap = new Map()
    for (const g of grantsResult.rows) {
      enabledMap.set(g.feature_key, g.enabled)
    }

    const features = featuresResult.rows.map(f => ({
      key: f.key,
      label: f.label,
      // true if there's an explicit grant set to true, or no grant but default is true
      enabled: enabledMap.has(f.key) ? enabledMap.get(f.key) : f.default_enabled
    }))

    res.json({
      branches: branchesResult.rows,
      features
    })
  } catch (err) {
    console.error('Admin bootstrap error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// --- Issuing portal credentials to people who already exist ------------------
// The case this exists for: a school has 200 students on file, none of whom were ever
// given a portal login. The school asks for the Student Portal, the Super Admin grants
// it, and then this hands the EXISTING people their credentials.
//
// It never creates a person, never deletes one, and never changes an existing login.
// It only fills in what is missing, so records keep their id, name, class, attendance
// and history exactly as they were. A student who already has a login is left alone.
app.post('/api/tenant-features/issue-credentials', requireAuth(['super_admin']), async (req, res) => {
  try {
    const schoolId = String(req.body.school_id || '').trim().toUpperCase()
    const audience = String(req.body.audience || '').trim()
    if (!schoolId || !audience) {
      return res.status(400).json({ error: 'school_id and audience are required' })
    }
    const table = audience === 'student' ? 'students'
      : audience === 'teacher' ? 'teachers'
        : null
    if (!table) return res.status(400).json({ error: 'audience must be student or teacher' })
    const prefix = audience === 'student' ? 'S' : 'T'
    const portalKey = audience === 'student' ? 'student_portal' : 'teacher_portal'
    const label = audience === 'student' ? 'Student' : 'Teacher'

    const school = await pool.query('SELECT school_code FROM organizations WHERE school_code = $1', [schoolId])
    if (school.rows.length === 0) return res.status(404).json({ error: 'School not found' })

    // The portal has to be granted before credentials mean anything, otherwise the
    // people would be handed a login that the login gate immediately refuses.
    const portal = await pool.query(
      `SELECT COALESCE(g.enabled, f.default_enabled) AS enabled
       FROM tenant_features f
       LEFT JOIN tenant_grants g ON g.feature_key = f.key AND g.school_id = $1
       WHERE f.key = $2`,
      [schoolId, portalKey]
    )
    if (portal.rows.length === 0 || portal.rows[0].enabled !== true) {
      return res.status(400).json({
        error: `Turn on the ${label} Portal for this school first, then issue credentials.`
      })
    }

    // Only rows that are genuinely missing something. An existing login_id is never
    // replaced, and a row that already has both is skipped entirely.
    const pending = await pool.query(
      `SELECT id, name, login_id FROM ${table}
       WHERE tenant_id = $1 AND (login_id IS NULL OR password_hash IS NULL)
       ORDER BY id`,
      [schoolId]
    )
    if (pending.rows.length === 0) {
      return res.json({ issued: [], count: 0, message: `Every ${label.toLowerCase()} at this school already has portal credentials.` })
    }

    // Continue the school's existing numbering (S001, S002, ...) without ever
    // colliding with a login_id that is already taken. See nextFreeLoginNumber:
    // freed numbers are reused so the sequence stays tight after deletions.
    const takenRows = await pool.query(`SELECT login_id FROM ${table} WHERE tenant_id = $1 AND login_id IS NOT NULL`, [schoolId])
    const taken = new Set(takenRows.rows.map(r => r.login_id))

    const client = await pool.connect()
    const issued = []
    try {
      await client.query('BEGIN')
      for (const person of pending.rows) {
        let loginId = person.login_id
        if (!loginId) {
          let candidate
          // Reuse the lowest free number so numbers freed by deleted accounts are
          // filled again instead of the sequence permanently marching upward.
          let n = 1
          do {
            candidate = `${prefix}${String(n).padStart(3, '0')}`
            n += 1
          } while (taken.has(candidate))
          loginId = candidate
          taken.add(candidate)
        }
        const tempPassword = generateTempPassword()
        const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS)
        await client.query(
          `UPDATE ${table} SET login_id = $1, password_hash = $2, is_first_login = true
           WHERE id = $3 AND tenant_id = $4`,
          [loginId, passwordHash, person.id, schoolId]
        )
        issued.push({ name: person.name, login_id: loginId, full_id: `${schoolId}-${loginId}`, password: tempPassword })
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    // These are the only moment the plaintext exists. It is not stored anywhere and
    // cannot be looked up again, which is why the UI downloads it immediately.
    res.json({ issued, count: issued.length, school_id: schoolId, audience })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A login ID clashed with an existing one. Please try again.' })
    }
    console.error('Issue credentials error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// --- Coordinators ----------------------------------------------------------
// A coordinator is a row in admins with role='coordinator', always tied to one
// branch, and gated by two independent grants the school controls:
//   grant_credentials  - may they log in at all
//   grant_management   - may they see the management modules
// A grant that is off is simply not rendered, not shown locked.

// GET /api/coordinators - list for the school admin, with grant state.
// The whole module is gated: when the Super Admin has switched the Coordinator
// Portal off for this school, the list is simply not there to be seen.
app.get('/api/coordinators', requireAuth(['admin']), async (req, res) => {
  try {
    const portalOn = await isPortalEnabled(req.user.tenant_id, 'coordinator')
    if (!portalOn) {
      return res.status(403).json({ error: 'The Coordinator Portal is not enabled for your school. Please contact your Super Admin.' })
    }
    const result = await pool.query(
      `SELECT a.id, a.name, a.login_id, a.phone, a.branch_id, a.is_first_login,
              a.grant_management, a.grant_credentials, a.created_at,
              b.name AS branch_name, b.status AS branch_status
       FROM admins a
       LEFT JOIN branches b ON b.id = a.branch_id
       WHERE a.tenant_id = $1 AND a.role = 'coordinator'
       ORDER BY a.name`,
      [req.user.tenant_id]
    )
    // Hand the school the FULL login ID (school code + short ID, e.g. ALIR-C001)
    // everywhere a credential is shown, because that is what the sign-in form
    // actually accepts. The short ID alone is only meaningful inside the DB.
    const rows = result.rows.map(c => ({
      ...c,
      full_id: c.login_id ? `${req.user.tenant_id}-${c.login_id}` : null
    }))
    res.json(rows)
  } catch (err) {
    console.error('Fetch coordinators error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/coordinators - create a coordinator, optionally with a login.
// A branch is NOT required to exist: a coordinator without one is appointed
// school-wide. When the school has exactly one branch the admin can leave the
// picker empty and they are appointed to it automatically.
app.post('/api/coordinators', requireAuth(['admin']), async (req, res) => {
  try {
    const portalOn = await isPortalEnabled(req.user.tenant_id, 'coordinator')
    if (!portalOn) {
      return res.status(403).json({ error: 'The Coordinator Portal is not enabled for your school. Please contact your Super Admin.' })
    }
    const name = String(req.body.name || '').trim()
    const phone = String(req.body.phone || '').trim() || null
    const grantManagement = req.body.grant_management === true
    const grantCredentials = req.body.grant_credentials === true

    if (!name) return res.status(400).json({ error: 'Name is required' })

    // Branch is optional. With no branches at all the coordinator is appointed
    // to the whole school; with exactly one branch an empty pick appoints them
    // there automatically; with several, the admin chooses.
    let branchId = null
    if (req.body.branch_id !== undefined && req.body.branch_id !== null && req.body.branch_id !== '') {
      const branchCheck = await resolveBranchForWrite(pool, req.user.tenant_id, req.body.branch_id)
      if (branchCheck.error) return res.status(400).json({ error: branchCheck.error })
      branchId = branchCheck.branch ? branchCheck.branch.id : null
      if (!branchId) {
        return res.status(400).json({ error: 'That branch could not be found.' })
      }
    } else {
      const branchList = await pool.query(
        'SELECT id FROM branches WHERE school_id = $1 AND status <> \'deactivated\' ORDER BY id',
        [req.user.tenant_id]
      )
      if (branchList.rows.length === 1) {
        branchId = branchList.rows[0].id   // auto-appoint to the only branch
      }
      // 0 branches -> school-wide (null); 2+ -> stays school-wide unless the admin picks one.
    }

    // Credentials are optional. Without them the coordinator is a person record
    // with no login, which is exactly "management without accounts".
    let loginId = null
    let passwordHash = null
    if (grantCredentials) {
      const seq = await pool.query(
        `SELECT login_id FROM admins
         WHERE tenant_id = $1 AND (login_id LIKE 'C%' OR login_id LIKE $2)
         ORDER BY login_id DESC LIMIT 1`,
        [req.user.tenant_id, `C${req.user.tenant_id}%`]
      )
      let nextNum = 1
      if (seq.rows.length > 0) {
        const n = parseInt(String(seq.rows[0].login_id).replace(/^C/, ''), 10)
        if (Number.isFinite(n)) nextNum = n + 1
      }
      loginId = `C${String(nextNum).padStart(3, '0')}`
      const tempPassword = `Eye${String(nextNum).padStart(3, '0')}@${String(Math.floor(1000 + Math.random() * 9000))}`
      passwordHash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS)

      const taken = await pool.query('SELECT 1 FROM admins WHERE tenant_id = $1 AND login_id = $2', [req.user.tenant_id, loginId])
      if (taken.rows.length) return res.status(409).json({ error: `Login ID ${loginId} is already taken. Try again.` })

    // The password hash never leaves the server. The plaintext goes back exactly once,
    // in the credentials block, so the school can hand it over and then forget it.
    // Every RETURNING list below names its columns explicitly instead of using
    // RETURNING *, which is what kept the hash out of the response.
    const created = await pool.query(
        `INSERT INTO admins (login_id, name, password_hash, role, tenant_id, branch_id,
                             grant_management, grant_credentials, is_first_login, phone)
         VALUES ($1, $2, $3, 'coordinator', $4, $5, $6, $7, true, $8)
         RETURNING id, login_id, name, role, tenant_id, branch_id, grant_management,
                   grant_credentials, is_first_login, phone, email, email_verified_at,
                   token_generation, created_at`,
        [loginId, name, passwordHash, req.user.tenant_id, branchId, grantManagement, grantCredentials, phone]
      )
      // Returned once, at creation only, so the school can hand it over - as the
      // FULL ID (e.g. ALIR-C001), which is what the coordinator types to sign in.
      return res.status(201).json({
        coordinator: created.rows[0],
        credentials: { login_id: loginId, full_id: `${req.user.tenant_id}-${loginId}`, password: tempPassword }
      })
    }

    const created = await pool.query(
      `INSERT INTO admins (login_id, name, role, tenant_id, branch_id,
                           grant_management, grant_credentials, is_first_login, phone)
       VALUES ($1, $2, 'coordinator', $3, $4, $5, false, true, $6)
       RETURNING id, login_id, name, role, tenant_id, branch_id, grant_management,
                 grant_credentials, is_first_login, phone, email, email_verified_at,
                 token_generation, created_at`,
      [null, name, req.user.tenant_id, branchId, grantManagement, phone]
    )
    res.status(201).json({ coordinator: created.rows[0], credentials: null })
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'This branch could not be found. Please reload the page.' })
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That login ID is already taken. Please try again.' })
    }
    console.error('Create coordinator error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PATCH /api/coordinators/:id - change branch or grants. The grant checkboxes
// stay editable so a school can widen access later without recreating anyone.
app.patch('/api/coordinators/:id', requireAuth(['admin']), async (req, res) => {
  try {
    const portalOn = await isPortalEnabled(req.user.tenant_id, 'coordinator')
    if (!portalOn) {
      return res.status(403).json({ error: 'The Coordinator Portal is not enabled for your school. Please contact your Super Admin.' })
    }
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coordinator' })

    const existing = await pool.query(
      `SELECT * FROM admins WHERE id = $1 AND tenant_id = $2 AND role = 'coordinator'`,
      [id, req.user.tenant_id]
    )
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Coordinator not found' })

    const current = existing.rows[0]
    const { name, phone, grant_management, grant_credentials, branch_id } = req.body

    // Branch handling: omitted = keep current. An explicit null moves the
    // coordinator school-wide; an explicit id re-appoints them to that branch.
    let branchId = current.branch_id
    if (branch_id === null) {
      branchId = null
    } else if (branch_id !== undefined) {
      const check = await resolveBranchForWrite(pool, req.user.tenant_id, branch_id)
      if (check.error) return res.status(400).json({ error: check.error })
      if (!check.branch) return res.status(400).json({ error: 'That branch could not be found.' })
      branchId = check.branch.id
    }

    const nextManagement = grant_management === undefined ? current.grant_management : grant_management === true
    const nextCredentials = grant_credentials === undefined ? current.grant_credentials : grant_credentials === true

    // Turning credentials on for someone who has no login yet has to mint one.
    if (nextCredentials && !current.login_id) {
      return res.status(400).json({
        error: 'This coordinator has no login yet. Remove and recreate them with "Give login" enabled to generate credentials.'
      })
    }

    // A live JWT carries the old branch_id and the old grants, and requireAuth only
    // compares token_generation. Moving the coordinator to another branch, or taking a
    // permission away, would otherwise keep working until the token expired. Bump the
    // generation on any real change so the old token is dead immediately; the
    // coordinator is bounced to the login page and gets fresh claims.
    const permissionsChanged =
      branchId !== current.branch_id ||
      nextManagement !== current.grant_management ||
      nextCredentials !== current.grant_credentials

    const updated = await pool.query(
      `UPDATE admins SET name = $1, phone = $2, branch_id = $3,
                         grant_management = $4, grant_credentials = $5,
                         token_generation = token_generation + $6
       WHERE id = $7
       RETURNING id, login_id, name, role, tenant_id, branch_id, grant_management,
                 grant_credentials, is_first_login, phone, email, email_verified_at,
                 token_generation, created_at`,
      [
        name !== undefined ? String(name).trim() || current.name : current.name,
        phone !== undefined ? (String(phone).trim() || null) : current.phone,
        branchId, nextManagement, nextCredentials, permissionsChanged ? 1 : 0, id
      ]
    )
    res.json({ ...updated.rows[0], sessions_revoked: permissionsChanged })
  } catch (err) {
    console.error('Update coordinator error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

// DELETE /api/coordinators/:id - remove a coordinator from the school.
// branches.created_by is a plain INTEGER with no FK, so nothing has to be
// cleared first; the row going away is what kills their login, because every
// request reads admins on the way in and can no longer find a session.
app.delete('/api/coordinators/:id', requireAuth(['admin']), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coordinator' })

    const existing = await pool.query(
      `SELECT id, name FROM admins WHERE id = $1 AND tenant_id = $2 AND role = 'coordinator'`,
      [id, req.user.tenant_id]
    )
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Coordinator not found' })

    await pool.query(`DELETE FROM admins WHERE id = $1 AND tenant_id = $2`, [id, req.user.tenant_id])
    res.json({ success: true, deleted: existing.rows[0].name })
  } catch (err) {
    console.error('Delete coordinator error:', err)
    res.status(500).json({ error: 'Failed to delete coordinator: ' + err.message })
  }
})

// GET /api/coordinator/me - everything the coordinator's own page needs.
// Only the modules their grants allow are returned, so the UI never has to
// decide what to hide and a crafted request cannot reach anything extra.
app.get('/api/coordinator/me', requireAuth(['coordinator']), async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id
    const branch_id = req.user.branch_id

    // A coordinator with no branch is appointed to the whole school, so there is
    // no branch row to fetch: the payload simply omits it and the UI says so.
    let branch = { rows: [] }
    if (branch_id) {
      branch = await pool.query(
        `SELECT b.id, b.name, b.status, b.deactivation_reason
         FROM branches b WHERE b.id = $1 AND b.school_id = $2`,
        [branch_id, tenant_id]
      )
      if (branch.rows.length === 0) {
        return res.status(403).json({ error: 'Your branch is no longer available. Contact your admin.' })
      }
    }

    const me = await pool.query(
      'SELECT name, login_id FROM admins WHERE id = $1 AND tenant_id = $2',
      [req.user.user_id, tenant_id]
    )

    const payload = {
      profile: me.rows[0] || { name: 'Coordinator', login_id: '' },
      // null branch = appointed school-wide; the UI renders that as its own mode.
      branch: branch.rows[0] || null,
      grants: {
        management: req.user.grant_management === true,
        credentials: req.user.grant_credentials === true
      }
    }

    // Teachers are always provided now (read-only for coordinators without management grant)
    const teachers = branch_id
      ? await pool.query(
          `SELECT id, name FROM teachers WHERE tenant_id = $1 AND branch_id = $2 ORDER BY name`,
          [tenant_id, branch_id]
        )
      : await pool.query(
          `SELECT id, name FROM teachers WHERE tenant_id = $1 ORDER BY name`,
          [tenant_id]
        )
    payload.teachers = teachers.rows

    // Classes are always provided: attendance is the coordinator's core job, so
    // the class filter must work even when the management grant is switched off.
    // Branch-scoped coordinators get their branch's classes; school-wide ones
    // get every class of the school.
    const classes = branch_id
      ? await pool.query(
          `SELECT id, name, section FROM classes WHERE tenant_id = $1 AND branch_id = $2 ORDER BY name`,
          [tenant_id, branch_id]
        )
      : await pool.query(
          `SELECT id, name, section FROM classes WHERE tenant_id = $1 ORDER BY name`,
          [tenant_id]
        )
    payload.classes = classes.rows

    res.json(payload)
  } catch (err) {
    console.error('Coordinator profile error:', err)
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/api/auth/suspended-schools', requireAuth(['super_admin']), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM organizations WHERE status = 'suspended' ORDER BY created_at DESC"
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/api/auth/suspend-school', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { school_id } = req.body
    await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [school_id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/api/auth/reactivate-school', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { school_id } = req.body
    await pool.query("UPDATE organizations SET status = 'active' WHERE id = $1", [school_id])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})


// ============================================
// PROTECTED EXISTING ROUTES
// ============================================

// CLASSES
app.get('/api/classes/me', requireAuth(['student']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const studentResult = await pool.query(
    'SELECT class_id FROM students WHERE id = $1 AND tenant_id = $2',
    [req.user.user_id, tenant_id]
  )

  if (studentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Student not found' })
  }

  const classId = studentResult.rows[0].class_id
  if (!classId) {
    return res.status(404).json({ error: 'No class assigned' })
  }

  const result = await pool.query(
    'SELECT * FROM classes WHERE id = $1 AND tenant_id = $2',
    [classId, tenant_id]
  )

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Class not found' })
  }

  res.json(result.rows[0])
})

app.get('/api/classes', requireAuth(['admin', 'teacher', 'super_admin']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const { branch_id } = req.query

  let effectiveBranchId = null
  if (branch_id !== undefined && branch_id !== null && branch_id !== 'all' && branch_id !== '') {
    const parsed = parseInt(branch_id, 10)
    if (Number.isInteger(parsed) && parsed > 0) effectiveBranchId = parsed
  }

  let result
  if (effectiveBranchId) {
    result = await pool.query(
      'SELECT * FROM classes WHERE tenant_id = $1 AND branch_id = $2 ORDER BY id',
      [tenant_id, effectiveBranchId]
    )
  } else {
    result = await pool.query(
      'SELECT * FROM classes WHERE tenant_id = $1 ORDER BY id',
      [tenant_id]
    )
  }
  res.json(result.rows)
})

app.post('/api/classes', requireAuth(['admin', 'super_admin']), async (req, res) => {
  const { name } = req.body
  const tenant_id = req.user.tenant_id
  const section = typeof req.body.section === 'string' ? req.body.section.trim() || null : null
  if (section && section.length > 50) {
    return res.status(400).json({ error: 'Section must be 50 characters or fewer' })
  }
  // Same branch rule as students and teachers: optional with no branches,
  // required once the school has at least one.
  const branchPick = await resolveBranchForWrite(pool, tenant_id, req.body.branch_id)
  if (branchPick.error) return res.status(400).json({ error: branchPick.error })
  const branchId = branchPick.branch ? branchPick.branch.id : null
  const result = await pool.query(
    'INSERT INTO classes (name, section, tenant_id, branch_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, section, tenant_id, branchId]
  )
  res.json(result.rows[0])
})

app.delete('/api/classes/:id', requireAuth(['admin', 'super_admin']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const classId = parseInt(req.params.id, 10)
  if (!classId) return res.status(400).json({ error: 'Invalid class id' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const classResult = await client.query(
      'SELECT id FROM classes WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [classId, tenant_id]
    )
    if (classResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Class not found' })
    }

    await client.query(
      'UPDATE students SET class_id = NULL WHERE class_id = $1 AND tenant_id = $2',
      [classId, tenant_id]
    )
    await client.query(
      'UPDATE teachers SET class_id = NULL WHERE class_id = $1 AND tenant_id = $2',
      [classId, tenant_id]
    )
    await client.query('UPDATE homework SET class_id = NULL WHERE class_id = $1', [classId])
    await client.query('UPDATE announcements SET class_id = NULL WHERE class_id = $1', [classId])
    await client.query('DELETE FROM classes WHERE id = $1 AND tenant_id = $2', [classId, tenant_id])
    await client.query('COMMIT')
    res.json({ success: true, students_unassigned: true })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Error deleting class:', err)
    res.status(500).json({ error: 'Failed to delete class' })
  } finally {
    client.release()
  }
})

// Assign a teacher to a class. The class<->teacher link lives on teachers.class_id,
// so this clears any previous holder of the class and points the new teacher at it.
app.post('/api/classes/:id/assign-teacher', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id
    const classId = parseInt(req.params.id, 10)
    if (!classId) return res.status(400).json({ error: 'Invalid class id' })

    const classCheck = await pool.query(
      'SELECT id FROM classes WHERE id = $1 AND tenant_id = $2', [classId, tenant_id]
    )
    if (classCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Class not found' })
    }

    const rawTeacherId = req.body ? req.body.teacher_id : null
    const teacherId = rawTeacherId === null || rawTeacherId === undefined || rawTeacherId === ''
      ? null
      : parseInt(rawTeacherId, 10)

    if (teacherId !== null) {
      if (Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher id' })
      const teacherCheck = await pool.query(
        'SELECT id FROM teachers WHERE id = $1 AND tenant_id = $2', [teacherId, tenant_id]
      )
      if (teacherCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Teacher not found' })
      }
    }

    await pool.query(
      'UPDATE teachers SET class_id = NULL WHERE class_id = $1 AND tenant_id = $2',
      [classId, tenant_id]
    )

    if (teacherId !== null) {
      await pool.query(
        'UPDATE teachers SET class_id = $1 WHERE id = $2 AND tenant_id = $3',
        [classId, teacherId, tenant_id]
      )
    }

    res.json({ success: true, class_id: classId, teacher_id: teacherId })
  } catch (err) {
    console.error('Error assigning teacher to class:', err)
    res.status(500).json({ error: 'Failed to assign teacher: ' + err.message })
  }
})

// Update a class (name and optional section).
app.put('/api/classes/:id', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id
    const classId = parseInt(req.params.id, 10)
    if (!classId) return res.status(400).json({ error: 'Invalid class id' })

    const { name } = req.body
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Class name is required' })
    }

    const hasSection = Object.prototype.hasOwnProperty.call(req.body, 'section')
    const section = typeof req.body.section === 'string' ? req.body.section.trim() || null : null
    if (section && section.length > 50) {
      return res.status(400).json({ error: 'Section must be 50 characters or fewer' })
    }
    const sectionUpdate = hasSection ? ', section = $2' : ''
    const params = hasSection
      ? [String(name).trim(), section, classId, tenant_id]
      : [String(name).trim(), classId, tenant_id]
    const result = await pool.query(
      `UPDATE classes SET name = $1${sectionUpdate} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
      params
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Class not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error('Error updating class:', err)
    res.status(500).json({ error: 'Failed to update class: ' + err.message })
  }
})

// TEACHERS
app.get('/api/teachers', requireAuth(['admin', 'teacher', 'student', 'super_admin']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const { class_id, branch_id } = req.query
  let effectiveClassId = class_id

  // Parse branch_id: 'all' or absent means all branches (admin view).
  let effectiveBranchId = null
  if (branch_id !== undefined && branch_id !== null && branch_id !== 'all' && branch_id !== '') {
    const parsed = parseInt(branch_id, 10)
    if (Number.isInteger(parsed) && parsed > 0) effectiveBranchId = parsed
  }

  if (req.user.role === 'student') {
    if (!class_id) {
      return res.status(400).json({ error: 'class_id is required' })
    }

    const studentResult = await pool.query(
      'SELECT class_id FROM students WHERE id = $1 AND tenant_id = $2',
      [req.user.user_id, tenant_id]
    )

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' })
    }

    const studentClassId = studentResult.rows[0].class_id
    if (Number(class_id) !== Number(studentClassId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    // Always scope students to their own class, regardless of what was passed in.
    effectiveClassId = studentClassId
  }

  const params = [tenant_id]
  // Students only need display details for their own class teacher.
  const columns = req.user.role === 'student'
      ? `teachers.id, teachers.name, teachers.phone, teachers.class_id, classes.name as class_name, classes.section as class_section`
    : `teachers.id, teachers.name, teachers.phone, teachers.class_id, teachers.login_id,
           teachers.role, teachers.tenant_id, teachers.is_first_login, teachers.email,
        teachers.email_verified_at, teachers.created_at, teachers.is_frozen, classes.name as class_name, classes.section as class_section,
           teachers.branch_id, branches.name as branch_name`

  let query = `
    SELECT ${columns}
    FROM teachers
    LEFT JOIN classes ON teachers.class_id = classes.id
    LEFT JOIN branches ON teachers.branch_id = branches.id
    WHERE teachers.tenant_id = $1
  `

  if (effectiveClassId) {
    query += ' AND teachers.class_id = $2'
    params.push(effectiveClassId)
  }

  if (effectiveBranchId) {
    params.push(effectiveBranchId)
    query += ` AND teachers.branch_id = $${params.length}`
  }

  query += ' ORDER BY teachers.id'

  const result = await pool.query(query, params)
  res.json(result.rows)
})

app.post('/api/teachers', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { name, phone, class_id } = req.body
    const tenant_id = req.user.tenant_id
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Teacher name is required' })
    const capErr = await capacityViolation(pool, tenant_id, 'teacher')
    if (capErr) return res.status(400).json({ error: capErr })

    const branchPick = await resolveBranchForWrite(pool, tenant_id, req.body.branch_id)
    if (branchPick.error) return res.status(400).json({ error: branchPick.error })

    // One teacher per class.
    if (class_id) {
      const prev = await pool.query(
        'SELECT id FROM teachers WHERE class_id = $1 AND tenant_id = $2', [class_id, tenant_id]
      )
      for (const h of prev.rows) {
        await pool.query('UPDATE teachers SET class_id = NULL WHERE id = $1', [h.id])
      }
    }

    const result = await pool.query(
      'INSERT INTO teachers (name, phone, class_id, tenant_id, branch_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [String(name).trim(), phone, class_id || null, tenant_id, branchPick.branch ? branchPick.branch.id : null]
    )
    res.json({ ...result.rows[0], capacity_notice: await capacityNotice(pool, tenant_id, 'teacher') })
  } catch (err) {
    if (err.code === '23505' && String(err.constraint || '').includes('one_class_per_tenant')) {
      return res.status(400).json({ error: 'That class already has a teacher assigned.' })
    }
    console.error('Error creating teacher:', err)
    res.status(500).json({ error: 'Failed to create teacher: ' + err.message })
  }
})

app.put('/api/teachers/:id', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { name, phone, class_id, is_frozen } = req.body
    const rawEmail = req.body.email
    // Only call normalizeEmail when the field is a non-empty string (not null/undefined/empty)
    // normalizeEmail(String(null)) = "null" → fails regex → undefined ❌
    // normalizeEmail(undefined)  = "undefined" → fails regex → undefined ❌
    let email = null
    if (typeof rawEmail === 'string' && rawEmail.trim()) {
      const normalized = normalizeEmail(rawEmail)
      if (normalized === undefined) return res.status(400).json({ error: 'Enter a valid email address' })
      email = normalized
    }
    const tenant_id = req.user.tenant_id

    // Only touch branch_id when the client sends it, so an ordinary edit never knocks a
    // teacher out of their branch. SET and the parameter list are built together.
    let branchClause = ''
    const params = [name, phone, class_id || null, email, req.params.id, tenant_id, is_frozen === true]
    if (req.body.branch_id !== undefined) {
      const branchPick = await resolveBranchForWrite(pool, tenant_id, req.body.branch_id)
      if (branchPick.error) return res.status(400).json({ error: branchPick.error })
      branchClause = `, branch_id = $${params.length + 1}`
      params.push(branchPick.branch ? branchPick.branch.id : null)
    }

    // One teacher per class: hand the class over rather than creating a second holder.
    if (class_id) {
      const prev = await pool.query(
        'SELECT id FROM teachers WHERE class_id = $1 AND tenant_id = $2 AND id <> $3',
        [class_id, tenant_id, req.params.id]
      )
      for (const h of prev.rows) {
        await pool.query('UPDATE teachers SET class_id = NULL WHERE id = $1', [h.id])
      }
    }

    const result = await pool.query(
      `UPDATE teachers SET name=$1, phone=$2, class_id=$3, email=$4::text,
     is_frozen=$7,
     email_verified_at = CASE WHEN email IS NOT DISTINCT FROM $4::text THEN email_verified_at ELSE NULL END${branchClause}
     WHERE id=$5 AND tenant_id=$6
     RETURNING id, name, phone, class_id, login_id, role, tenant_id, is_first_login, email, email_verified_at, is_frozen, created_at, branch_id,
       (SELECT b.name FROM branches b WHERE b.id = teachers.branch_id) AS branch_name`,
      params
    )
    if (result.rows[0]?.email && !result.rows[0].email_verified_at) issueEmailVerification(result.rows[0]).catch(err => console.error('Verification email send failed:', err.message))
    res.json(result.rows[0])
  } catch (err) {
    if (err.code === '23505' && String(err.constraint || '').includes('one_class_per_tenant')) {
      return res.status(400).json({ error: 'That class already has a teacher assigned.' })
    }
    console.error('Error updating teacher:', err)
    res.status(500).json({ error: 'Failed to update teacher: ' + err.message })
  }
})

app.delete('/api/teachers/:id', requireAuth(['admin', 'super_admin']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  // The homework/announcements tables hold a teacher_id FK, so clear references
  // first to avoid a constraint error - same pattern as the student delete below.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE homework SET teacher_id = NULL WHERE teacher_id = $1 AND tenant_id = $2', [req.params.id, tenant_id])
    await client.query('UPDATE announcements SET teacher_id = NULL WHERE teacher_id = $1 AND tenant_id = $2', [req.params.id, tenant_id])
    const result = await client.query('DELETE FROM teachers WHERE id = $1 AND tenant_id = $2', [req.params.id, tenant_id])
    await client.query('COMMIT')
    res.json({ success: true })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Error deleting teacher:', err)
    res.status(500).json({ error: 'Failed to delete teacher: ' + err.message })
  } finally {
    client.release()
  }
})

// STUDENTS
app.get('/api/students/me', requireAuth(['student']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const result = await pool.query(
    'SELECT id, name, roll_no, phone, class_id, login_id, role, tenant_id, is_first_login, email, email_verified_at, is_frozen, created_at FROM students WHERE id = $1 AND tenant_id = $2',
    [req.user.user_id, tenant_id]
  )

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Student not found' })
  }

  res.json(result.rows[0])
})

app.get('/api/students', requireAuth(['admin', 'teacher', 'student', 'super_admin', 'coordinator']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const { class_id, branch_id } = req.query

  // Parse branch_id: 'all' or absent means all branches (admin view).
  // A specific integer means filter to that branch.
  // A coordinator is always pinned to their own branch here, whatever the
  // client asks for, so the branch scope is enforced by the database filter.
  let effectiveBranchId = null
  if (branch_id !== undefined && branch_id !== null && branch_id !== 'all' && branch_id !== '') {
    const parsed = parseInt(branch_id, 10)
    if (Number.isInteger(parsed) && parsed > 0) effectiveBranchId = parsed
  }
  const coordinatorBranch = branchFilter(req.user)
  if (coordinatorBranch) effectiveBranchId = coordinatorBranch

  // A branch-scoped coordinator may only list students of classes inside their
  // branch, so a class id from another branch can never leak its roster. A
  // school-wide coordinator (no branch) may see every class of the school.
  if (coordinatorBranch && class_id) {
    const classCheck = await pool.query(
      'SELECT id FROM classes WHERE id = $1 AND tenant_id = $2 AND branch_id = $3',
      [class_id, tenant_id, coordinatorBranch]
    )
    if (classCheck.rows.length === 0) {
      return res.status(403).json({ error: 'This class does not belong to your branch.' })
    }
  }

  // branch_name comes along so the admin table can label a row without a second request.
  const columns = `id, name, roll_no, phone, class_id, login_id, role, tenant_id,
                   is_first_login, email, email_verified_at, is_frozen, created_at,
                   branch_id, (SELECT b.name FROM branches b WHERE b.id = students.branch_id) AS branch_name`
  let result
  if (class_id && effectiveBranchId) {
    result = await pool.query(
      `SELECT ${columns} FROM students WHERE tenant_id = $1 AND class_id = $2 AND branch_id = $3 ORDER BY id`,
      [tenant_id, class_id, effectiveBranchId]
    )
  } else if (class_id) {
    result = await pool.query(
      `SELECT ${columns} FROM students WHERE tenant_id = $1 AND class_id = $2 ORDER BY id`,
      [tenant_id, class_id]
    )
  } else if (effectiveBranchId) {
    result = await pool.query(
      `SELECT ${columns} FROM students WHERE tenant_id = $1 AND branch_id = $2 ORDER BY id`,
      [tenant_id, effectiveBranchId]
    )
  } else {
    result = await pool.query(
      `SELECT ${columns} FROM students WHERE tenant_id = $1 ORDER BY id`,
      [tenant_id]
    )
  }
  res.json(result.rows)
})

app.get('/api/students/:id', requireAuth(['admin', 'teacher', 'super_admin']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const result = await pool.query(
    `SELECT id, name, roll_no, phone, class_id, login_id, role, tenant_id, is_first_login,
            email, email_verified_at, is_frozen, created_at, branch_id,
            (SELECT b.name FROM branches b WHERE b.id = students.branch_id) AS branch_name
     FROM students WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant_id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Student not found' })
  res.json(result.rows[0])
})

app.post('/api/students', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { name, roll_no, phone, class_id } = req.body
    const tenant_id = req.user.tenant_id
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Student name is required' })
    const capErr = await capacityViolation(pool, tenant_id, 'student')
    if (capErr) return res.status(400).json({ error: capErr })

    const branchPick = await resolveBranchForWrite(pool, tenant_id, req.body.branch_id)
    if (branchPick.error) return res.status(400).json({ error: branchPick.error })

    const dupErr = await findStudentDuplicate(pool, tenant_id, { roll_no, name })
    if (dupErr) return res.status(400).json({ error: dupErr })

    const result = await pool.query(
      'INSERT INTO students (name, roll_no, phone, class_id, tenant_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [String(name).trim(), roll_no, phone, class_id, tenant_id, branchPick.branch ? branchPick.branch.id : null]
    )
    res.json({ ...result.rows[0], capacity_notice: await capacityNotice(pool, tenant_id, 'student') })
  } catch (err) {
    if (err.code === '23505' && String(err.constraint || '').includes('roll')) {
      return res.status(400).json({ error: `Roll number "${roll_no}" is already used by another student in this school. Please choose a different one.` })
    }
    console.error('Error creating student:', err)
    res.status(500).json({ error: 'Failed to create student: ' + err.message })
  }
})

app.put('/api/students/:id', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { name, roll_no, phone, class_id, is_frozen } = req.body
    const rawEmail = req.body.email
    // Only call normalizeEmail when the field is a non-empty string (not null/undefined/empty)
    // normalizeEmail(String(null)) = "null" → fails regex → undefined ❌
    // normalizeEmail(undefined)  = "undefined" → fails regex → undefined ❌
    let email = null
    if (typeof rawEmail === 'string' && rawEmail.trim()) {
      const normalized = normalizeEmail(rawEmail)
      if (normalized === undefined) return res.status(400).json({ error: 'Enter a valid email address' })
      email = normalized
    }
    const tenant_id = req.user.tenant_id
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid student id' })
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Student name is required' })

    // branch_id is only touched when the client actually sends it. An edit that omits
    // it (the common case - the admin is fixing a phone number) must not silently drop
    // a student back out of their branch. The SET list and the parameter list are built
    // together, because Postgres rejects a statement handed more values than it names.
    let branchClause = ''
    let branchValue = null
    const params = [String(name).trim(), roll_no, phone, class_id, email, id, tenant_id, is_frozen === true]
    if (req.body.branch_id !== undefined) {
      const branchPick = await resolveBranchForWrite(pool, tenant_id, req.body.branch_id)
      if (branchPick.error) return res.status(400).json({ error: branchPick.error })
      branchClause = `, branch_id = $${params.length + 1}`
      params.push(branchPick.branch ? branchPick.branch.id : null)
    }

    // Ignore this student's own row so re-saving unchanged values is allowed.
    const dupErr = await findStudentDuplicate(pool, tenant_id, { roll_no, name }, id)
    if (dupErr) return res.status(400).json({ error: dupErr })

    const result = await pool.query(
      `UPDATE students SET name=$1, roll_no=$2, phone=$3, class_id=$4, email=$5::text,
     is_frozen=$8,
     email_verified_at = CASE WHEN email IS NOT DISTINCT FROM $5::text THEN email_verified_at ELSE NULL END${branchClause}
     WHERE id=$6 AND tenant_id=$7
     RETURNING id, name, roll_no, phone, class_id, login_id, role, tenant_id, is_first_login, email, email_verified_at, is_frozen, created_at, branch_id,
       (SELECT b.name FROM branches b WHERE b.id = students.branch_id) AS branch_name`,
      params
    )
    if (result.rows[0]?.email && !result.rows[0].email_verified_at) issueEmailVerification(result.rows[0]).catch(err => console.error('Verification email send failed:', err.message))
    res.json(result.rows[0])
  } catch (err) {
    if (err.code === '23505' && String(err.constraint || '').includes('roll')) {
      return res.status(400).json({ error: `Roll number "${roll_no}" is already used by another student in this school. Please choose a different one.` })
    }
    console.error('Error updating student:', err)
    res.status(500).json({ error: 'Failed to update student: ' + err.message })
  }
})

// Name-only update. Unlike PUT /api/students/:id (a full replace that would clobber
// is_frozen / email / roll_no / class_id), this touches the name column alone.
app.put('/api/students/:id/name', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid student id' })

    const name = typeof req.body.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : ''
    if (!name) return res.status(400).json({ error: 'Name is required' })
    if (name.length > 100) return res.status(400).json({ error: 'Name must be 100 characters or fewer' })

    const dupErr = await findStudentDuplicate(pool, tenant_id, { name }, id)
    if (dupErr) return res.status(400).json({ error: dupErr })

    const result = await pool.query(
      'UPDATE students SET name = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, name',
      [name, id, tenant_id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' })
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error('Error renaming student:', err)
    res.status(500).json({ error: 'Failed to rename student: ' + err.message })
  }
})

app.delete('/api/students/:id', requireAuth(['admin', 'super_admin']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const studentId = req.params.id
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // fee_payments has no foreign key to students, so deleting a student used to
    // leave the payment rows behind. They then vanished from the fee list (which
    // joins students) while the money was still counted as never collected.
    // attendance does have a FK with NO ACTION, so clear it first to avoid a
    // constraint error. Both scoped to the caller's tenant.
    await client.query('DELETE FROM fee_payments WHERE student_id = $1 AND tenant_id = $2', [studentId, tenant_id])
    await client.query('DELETE FROM attendance WHERE student_id = $1 AND tenant_id = $2', [studentId, tenant_id])
    const result = await client.query('DELETE FROM students WHERE id = $1 AND tenant_id = $2', [studentId, tenant_id])
    await client.query('COMMIT')
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Student not found' })
    }
    res.json({ success: true })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Error deleting student:', err)
    res.status(500).json({ error: 'Failed to delete student: ' + err.message })
  } finally {
    client.release()
  }
})

// ATTENDANCE
// The batch endpoint kept for older clients. It has no branch picker, so each row
// simply inherits the branch of the student it marks. A coordinator's own branch is
// enforced by requireWritableBranch() below, which stops writes once the Super Admin
// deactivates that branch.
app.post('/api/attendance', requireAuth(['teacher', 'admin']), requireWritableBranch(), async (req, res) => {
  const { date, records } = req.body
  const tenant_id = req.user.tenant_id
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'No attendance records supplied' })
  }
  if (records.length > 1000) {
    return res.status(400).json({ error: 'Too many records in one submission' })
  }
  const studentIds = [...new Set(records.map(r => parseInt(r.student_id, 10)).filter(n => !Number.isNaN(n)))]
  const allowed = await pool.query(
    'SELECT id, branch_id FROM students WHERE id = ANY($1::int[]) AND tenant_id = $2',
    [studentIds, tenant_id]
  )
  const branchByStudent = new Map(allowed.rows.map(r => [r.id, r.branch_id]))
  const rejected = studentIds.filter(id => !branchByStudent.has(id))
  if (rejected.length) {
    return res.status(403).json({ error: `Student(s) not found in your school: ${rejected.join(', ')}` })
  }
  for (const record of records) {
    const studentId = parseInt(record.student_id, 10)
    await pool.query(
      `INSERT INTO attendance (student_id, date, status, tenant_id, branch_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [studentId, date, record.status, tenant_id, branchByStudent.get(studentId) ?? null]
    )
  }
  res.json({ success: true })
})

// The school's current calendar day. Both the teacher and student pages call this
// so "today" means the same thing on every device, whatever its timezone is.
app.get('/api/attendance/today', requireAuth(['admin', 'teacher', 'student', 'super_admin', 'coordinator']), (req, res) => {
  res.json({ today: schoolToday(), timezone: SCHOOL_TIMEZONE })
})

app.get('/api/attendance/me', requireAuth(['student']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const studentResult = await pool.query(
    'SELECT id, class_id FROM students WHERE id = $1 AND tenant_id = $2',
    [req.user.user_id, tenant_id]
  )

  if (studentResult.rows.length === 0) {
    return res.status(404).json({ error: 'Student not found' })
  }

  const student = studentResult.rows[0]
  // attendance.date is cast to text on purpose. A DATE column would be serialised
  // as a UTC instant (e.g. 2026-09-25T19:00:00.000Z for the 26th), so any client
  // in a timezone behind UTC rendered the record under the previous day. A plain
  // YYYY-MM-DD string cannot be misread.
  const result = await pool.query(`
    SELECT attendance.id,
           attendance.date::text AS date,
           attendance.status,
           attendance.teacher_id,
           to_char(attendance.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
           students.name, students.phone, students.roll_no, students.class_id, classes.name as class_name, classes.section as class_section
    FROM attendance
    JOIN students ON attendance.student_id = students.id
    LEFT JOIN classes ON students.class_id = classes.id
    WHERE attendance.student_id = $1 AND attendance.tenant_id = $2
    ORDER BY attendance.date DESC, students.name ASC
  `, [student.id, tenant_id])

  res.json(result.rows)
})

app.get('/api/attendance', requireAuth(['admin', 'teacher', 'student', 'super_admin', 'coordinator']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const { date, class_id, branch_id } = req.query

  let effectiveBranchId = null
  if (branch_id !== undefined && branch_id !== null && branch_id !== 'all' && branch_id !== '') {
    const parsed = parseInt(branch_id, 10)
    if (Number.isInteger(parsed) && parsed > 0) effectiveBranchId = parsed
  }
  // A coordinator is confined to their own branch in the database query, no matter
  // what branch_id the client sends. The filter cannot be spoofed from the UI.
  const coordinatorBranch = branchFilter(req.user)
  if (coordinatorBranch) effectiveBranchId = coordinatorBranch

  const result = await pool.query(`
    SELECT attendance.id,
           attendance.student_id,
           attendance.teacher_id,
           attendance.date::text AS date,
           attendance.status,
           to_char(attendance.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
           students.name, students.phone, students.roll_no,
           marking_teacher.name AS marked_by,
           attendance.teacher_id AS marked_by_id,
           CASE WHEN attendance.teacher_id IS NULL THEN 'staff' ELSE 'teacher' END AS marked_by_role
    FROM attendance
    JOIN students ON attendance.student_id = students.id
    LEFT JOIN teachers marking_teacher ON attendance.teacher_id = marking_teacher.id
    WHERE attendance.date = $1 AND students.class_id = $2 AND attendance.tenant_id = $3
      ${effectiveBranchId ? 'AND students.branch_id = $4' : ''}
    ORDER BY students.id
  `, effectiveBranchId ? [date, class_id, tenant_id, effectiveBranchId] : [date, class_id, tenant_id])
  res.json(result.rows)
})

app.get('/api/attendance/all', requireAuth(['admin', 'super_admin', 'coordinator']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const { branch_id } = req.query

  let effectiveBranchId = null
  if (branch_id !== undefined && branch_id !== null && branch_id !== 'all' && branch_id !== '') {
    const parsed = parseInt(branch_id, 10)
    if (Number.isInteger(parsed) && parsed > 0) effectiveBranchId = parsed
  }
  // A coordinator always gets their own branch back, whatever they ask for, and
  // can never fall through to the tenant-wide query below. A coordinator with no
  // branch is school-wide, so the tenant-wide query is exactly right for them.
  const coordinatorBranch = branchFilter(req.user)
  if (coordinatorBranch) effectiveBranchId = coordinatorBranch

  let result
  if (effectiveBranchId) {
    result = await pool.query(`
      SELECT
        attendance.id,
        attendance.student_id,
        attendance.teacher_id,
        attendance.date::text AS date,
        attendance.status,
        to_char(attendance.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
        students.name,
        students.phone,
        students.roll_no,
        students.class_id,
        classes.name as class_name,
        classes.section as class_section,
        COALESCE(marking_teacher.name, assigned_teacher.name) as marked_by,
        COALESCE(marking_teacher.id, assigned_teacher.id) as marked_by_id
      FROM attendance
      JOIN students ON attendance.student_id = students.id AND students.tenant_id = $1
      LEFT JOIN classes ON students.class_id = classes.id
      LEFT JOIN teachers marking_teacher ON attendance.teacher_id = marking_teacher.id
      LEFT JOIN LATERAL (
        SELECT t.id, t.name FROM teachers t
        WHERE t.class_id = students.class_id AND t.tenant_id = $1
        ORDER BY t.id DESC LIMIT 1
      ) assigned_teacher ON TRUE
      WHERE attendance.tenant_id = $1 AND students.branch_id = $2
      ORDER BY attendance.date DESC, classes.name ASC NULLS LAST, students.name ASC
    `, [tenant_id, effectiveBranchId])
  } else {
    result = await pool.query(`
      SELECT
        attendance.id,
        attendance.student_id,
        attendance.teacher_id,
        attendance.date::text AS date,
        attendance.status,
        to_char(attendance.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
        students.name,
        students.phone,
        students.roll_no,
        students.class_id,
        classes.name as class_name,
        classes.section as class_section,
        COALESCE(marking_teacher.name, assigned_teacher.name) as marked_by,
        COALESCE(marking_teacher.id, assigned_teacher.id) as marked_by_id
      FROM attendance
      JOIN students ON attendance.student_id = students.id AND students.tenant_id = $1
      LEFT JOIN classes ON students.class_id = classes.id
      LEFT JOIN teachers marking_teacher ON attendance.teacher_id = marking_teacher.id
      LEFT JOIN LATERAL (
        SELECT t.id, t.name FROM teachers t
        WHERE t.class_id = students.class_id AND t.tenant_id = $1
        ORDER BY t.id DESC LIMIT 1
      ) assigned_teacher ON TRUE
      WHERE attendance.tenant_id = $1
      ORDER BY attendance.date DESC, classes.name ASC NULLS LAST, students.name ASC
    `, [tenant_id])
  }
  res.json(result.rows)
})

app.post('/api/attendance/submit', requireAuth(['teacher', 'admin', 'coordinator']), requireWritableBranch(), async (req, res) => {
  try {
    // Teachers can only submit attendance if the teacher portal is enabled
    if (req.user.role === 'teacher') {
      const teacherPortalEnabled = await isPortalEnabled(req.user.tenant_id, 'teacher')
      if (!teacherPortalEnabled) {
        return res.status(403).json({ 
          error: 'The Teacher Portal has not been enabled for your school yet. Please ask your school admin to request it.',
          portal_disabled: true
        })
      }
    }

    const { date, teacher_id, records } = req.body
    const tenant_id = req.user.tenant_id

    // A submitted date is honoured so teachers can backfill a previous day, but
    // it must never be in the future. When the client sends nothing usable we
    // fall back to the school calendar day, which is the only trustworthy source
    // for "today" (the browser's own clock can be hours off).
    if (date !== undefined && date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' })
    }
    const today = schoolToday()
    if (date && date > today) {
      return res.status(400).json({ error: `Cannot mark attendance for a future date (${date}); today is ${today}` })
    }
    const attendanceDate = date || today
    if (date && date !== today) {
      console.log(`Backfilled attendance for ${date} (school date is ${today}, ${SCHOOL_TIMEZONE})`)
    }
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'No attendance records supplied' })
    }
    if (records.length > 1000) {
      return res.status(400).json({ error: 'Too many records in one submission' })
    }

    const validStatuses = ['Present', 'Absent', 'Leave']
    for (const record of records) {
      if (!record || record.student_id === undefined || record.student_id === null) {
        return res.status(400).json({ error: 'Each record needs a student_id' })
      }
      if (!validStatuses.includes(record.status)) {
        return res.status(400).json({ error: `Invalid attendance status: ${record.status}` })
      }
    }

    // Only touch students that actually belong to the caller's tenant.
    const studentIds = [...new Set(records.map(r => parseInt(r.student_id, 10)).filter(n => !Number.isNaN(n)))]
    if (studentIds.length === 0) {
      return res.status(400).json({ error: 'No valid student ids supplied' })
    }
    const allowed = await pool.query(
      'SELECT id, branch_id FROM students WHERE id = ANY($1::int[]) AND tenant_id = $2',
      [studentIds, tenant_id]
    )
    // A coordinator may only submit attendance for students inside their own
    // branch, so a forged class roster cannot write outside their scope. The
    // branch stored on each row still comes from the student's own branch_id.
    const coordinatorBranch = branchFilter(req.user)
    const branchScoped = coordinatorBranch
      ? allowed.rows.filter(r => r.branch_id === coordinatorBranch)
      : allowed.rows
    const allowedIds = new Set(branchScoped.map(r => r.id))
    // Attendance belongs to the branch of the student it is about, so the coordinator
    // view stays branch-scoped without anyone having to pick a branch per row.
    const branchByStudent = new Map(branchScoped.map(r => [r.id, r.branch_id]))
    const rejected = studentIds.filter(id => !allowedIds.has(id))
    if (rejected.length) {
      return res.status(403).json({ error: `Student(s) not found in your school: ${rejected.join(', ')}` })
    }

    const client = await pool.connect()
    let saved = 0
    try {
      await client.query('BEGIN')
      for (const record of records) {
        const studentId = parseInt(record.student_id, 10)
        const branchId = branchByStudent.get(studentId) ?? null
        // tenant_id is part of the match so a submit can never claim another
        // school's row (which would then vanish from that school's stats).
        const updated = await client.query(
          `UPDATE attendance
           SET teacher_id = $1, status = $2, tenant_id = $3, branch_id = $7
           WHERE student_id = $4 AND date = $5 AND tenant_id = $6`,
          [teacher_id || null, record.status, tenant_id, studentId, attendanceDate, tenant_id, branchId]
        )
        if (updated.rowCount === 0) {
          await client.query(
            `INSERT INTO attendance (student_id, teacher_id, date, status, tenant_id, branch_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [studentId, teacher_id || null, attendanceDate, record.status, tenant_id, branchId]
          )
        }
        saved++
      }
      await client.query('COMMIT')
    } catch (txErr) {
      await client.query('ROLLBACK')
      throw txErr
    } finally {
      client.release()
    }

    res.json({ success: true, saved, date: attendanceDate, timezone: SCHOOL_TIMEZONE })
  } catch (err) {
    console.error('Error submitting attendance:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// TEACHER SELF-ATTENDANCE (QR CODE)
// ============================================

// POST /api/attendance/teacher/checkin
// Teachers and admins check in by scanning the school's QR code
app.post('/api/attendance/teacher/checkin', requireAuth(['teacher', 'admin']), async (req, res) => {
  try {
    const { qr_code_data, location_lat, location_lng } = req.body || {}
    const { user_id, tenant_id, branch_id, role } = req.user

    // Check if QR attendance feature is enabled
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    // Validate location is provided
    if (location_lat == null || location_lng == null) {
      return res.status(400).json({ error: 'Location is required to mark attendance.', code: 'LOCATION_REQUIRED' })
    }

    // Get school location and radius
    const schoolResult = await pool.query(
      'SELECT location_lat, location_lng, location_radius_meters FROM organizations WHERE school_code = $1',
      [tenant_id]
    )
    if (schoolResult.rows.length === 0) {
      const error = handleApiError({ message: 'School not found' }, req)
      return res.status(404).json(error)
    }
    const school = schoolResult.rows[0]

    // If school has location set, validate distance
    if (school.location_lat != null && school.location_lng != null) {
      const distance = haversineDistance(
        school.location_lat,
        school.location_lng,
        location_lat,
        location_lng
      )
      const radius = school.location_radius_meters || 50 // Default 50m
      if (distance > radius) {
        return res.status(403).json({ error: 'You are too far from school.', code: 'TOO_FAR' })
      }
    }

    // Rate limiting
    if (!checkScanRateLimit(user_id)) {
      return res.status(429).json({ error: 'Too many attempts' })
    }

    // Verify QR code is valid and not expired
    const qrResult = await pool.query(
      `SELECT id, tenant_id, branch_id, expires_at, is_active 
       FROM qr_attendance_sessions 
       WHERE token = $1 AND is_active = true AND expires_at > NOW()`,
      [qr_code_data]
    )

    if (qrResult.rows.length === 0) {
      return res.status(400).json({ error: 'Code expired' })
    }

    const qrSession = qrResult.rows[0]

    // Verify QR belongs to the same tenant
    if (qrSession.tenant_id !== tenant_id) {
      return res.status(403).json({ error: 'Invalid code' })
    }

    // Get person info (teacher or admin)
    let personResult
    if (role === 'teacher') {
      personResult = await pool.query(
        'SELECT id, name, branch_id FROM teachers WHERE id = $1 AND tenant_id = $2',
        [user_id, tenant_id]
      )
    } else {
      personResult = await pool.query(
        'SELECT id, name, branch_id FROM admins WHERE id = $1 AND tenant_id = $2',
        [user_id, tenant_id]
      )
    }

    if (personResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid code' })
    }

    const person = personResult.rows[0]
    const today = schoolToday()

    // Check if already checked in today
    const existingCheckIn = await pool.query(
      'SELECT id, check_in_time, check_out_time FROM teacher_attendance WHERE teacher_id = $1 AND date = $2',
      [user_id, today]
    )

    // Get QR requirement setting
    const settingResult = await pool.query(
      'SELECT require_checkout FROM qr_attendance_settings WHERE tenant_id = $1',
      [tenant_id]
    )
    const requireCheckout = settingResult.rows.length > 0 ? settingResult.rows[0].require_checkout : false

    if (existingCheckIn.rows.length > 0) {
      const existing = existingCheckIn.rows[0]

      if (!requireCheckout) {
        return res.status(400).json({ error: 'Already marked today' })
      }

      if (existing.check_out_time) {
        return res.status(400).json({ error: 'Already done today' })
      }

      // Check if too soon (within 5 minutes)
      const checkInTime = new Date(existing.check_in_time)
      const now = new Date()
      const fiveMinutes = 5 * 60 * 1000
      if (now - checkInTime < fiveMinutes) {
        return res.status(400).json({ error: 'Too soon' })
      }

      // Check out
      await pool.query(
        'UPDATE teacher_attendance SET check_out_time = NOW(), is_incomplete = false WHERE id = $1',
        [existing.id]
      )

      res.json({
        success: true,
        message: 'Check-out successful',
        attendance_id: existing.id,
        check_out_time: now.toISOString(),
        date: today
      })
    } else {
      // Check in
      const result = await pool.query(
        `INSERT INTO teacher_attendance 
         (teacher_id, tenant_id, branch_id, date, location_lat, location_lng, qr_code_data, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'qr')
         RETURNING id, check_in_time`,
        [user_id, tenant_id, person.branch_id, today, locationLat, locationLng, qr_codeData]
      )

      res.json({
        success: true,
        message: 'Check-in successful',
        attendance_id: result.rows[0].id,
        check_in_time: result.rows[0].check_in_time,
        date: today
      })
    }
  } catch (err) {
    const error = handleApiError(err, req)
    res.status(500).json(error)
  }
})

// GET /api/attendance/teacher/me
// Get current teacher's attendance history
app.get('/api/attendance/teacher/me', requireAuth(['teacher', 'admin']), async (req, res) => {
  try {
    const { user_id, tenant_id, role } = req.user

    let result
    if (role === 'teacher') {
      result = await pool.query(
        `SELECT ta.id, ta.date, ta.check_in_time, ta.check_out_time, ta.location_lat, ta.location_lng, ta.qr_code_data,
                t.name as teacher_name, b.name as branch_name
         FROM teacher_attendance ta
         JOIN teachers t ON ta.teacher_id = t.id
         LEFT JOIN branches b ON ta.branch_id = b.id
         WHERE ta.teacher_id = $1 AND ta.tenant_id = $2
         ORDER BY ta.date DESC, ta.check_in_time DESC
         LIMIT 30`,
        [user_id, tenant_id]
      )
    } else {
      result = await pool.query(
        `SELECT ta.id, ta.date, ta.check_in_time, ta.check_out_time, ta.location_lat, ta.location_lng, ta.qr_code_data,
                a.name as teacher_name, b.name as branch_name
         FROM teacher_attendance ta
         JOIN admins a ON ta.teacher_id = a.id
         LEFT JOIN branches b ON ta.branch_id = b.id
         WHERE ta.teacher_id = $1 AND ta.tenant_id = $2
         ORDER BY ta.date DESC, ta.check_in_time DESC
         LIMIT 30`,
        [user_id, tenant_id]
      )
    }

    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching teacher attendance:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// ============================================
// RATE LIMITING
// ============================================

const scanRateLimit = new Map()
const SCAN_RATE_LIMIT_MS = 5000 // 5 seconds between scans

function checkScanRateLimit(userId) {
  const lastScan = scanRateLimit.get(userId)
  const now = Date.now()
  if (lastScan && now - lastScan < SCAN_RATE_LIMIT_MS) {
    return false
  }
  scanRateLimit.set(userId, now)
  return true
}

// ============================================
// QR ATTENDANCE GENERATION (Admin/Super Admin)
// ============================================

// POST /api/attendance/qr/generate
// Generate a new QR code for the school/branch
app.post('/api/attendance/qr/generate', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { tenant_id, branch_id } = req.user

    // Check if QR attendance feature is enabled for this tenant
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    // Validate tenant exists before INSERT
    const schoolResult = await pool.query('SELECT school_code FROM organizations WHERE school_code = $1', [tenant_id])
    if (schoolResult.rows.length === 0) {
      const error = handleApiError({ message: 'violates foreign key constraint qr_attendance_sessions_tenant_id_fkey' }, req)
      return res.status(400).json(error)
    }

    // Generate random token
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date()
    expiresAt.setHours(23, 59, 59, 999) // End of today

    // Deactivate all previous codes for this tenant/branch
    await pool.query(
      `UPDATE qr_attendance_sessions 
       SET is_active = false 
       WHERE tenant_id = $1 AND (branch_id IS NULL OR branch_id = $2)`,
      [tenant_id, branch_id]
    )

    // Insert new session
    await pool.query(
      `INSERT INTO qr_attendance_sessions (tenant_id, branch_id, token, expires_at, is_active)
       VALUES ($1, $2, $3, $4, true)`,
      [tenant_id, branch_id, token, expiresAt]
    )

    res.json({
      success: true,
      token,
      expires_at: expiresAt.toISOString()
    })
  } catch (err) {
    const error = handleApiError(err, req)
    res.status(500).json(error)
  }
})

// GET /api/attendance/qr/status
// Get current QR code status
app.get('/api/attendance/qr/status', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { tenant_id, branch_id } = req.user

    // Check if QR attendance feature is enabled
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    const result = await pool.query(
      `SELECT id, expires_at, is_active, created_at 
       FROM qr_attendance_sessions 
       WHERE tenant_id = $1 AND (branch_id IS NULL OR branch_id = $2) 
       ORDER BY created_at DESC LIMIT 1`,
      [tenant_id, branch_id]
    )

    if (result.rows.length === 0) {
      return res.json({ active: false })
    }

    const session = result.rows[0]
    res.json({
      active: session.is_active,
      expires_at: session.expires_at,
      created_at: session.created_at
    })
  } catch (err) {
    console.error('Error fetching QR status:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// ============================================
// STAFF ATTENDANCE VIEW (Admin)
// ============================================

// GET /api/attendance/staff
// Get staff attendance (teachers and admins)
app.get('/api/attendance/staff', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { tenant_id, branch_id, role } = req.user
    const { date } = req.query

    // Check if QR attendance feature is enabled
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    const effectiveBranchId = role === 'coordinator' ? branch_id : null

    // Get teacher attendance
    const teacherQuery = `
      SELECT ta.id, ta.teacher_id, ta.date, ta.check_in_time, ta.check_out_time, 
             ta.source, ta.is_incomplete, ta.is_manual,
             CASE 
               WHEN ta.source = 'manual' THEN 'Manual'
               ELSE 'QR'
             END as source_label,
             t.name as person_name, 
             'Teacher' as person_role,
             b.name as branch_name
      FROM teacher_attendance ta
      JOIN teachers t ON ta.teacher_id = t.id
      LEFT JOIN branches b ON ta.branch_id = b.id
      WHERE ta.tenant_id = $1
      ${date ? 'AND ta.date = $2' : ''}
      ${effectiveBranchId ? 'AND ta.branch_id = $' + (date ? '3' : '2') : ''}
    `

    // Get admin attendance
    const adminQuery = `
      SELECT ta.id, ta.teacher_id, ta.date, ta.check_in_time, ta.check_out_time, 
             ta.source, ta.is_incomplete, ta.is_manual,
             CASE 
               WHEN ta.source = 'manual' THEN 'Manual'
               ELSE 'QR'
             END as source_label,
             a.name as person_name, 
             'Admin' as person_role,
             b.name as branch_name
      FROM teacher_attendance ta
      JOIN admins a ON ta.teacher_id = a.id
      LEFT JOIN branches b ON ta.branch_id = b.id
      WHERE ta.tenant_id = $1
      ${date ? 'AND ta.date = $2' : ''}
      ${effectiveBranchId ? 'AND ta.branch_id = $' + (date ? '3' : '2') : ''}
    `

    const params = [tenant_id]
    if (date) params.push(date)
    if (effectiveBranchId) params.push(effectiveBranchId)

    const [teacherResult, adminResult] = await Promise.all([
      pool.query(teacherQuery, params),
      pool.query(adminQuery, params)
    ])

    const allRecords = [...teacherResult.rows, ...adminResult.rows]
    allRecords.sort((a, b) => {
      const dateCompare = new Date(b.date) - new Date(a.date)
      if (dateCompare !== 0) return dateCompare
      return new Date(b.check_in_time) - new Date(a.check_in_time)
    })

    res.json(allRecords)
  } catch (err) {
    console.error('Error fetching staff attendance:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// ============================================
// MANUAL ATTENDANCE EDIT (Admin)
// ============================================

// POST /api/attendance/staff/manual
// Manually edit staff attendance
app.post('/api/attendance/staff/manual', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const { tenant_id, branch_id, user_id, role } = req.user
    const { attendance_id, person_id, date, check_in_time, check_out_time, status, note } = req.body

    // Check if QR attendance feature is enabled
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    // Prevent editing own attendance (admin editing themselves)
    if (person_id == user_id && role === 'admin') {
      return res.status(403).json({ error: 'Cannot edit own attendance' })
    }

    // For admin attendance, only super admin can edit
    const personResult = await pool.query(
      'SELECT role FROM admins WHERE id = $1 AND tenant_id = $2',
      [person_id, tenant_id]
    )
    if (personResult.rows.length > 0 && personResult.rows[0].role === 'admin' && role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super admin can edit admin attendance' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Get current values
      const currentResult = await client.query(
        'SELECT check_in_time, check_out_time FROM teacher_attendance WHERE id = $1',
        [attendance_id]
      )

      if (currentResult.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Attendance record not found' })
      }

      const current = currentResult.rows[0]

      // Insert history record
      await client.query(
        `INSERT INTO teacher_attendance_manual_changes 
         (attendance_id, changed_by, changed_by_role, old_check_in_time, new_check_in_time, 
          old_check_out_time, new_check_out_time, old_status, new_status, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [attendance_id, user_id, role, current.check_in_time, check_in_time || current.check_in_time,
         current.check_out_time, check_out_time || current.check_out_time, status, status, note]
      )

      // Update attendance record
      const updateQuery = `
        UPDATE teacher_attendance 
        SET check_in_time = COALESCE($1, check_in_time),
            check_out_time = $2,
            is_incomplete = $3,
            is_manual = true,
            source = 'manual'
        WHERE id = $4
      `
      const isIncomplete = check_out_time === null && check_in_time === null ? true : false
      await client.query(updateQuery, [check_in_time, check_out_time, isIncomplete, attendance_id])

      await client.query('COMMIT')

      res.json({ success: true, message: 'Attendance updated' })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('Error in manual attendance edit:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// ============================================
// QR REQUIREMENT SETTING (Super Admin Only)
// ============================================

// GET /api/attendance/qr/setting
// Get QR requirement setting for a school
app.get('/api/attendance/qr/setting', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { tenant_id } = req.user

    // Check if QR attendance feature is enabled
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    const result = await pool.query(
      'SELECT require_checkout FROM qr_attendance_settings WHERE tenant_id = $1',
      [tenant_id]
    )

    if (result.rows.length === 0) {
      return res.json({ require_checkout: false })
    }

    res.json({ require_checkout: result.rows[0].require_checkout })
  } catch (err) {
    console.error('Error fetching QR setting:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// POST /api/attendance/qr/setting
// Update QR requirement setting
app.post('/api/attendance/qr/setting', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { tenant_id } = req.user

    // Check if QR attendance feature is enabled
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    const result = await pool.query(
      `INSERT INTO qr_attendance_settings (tenant_id, require_checkout, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET 
         require_checkout = EXCLUDED.require_checkout, updated_at = NOW()`,
      [tenant_id, req.body.require_checkout]
    )

    res.json({ success: true, require_checkout: req.body.require_checkout })
  } catch (err) {
    console.error('Error updating QR setting:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// GET /api/attendance/manual-changes
// Get manual changes history (super admin view)
app.get('/api/attendance/manual-changes', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { tenant_id } = req.user

    // Check if QR attendance feature is enabled
    const featureResult = await pool.query(
      'SELECT enabled FROM tenant_grants WHERE school_id = $1 AND feature_key = $2',
      [tenant_id, 'qr_attendance']
    )
    if (featureResult.rows.length === 0 || !featureResult.rows[0].enabled) {
      return res.status(403).json({ error: 'This feature is not enabled for your academy. Please contact the administrator.' })
    }

    const result = await pool.query(
      `SELECT mc.*, ta.date, 
              CASE 
                WHEN mc.changed_by_role = 'admin' THEN a.name
                WHEN mc.changed_by_role = 'super_admin' THEN sa.name
                ELSE 'Unknown'
              END as changed_by_name
       FROM teacher_attendance_manual_changes mc
       JOIN teacher_attendance ta ON mc.attendance_id = ta.id
       LEFT JOIN admins a ON mc.changed_by = a.id
       LEFT JOIN admins sa ON mc.changed_by = sa.id
       WHERE ta.tenant_id = $1
       ORDER BY mc.changed_at DESC
       LIMIT 100`,
      [tenant_id]
    )

    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching manual changes:', err)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// HOMEWORK
app.get('/api/homework', requireAuth(['admin', 'teacher', 'student', 'super_admin']), async (req, res) => {
  const { class_id, branch_id } = req.query
  const tenant_id = req.user.tenant_id

  let effectiveBranchId = null
  if (branch_id !== undefined && branch_id !== null && branch_id !== 'all' && branch_id !== '') {
    const parsed = parseInt(branch_id, 10)
    if (Number.isInteger(parsed) && parsed > 0) effectiveBranchId = parsed
  }

  let result
  if (class_id && effectiveBranchId) {
    result = await pool.query(`
      SELECT homework.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM homework
      LEFT JOIN classes ON homework.class_id = classes.id
      LEFT JOIN teachers ON homework.teacher_id = teachers.id
      WHERE homework.class_id = $1 AND homework.tenant_id = $2 AND classes.branch_id = $3
      ORDER BY homework.created_at DESC
    `, [class_id, tenant_id, effectiveBranchId])
  } else if (class_id) {
    result = await pool.query(`
      SELECT homework.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM homework
      LEFT JOIN classes ON homework.class_id = classes.id
      LEFT JOIN teachers ON homework.teacher_id = teachers.id
      WHERE homework.class_id = $1 AND homework.tenant_id = $2
      ORDER BY homework.created_at DESC
    `, [class_id, tenant_id])
  } else if (effectiveBranchId) {
    result = await pool.query(`
      SELECT homework.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM homework
      LEFT JOIN classes ON homework.class_id = classes.id
      LEFT JOIN teachers ON homework.teacher_id = teachers.id
      WHERE homework.tenant_id = $1 AND classes.branch_id = $2
      ORDER BY homework.created_at DESC
    `, [tenant_id, effectiveBranchId])
  } else {
    result = await pool.query(`
      SELECT homework.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM homework
      LEFT JOIN classes ON homework.class_id = classes.id
      LEFT JOIN teachers ON homework.teacher_id = teachers.id
      WHERE homework.tenant_id = $1
      ORDER BY homework.created_at DESC
    `, [tenant_id])
  }

  res.json(result.rows)
})

app.post('/api/homework', requireAuth(['teacher', 'admin']), requireWritableBranch(), async (req, res) => {
  const { subject, task, class_id, teacher_id } = req.body
  const tenant_id = req.user.tenant_id
  if (!subject || !task) return res.status(400).json({ error: 'Subject and task are required' })

  const result = await pool.query(
    'INSERT INTO homework (subject, task, class_id, teacher_id, tenant_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [subject, task, class_id || null, teacher_id || null, tenant_id]
  )
  res.json(result.rows[0])
})

app.delete('/api/homework/:id', requireAuth(['teacher', 'admin']), requireWritableBranch(), async (req, res) => {
  const tenant_id = req.user.tenant_id
  await pool.query('DELETE FROM homework WHERE id = $1 AND tenant_id = $2', [req.params.id, tenant_id])
  res.json({ success: true })
})

// ANNOUNCEMENTS
app.get('/api/announcements', requireAuth(['admin', 'teacher', 'student', 'coordinator', 'super_admin']), async (req, res) => {
  const { class_id, branch_id } = req.query
  const tenant_id = req.user.tenant_id

  let effectiveBranchId = null
  if (branch_id !== undefined && branch_id !== null && branch_id !== 'all' && branch_id !== '') {
    const parsed = parseInt(branch_id, 10)
    if (Number.isInteger(parsed) && parsed > 0) effectiveBranchId = parsed
  }

  let result
  if (class_id && effectiveBranchId) {
    result = await pool.query(`
      SELECT announcements.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM announcements
      LEFT JOIN classes ON announcements.class_id = classes.id
      LEFT JOIN teachers ON announcements.teacher_id = teachers.id
      WHERE (announcements.class_id IS NULL OR announcements.class_id = $1) AND announcements.tenant_id = $2 AND classes.branch_id = $3
      ORDER BY announcements.created_at DESC
    `, [class_id, tenant_id, effectiveBranchId])
  } else if (class_id) {
    result = await pool.query(`
      SELECT announcements.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM announcements
      LEFT JOIN classes ON announcements.class_id = classes.id
      LEFT JOIN teachers ON announcements.teacher_id = teachers.id
      WHERE (announcements.class_id IS NULL OR announcements.class_id = $1) AND announcements.tenant_id = $2
      ORDER BY announcements.created_at DESC
    `, [class_id, tenant_id])
  } else if (effectiveBranchId) {
    result = await pool.query(`
      SELECT announcements.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM announcements
      LEFT JOIN classes ON announcements.class_id = classes.id
      LEFT JOIN teachers ON announcements.teacher_id = teachers.id
      WHERE announcements.tenant_id = $1 AND (classes.branch_id = $2 OR classes.branch_id IS NULL)
      ORDER BY announcements.created_at DESC
    `, [tenant_id, effectiveBranchId])
  } else {
    result = await pool.query(`
      SELECT announcements.*, classes.name as class_name, classes.section as class_section, teachers.name as teacher_name
      FROM announcements
      LEFT JOIN classes ON announcements.class_id = classes.id
      LEFT JOIN teachers ON announcements.teacher_id = teachers.id
      WHERE announcements.tenant_id = $1
      ORDER BY announcements.created_at DESC
    `, [tenant_id])
  }

  res.json(result.rows)
})

app.post('/api/announcements', requireAuth(['admin', 'teacher', 'coordinator', 'super_admin']), requireWritableBranch(), async (req, res) => {
  const { title, message, class_id, teacher_id, author } = req.body
  const tenant_id = req.user.tenant_id
  if (!message) return res.status(400).json({ error: 'Announcement message is required' })

  const result = await pool.query(
    'INSERT INTO announcements (title, message, class_id, teacher_id, author, tenant_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [title || null, message, class_id || null, teacher_id || null, author || null, tenant_id]
  )
  res.json(result.rows[0])
})

app.delete('/api/announcements/:id', requireAuth(['admin', 'teacher', 'coordinator', 'super_admin']), requireWritableBranch(), async (req, res) => {
  const tenant_id = req.user.tenant_id
  await pool.query('DELETE FROM announcements WHERE id = $1 AND tenant_id = $2', [req.params.id, tenant_id])
  res.json({ success: true })
})

// ============================================
// FEE MANAGEMENT ROUTES
// ============================================

// GET /api/fees/structures - List all fee structures for the tenant
app.get('/api/fees/structures', requireAuth(['admin', 'teacher']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const result = await pool.query(
    `SELECT fee_structures.*, 
      CASE 
        WHEN fee_structures.type = 'class' THEN classes.name 
        WHEN fee_structures.type = 'student' THEN students.name 
      END as target_name
     FROM fee_structures
     LEFT JOIN classes ON fee_structures.type = 'class' AND fee_structures.target_id = classes.id AND classes.tenant_id = fee_structures.tenant_id
     LEFT JOIN students ON fee_structures.type = 'student' AND fee_structures.target_id = students.id AND students.tenant_id = fee_structures.tenant_id
     WHERE fee_structures.tenant_id = $1
     ORDER BY fee_structures.created_at DESC`,
    [tenant_id]
  )
  res.json(result.rows)
})

// POST /api/fees/structures - Create a new fee structure
app.post('/api/fees/structures', requireAuth(['admin']), async (req, res) => {
  try {
    const { type, target_id, monthly_fee, admission_fee, transport_fee, discount } = req.body
    const tenant_id = req.user.tenant_id

    if (!type || !target_id) {
      return res.status(400).json({ error: 'type and target_id are required' })
    }

    // Validate fee amounts are valid numbers
    const monthlyFee = Number(monthly_fee)
    const admissionFee = Number(admission_fee)
    const transportFee = Number(transport_fee)
    const discountFee = Number(discount)

    if (isNaN(monthlyFee) || monthlyFee < 0) {
      return res.status(400).json({ error: 'monthly_fee must be a valid non-negative number' })
    }
    if (isNaN(admissionFee) || admissionFee < 0) {
      return res.status(400).json({ error: 'admission_fee must be a valid non-negative number' })
    }
    if (isNaN(transportFee) || transportFee < 0) {
      return res.status(400).json({ error: 'transport_fee must be a valid non-negative number' })
    }
    if (isNaN(discountFee) || discountFee < 0) {
      return res.status(400).json({ error: 'discount must be a valid non-negative number' })
    }

    const result = await pool.query(
      `INSERT INTO fee_structures (type, target_id, monthly_fee, admission_fee, transport_fee, discount, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [type, target_id, monthlyFee, admissionFee, transportFee, discountFee, tenant_id]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Error creating fee structure:', err)
    res.status(500).json({ error: 'Failed to save fee structure: ' + err.message })
  }
})

// PUT /api/fees/structures/:id - Update an existing fee structure
app.put('/api/fees/structures/:id', requireAuth(['admin']), async (req, res) => {
  try {
    const { type, target_id, monthly_fee, admission_fee, transport_fee, discount } = req.body
    const tenant_id = req.user.tenant_id

    // Validate fee amounts are valid numbers
    const monthlyFee = Number(monthly_fee)
    const admissionFee = Number(admission_fee)
    const transportFee = Number(transport_fee)
    const discountFee = Number(discount)

    if (isNaN(monthlyFee) || monthlyFee < 0) {
      return res.status(400).json({ error: 'monthly_fee must be a valid non-negative number' })
    }
    if (isNaN(admissionFee) || admissionFee < 0) {
      return res.status(400).json({ error: 'admission_fee must be a valid non-negative number' })
    }
    if (isNaN(transportFee) || transportFee < 0) {
      return res.status(400).json({ error: 'transport_fee must be a valid non-negative number' })
    }
    if (isNaN(discountFee) || discountFee < 0) {
      return res.status(400).json({ error: 'discount must be a valid non-negative number' })
    }

    const result = await pool.query(
      `UPDATE fee_structures 
       SET type = $1, target_id = $2, monthly_fee = $3, admission_fee = $4, transport_fee = $5, discount = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND tenant_id = $8
       RETURNING *`,
      [type, target_id, monthlyFee, admissionFee, transportFee, discountFee, req.params.id, tenant_id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fee structure not found' })
    }

    res.json(result.rows[0])
  } catch (err) {
    console.error('Error updating fee structure:', err)
    res.status(500).json({ error: 'Failed to update fee structure: ' + err.message })
  }
})

// GET /api/fees/payments - List fee payments with filters
app.get('/api/fees/payments', requireAuth(['admin', 'teacher']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const { mode, month, year, class_id, status, search } = req.query

  // Default mode: LEFT JOIN from students so every student appears.
  // Students without a payment record get status='not_set_up'.
  // mode=records uses the old INNER JOIN (only students with actual payments).
  // A year with no month means "every month of that year", which the per-student
  // LEFT JOIN cannot express because it joins on a single month, so fall back to
  // the recorded-rows view.
  if (mode === 'records' || (year && !month)) {
    let query = `
      SELECT fee_payments.*, students.name as student_name, students.roll_no, classes.name as class_name, classes.section as class_section
      FROM fee_payments
      JOIN students ON fee_payments.student_id = students.id AND fee_payments.tenant_id = students.tenant_id
      LEFT JOIN classes ON students.class_id = classes.id AND students.tenant_id = classes.tenant_id
      WHERE fee_payments.tenant_id = $1
    `
    const params = [tenant_id]
    let paramIndex = 2

    if (month) {
      query += ` AND fee_payments.month = $${paramIndex}`
      params.push(month)
      paramIndex++
    } else if (year) {
      query += ` AND fee_payments.month LIKE $${paramIndex}`
      params.push(`${year}-%`)
      paramIndex++
    }
    if (class_id) {
      query += ` AND students.class_id = $${paramIndex}`
      params.push(class_id)
      paramIndex++
    }
    if (status) {
      query += ` AND fee_payments.status = $${paramIndex}`
      params.push(status)
      paramIndex++
    }
    if (search) {
      query += ` AND (students.name ILIKE $${paramIndex} OR students.roll_no ILIKE $${paramIndex})`
      params.push(`%${search}%`)
      paramIndex++
    }

    query += ` ORDER BY fee_payments.month DESC, students.name ASC`
    const result = await pool.query(query, params)
    return res.json(result.rows)
  }

  // Default: LEFT JOIN — all students, with payments if they exist for the month
  const targetMonth = month || new Date().toISOString().slice(0, 7)
  let query = `
    SELECT 
      students.id as student_id,
      students.name as student_name,
      students.roll_no,
      students.class_id,
      classes.name as class_name,
      classes.section as class_section,
      fee_payments.id as payment_id,
      fee_payments.month as month_year,
      fee_payments.amount_due,
      fee_payments.amount_paid,
      COALESCE(fee_payments.status, 'not_set_up') as status,
      fee_payments.payment_date,
      fee_payments.payment_method,
      fee_payments.notes
    FROM students
    LEFT JOIN fee_payments ON students.id = fee_payments.student_id AND fee_payments.tenant_id = students.tenant_id AND fee_payments.month = $2
    LEFT JOIN classes ON students.class_id = classes.id AND students.tenant_id = classes.tenant_id
    WHERE students.tenant_id = $1
  `
  const params = [tenant_id, targetMonth]
  let paramIdx = 3

  if (class_id) {
    query += ` AND students.class_id = $${paramIdx}`
    params.push(class_id)
    paramIdx++
  }
  if (search) {
    query += ` AND (students.name ILIKE $${paramIdx} OR students.roll_no ILIKE $${paramIdx})`
    params.push(`%${search}%`)
    paramIdx++
  }

  query += ` ORDER BY students.name ASC`
  let result = await pool.query(query, params)
  let rows = result.rows

  // For students with no payment row, look up their applicable fee structure
  // (student-specific first, class-level fallback) in one batched query.
  const noPaymentRows = rows.filter(r => r.payment_id == null)
  if (noPaymentRows.length > 0) {
    const studentIds = noPaymentRows.map(r => r.student_id)
    const classIds   = [...new Set(noPaymentRows.map(r => r.class_id).filter(Boolean))]

    const fsResult = await pool.query(
      `SELECT type, target_id, monthly_fee, transport_fee, discount
       FROM fee_structures
       WHERE tenant_id = $1
         AND (
           (type = 'student' AND target_id = ANY($2::int[]))
           OR
           (type = 'class'   AND target_id = ANY($3::int[]))
         )`,
      [tenant_id, studentIds, classIds.length > 0 ? classIds : [0]]
    )

    // Index by type for O(1) lookup
    const studentStructures = {}
    const classStructures   = {}
    for (const fs of fsResult.rows) {
      if (fs.type === 'student') studentStructures[fs.target_id] = fs
      if (fs.type === 'class')   classStructures[fs.target_id]   = fs
    }

    rows = rows.map(r => {
      if (r.payment_id != null) return r  // has a real payment — leave untouched

      // Student-specific override first, class fallback second
      const fs = studentStructures[r.student_id] || classStructures[r.class_id] || null

      if (fs) {
        return { ...r, amount_due: monthlyAmountDue(fs), amount_paid: 0, status: 'unpaid', month_year: targetMonth }
      }
      // No fee structure — keep not_set_up
      return { ...r, amount_due: 0, amount_paid: 0, month_year: targetMonth }
    })
  }

  // Filter by status in JS after query (COALESCE can't be used in WHERE easily)
  if (status) {
    rows = rows.filter(r => r.status === status)
  }

  res.json(rows)
})

// POST /api/fees/payments - Upsert fee payment record
app.post('/api/fees/payments', requireAuth(['admin']), async (req, res) => {
  try {
    const { student_id, month, amount_due, amount_paid, payment_method, payment_date, notes } = req.body
    const tenant_id = req.user.tenant_id

    if (!student_id || !month) {
      return res.status(400).json({ error: 'student_id and month are required' })
    }

    // Validate amount_due and amount_paid are valid numbers
    const due = Number(amount_due)
    const paid = Number(amount_paid)

    if (isNaN(due) || due < 0) {
      return res.status(400).json({ error: 'amount_due must be a valid non-negative number' })
    }
    if (isNaN(paid) || paid < 0) {
      return res.status(400).json({ error: 'amount_paid must be a valid non-negative number' })
    }

    // Auto-calculate status
    let status = 'unpaid'
    if (paid >= due) {
      status = 'paid'
    } else if (paid > 0) {
      status = 'partial'
    }

    // Check if record exists
    const existing = await pool.query(
      'SELECT id FROM fee_payments WHERE student_id = $1 AND month = $2 AND tenant_id = $3',
      [student_id, month, tenant_id]
    )

    let result
    if (existing.rows.length > 0) {
      // Update existing
      result = await pool.query(
        `UPDATE fee_payments 
         SET amount_due = $1, amount_paid = $2, status = $3, payment_method = $4, payment_date = $5, notes = $6, updated_at = CURRENT_TIMESTAMP
         WHERE student_id = $7 AND month = $8 AND tenant_id = $9
         RETURNING *`,
        [due, paid, status, payment_method, payment_date, notes, student_id, month, tenant_id]
      )
    } else {
      // Insert new
      result = await pool.query(
        `INSERT INTO fee_payments (student_id, month, amount_due, amount_paid, status, payment_method, payment_date, notes, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [student_id, month, due, paid, status, payment_method, payment_date, notes, tenant_id]
      )
    }

    res.json(result.rows[0])
  } catch (err) {
    console.error('Error saving fee payment:', err)
    res.status(500).json({ error: 'Failed to save payment: ' + err.message })
  }
})

// GET /api/fees/stats - Get fee statistics for a month
app.get('/api/fees/stats', requireAuth(['admin', 'teacher']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const { month } = req.query

  let monthFilter = ''
  const params = [tenant_id]
  let paramIndex = 2

  if (month) {
    monthFilter = ` AND fee_payments.month = $${paramIndex}`
    params.push(month)
    paramIndex++
  }

  const stats = await pool.query(
    `SELECT 
      COUNT(DISTINCT students.id) as total_students,
      COALESCE(SUM(fee_payments.amount_due), 0) as total_due,
      COALESCE(SUM(fee_payments.amount_paid), 0) as total_collected
     FROM students
     LEFT JOIN fee_payments ON students.id = fee_payments.student_id AND fee_payments.tenant_id = students.tenant_id${monthFilter}
     WHERE students.tenant_id = $1`,
    params
  )

  const data = stats.rows[0]
  const totalStudents = Number(data.total_students) || 0
  const totalDue = Number(data.total_due) || 0
  const totalCollected = Number(data.total_collected) || 0
  const collectionRate = totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0

  res.json({
    total_students: totalStudents,
    total_due: totalDue,
    total_collected: totalCollected,
    collection_rate: collectionRate
  })
})

// GET /api/fees/me - Get current student's fee records
app.get('/api/fees/me', requireAuth(['student']), async (req, res) => {
  const tenant_id = req.user.tenant_id
  const student_id = req.user.user_id
  const { month } = req.query

  // Look up student's class and name
  const studentInfo = await pool.query(
    `SELECT s.name as student_name, s.class_id, c.name as class_name, c.section as class_section
     FROM students s
     LEFT JOIN classes c ON s.class_id = c.id AND s.tenant_id = c.tenant_id
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [student_id, tenant_id]
  )
  const student = studentInfo.rows[0] || { student_name: '', class_name: '', class_section: null }

  // Find fee structure — student override first, then class default (same as getStudentMonthlyFee)
  let monthlyFee = 0
  let feeStructureExists = false
  let feeStructure = null
  const studentFs = await pool.query(
    `SELECT type, monthly_fee, admission_fee, transport_fee, discount
     FROM fee_structures WHERE type = 'student' AND target_id = $1 AND tenant_id = $2`,
    [student_id, tenant_id]
  )
  if (studentFs.rows.length > 0) {
    feeStructure = studentFs.rows[0]
  } else {
    const classFs = await pool.query(
      `SELECT type, monthly_fee, admission_fee, transport_fee, discount
       FROM fee_structures WHERE type = 'class' AND target_id = $1 AND tenant_id = $2`,
      [student.class_id || 0, tenant_id]
    )
    feeStructure = classFs.rows[0] || null
  }
  if (feeStructure) {
    monthlyFee = monthlyAmountDue(feeStructure)
    feeStructureExists = true
  }

  // Get all payment records for this student
  let paymentQuery = `
    SELECT fp.id, fp.student_id, fp.month as month_year, fp.amount_due, fp.amount_paid, fp.status, fp.payment_date, fp.payment_method, fp.notes,
           students.name as student_name, classes.name as class_name, classes.section as class_section
    FROM fee_payments fp
    JOIN students ON fp.student_id = students.id AND fp.tenant_id = students.tenant_id
    LEFT JOIN classes ON students.class_id = classes.id AND students.tenant_id = classes.tenant_id
    WHERE fp.student_id = $1 AND fp.tenant_id = $2
  `
  const params = [student_id, tenant_id]

  if (month) {
    paymentQuery += ` AND fp.month = $3`
    params.push(month)
  }

  paymentQuery += ` ORDER BY fp.month DESC`
  const paymentResult = await pool.query(paymentQuery, params)
  const records = paymentResult.rows

  // If the requested month has no payment record, create a synthetic one
  const targetMonth = month || new Date().toISOString().slice(0, 7)
  const hasRequestedMonth = records.some(r => r.month_year === targetMonth)

  if (!hasRequestedMonth) {
    records.unshift({
      id: null,
      student_id,
      month_year: targetMonth,
      amount_due: monthlyFee,
      amount_paid: 0,
      status: feeStructureExists ? 'unpaid' : 'not_set_up',
      payment_date: null,
      payment_method: null,
      notes: null,
      student_name: student.student_name,
      class_name: student.class_name,
      class_section: student.class_section,
    })
  }

  res.json({ records, structure: feeStructure })
})



// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000

function isTransientStartupError(error) {
  const transientCodes = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', '57P01'
  ])
  for (let current = error; current; current = current.cause) {
    if (transientCodes.has(current.code)) return true
    if (/connection terminated|connection timeout|socket hang up/i.test(current.message || '')) return true
  }
  return false
}

async function startServer() {
  const startupRetries = 3

  for (let attempt = 1; attempt <= startupRetries + 1; attempt++) {
    try {
      await createTables()
      app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`)
      })
      return
    } catch (error) {
      if (!isTransientStartupError(error) || attempt > startupRetries) {
        console.error('FATAL: Database startup failed; the server was not started.', error)
        await pool.end().catch(() => {})
        process.exitCode = 1
        return
      }

      const delayMs = Math.min(2000 * (2 ** (attempt - 1)), 15000)
      console.warn(
        `Database startup attempt ${attempt}/${startupRetries + 1} failed; retrying in ${delayMs / 1000}s: ${error.message}`
      )
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

startServer()


// ============================================
// DATESHEET ROUTES
// ============================================

// GET /api/datesheet/bootstrap (Admin only)
app.get('/api/datesheet/bootstrap', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const branchId = req.user.branch_id || (req.query.branch_id ? Number(req.query.branch_id) : null);

    const clsQuery = branchId
      ? await pool.query('SELECT id, name, section FROM classes WHERE tenant_id = $1 AND branch_id = $2 ORDER BY name, section, id', [tenantId, branchId])
      : await pool.query('SELECT id, name, section FROM classes WHERE tenant_id = $1 ORDER BY name, section, id', [tenantId]);

    const tchQuery = branchId
      ? await pool.query('SELECT id, name, class_id FROM teachers WHERE tenant_id = $1 AND branch_id = $2 ORDER BY name', [tenantId, branchId])
      : await pool.query('SELECT id, name, class_id FROM teachers WHERE tenant_id = $1 ORDER BY name', [tenantId]);

    const hwQuery = await pool.query('SELECT DISTINCT class_id, subject FROM homework WHERE tenant_id = $1', [tenantId]);

    const teachersByClass = {};
    tchQuery.rows.forEach(t => {
      if (t.class_id) {
        teachersByClass[t.class_id] = t.name;
      }
    });

    const subjectsByClass = {};
    hwQuery.rows.forEach(h => {
      if (h.class_id && h.subject) {
        if (!subjectsByClass[h.class_id]) subjectsByClass[h.class_id] = new Set();
        subjectsByClass[h.class_id].add(h.subject.trim());
      }
    });

    const defaultSubs = ['Mathematics', 'English', 'Science', 'Social Studies'];

    const classes = clsQuery.rows.map(c => {
      const assignedTeacher = teachersByClass[c.id] || (tchQuery.rows[0] ? tchQuery.rows[0].name : '');
      const hwSubs = subjectsByClass[c.id] ? Array.from(subjectsByClass[c.id]) : [];
      const subList = hwSubs.length ? hwSubs : defaultSubs;

      const subs = subList.map((s, idx) => {
        let diff = 'Medium';
        const lower = s.toLowerCase();
        if (lower.includes('math') || lower.includes('phys') || lower.includes('chem')) diff = 'Hard';
        else if (lower.includes('eng') || lower.includes('art') || lower.includes('urdu') || lower.includes('pe')) diff = 'Easy';
        return { n: s, l: diff, t: assignedTeacher, f: '' };
      });

      const label = c.section ? `${c.name} (${c.section})` : c.name;
      return {
        id: c.id,
        name: label,
        room: `Room ${c.id || 101}`,
        sel: true,
        subs
      };
    });

    res.json({ ok: true, classes, teachers: tchQuery.rows });
  } catch (err) {
    console.error('[datesheet bootstrap] error:', err);
    res.status(500).json({ error: 'Failed to load date sheet data.' });
  }
});

// POST /api/datesheet/publish (Admin only)
app.post('/api/datesheet/publish', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const branchId = req.user.branch_id || null;
    const { title, scope, rows, config } = req.body || {};

    if (!title || !scope || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'Missing title, scope, or rows.' });
    }

    const revRes = await pool.query(
      'SELECT COALESCE(MAX(revision), 0) + 1 AS next_rev FROM datesheets WHERE tenant_id = $1 AND scope = $2',
      [tenantId, scope]
    );
    const revision = parseInt(revRes.rows[0].next_rev, 10);

    const insertRes = await pool.query(
      'INSERT INTO datesheets (tenant_id, branch_id, title, scope, class_name, revision, data, published_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [
        tenantId,
        branchId,
        title.trim(),
        scope,
        scope === 'all' ? null : scope,
        revision,
        JSON.stringify({ rows, config: config || {} }),
        req.user.id
      ]
    );

    res.json({ ok: true, revision, datesheet: insertRes.rows[0] });
  } catch (err) {
    console.error('[datesheet publish] error:', err);
    res.status(500).json({ error: 'Failed to publish date sheet.' });
  }
});

// GET /api/datesheet/latest (Admin only)
app.get('/api/datesheet/latest', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const result = await pool.query(
      'SELECT id, title, scope, class_name, revision, data, published_at FROM datesheets WHERE tenant_id = $1 ORDER BY id DESC',
      [tenantId]
    );
    res.json({ ok: true, datesheets: result.rows });
  } catch (err) {
    console.error('[datesheet latest] error:', err);
    res.status(500).json({ error: 'Failed to fetch datesheets.' });
  }
});

// GET /api/datesheet/my-datesheet (Student, Teacher, Admin)
app.get('/api/datesheet/my-datesheet', requireAuth(['student', 'teacher', 'admin', 'super_admin']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const role = req.user.role;

    if (role === 'student') {
      const studentRes = await pool.query(
        'SELECT s.class_id, c.name, c.section FROM students s LEFT JOIN classes c ON s.class_id = c.id WHERE s.id = $1 AND s.tenant_id = $2',
        [req.user.id, tenantId]
      );
      if (!studentRes.rows.length || !studentRes.rows[0].class_id) {
        return res.json({ ok: true, datesheet: null, message: 'No class assigned.' });
      }
      const c = studentRes.rows[0];
      const classLabel = c.section ? `${c.name} (${c.section})` : c.name;

      const dsRes = await pool.query(
        'SELECT * FROM datesheets WHERE tenant_id = $1 AND (scope = $2 OR scope = $3 OR scope = \'all\') ORDER BY revision DESC, id DESC LIMIT 1',
        [tenantId, classLabel, c.name]
      );
      if (!dsRes.rows.length) {
        return res.json({ ok: true, datesheet: null });
      }
      const ds = dsRes.rows[0];
      const allRows = (ds.data && ds.data.rows) || [];
      const classRows = allRows.filter(r => r.cls === classLabel || r.cls === c.name);
      return res.json({
        ok: true,
        datesheet: {
          title: ds.title,
          revision: ds.revision,
          published_at: ds.published_at,
          className: classLabel,
          rows: classRows
        }
      });
    }

    if (role === 'teacher') {
      const teacherRes = await pool.query(
        'SELECT t.name, t.class_id, c.name as class_name, c.section as class_section FROM teachers t LEFT JOIN classes c ON t.class_id = c.id WHERE t.id = $1 AND t.tenant_id = $2',
        [req.user.id, tenantId]
      );
      const t = teacherRes.rows[0] || {};
      const classLabel = t.class_name ? (t.class_section ? `${t.class_name} (${t.class_section})` : t.class_name) : null;

      const dsRes = await pool.query(
        'SELECT * FROM datesheets WHERE tenant_id = $1 ORDER BY revision DESC, id DESC LIMIT 5',
        [tenantId]
      );
      if (!dsRes.rows.length) {
        return res.json({ ok: true, datesheet: null });
      }
      const ds = dsRes.rows[0];
      const allRows = (ds.data && ds.data.rows) || [];
      const teacherRows = allRows.filter(r => (classLabel && (r.cls === classLabel || r.cls === t.class_name)) || (t.name && r.t && r.t.toLowerCase() === t.name.toLowerCase()));
      return res.json({
        ok: true,
        datesheet: {
          title: ds.title,
          revision: ds.revision,
          published_at: ds.published_at,
          className: classLabel || 'All Classes',
          rows: teacherRows
        }
      });
    }

    // Admin / Super Admin
    const dsRes = await pool.query(
      'SELECT * FROM datesheets WHERE tenant_id = $1 ORDER BY revision DESC, id DESC LIMIT 1',
      [tenantId]
    );
    if (!dsRes.rows.length) return res.json({ ok: true, datesheet: null });
    const ds = dsRes.rows[0];
    res.json({
      ok: true,
      datesheet: {
        title: ds.title,
        revision: ds.revision,
        published_at: ds.published_at,
        scope: ds.scope,
        rows: (ds.data && ds.data.rows) || []
      }
    });
  } catch (err) {
    console.error('[datesheet my-datesheet] error:', err);
    res.status(500).json({ error: 'Failed to fetch your date sheet.' });
  }
});

// ============================================
// COMPLAINT ROUTES
// ============================================

// POST /api/complaints (Teacher or Student)
app.post('/api/complaints', requireAuth(['teacher', 'student']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const branchId = req.user.branch_id || null;
    const role = req.user.role; // Role strictly from login, never from URL or body

    if (role !== 'teacher' && role !== 'student') {
      return res.status(403).json({ error: 'Only teachers and students can submit complaints.' });
    }

    // Rate limit: maximum 5 complaints per hour per user
    const rateCheck = await pool.query(
      "SELECT COUNT(*) AS cnt FROM complaints WHERE tenant_id = $1 AND user_id = $2 AND created_at > NOW() - INTERVAL '1 hour'",
      [tenantId, req.user.id]
    );
    const count = parseInt(rateCheck.rows[0].cnt, 10);
    if (count >= 5) {
      return res.status(429).json({ error: 'Rate limit reached: maximum 5 complaints per hour.' });
    }

    const { category, subject, description, is_anonymous } = req.body || {};
    if (!category || !subject || !description) {
      return res.status(400).json({ error: 'Category, subject, and description are required.' });
    }

    const isAnon = Boolean(is_anonymous);
    const userId = isAnon ? null : req.user.id;
    const authorName = isAnon ? null : (req.user.name || `${role} ${req.user.id}`);

    const result = await pool.query(
      'INSERT INTO complaints (tenant_id, branch_id, role, user_id, author_name, category, subject, description, is_anonymous, status, admin_notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, status, created_at',
      [
        tenantId,
        branchId,
        role,
        userId,
        authorName,
        category.trim(),
        subject.trim(),
        description.trim(),
        isAnon,
        'pending',
        ''
      ]
    );

    res.json({ ok: true, message: 'Complaint submitted successfully.', complaint: result.rows[0] });
  } catch (err) {
    console.error('[complaints submit] error:', err);
    res.status(500).json({ error: 'Failed to submit complaint.' });
  }
});

// GET /api/complaints (Admin only)
app.get('/api/complaints', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { role, status, search } = req.query || {};

    let query = 'SELECT id, tenant_id, branch_id, role, author_name, category, subject, description, is_anonymous, status, admin_notes, created_at, updated_at FROM complaints WHERE tenant_id = $1';
    const params = [tenantId];

    if (role) {
      params.push(role);
      query += ` AND role = $${params.length}`;
    }
    if (status && status !== 'all') {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.trim()}%`);
      query += ` AND (subject ILIKE $${params.length} OR description ILIKE $${params.length} OR category ILIKE $${params.length})`;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json({ ok: true, complaints: result.rows });
  } catch (err) {
    console.error('[complaints get] error:', err);
    res.status(500).json({ error: 'Failed to fetch complaints.' });
  }
});

// PATCH /api/complaints/:id (Admin only)
app.patch('/api/complaints/:id', requireAuth(['admin', 'super_admin']), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const id = parseInt(req.params.id, 10);
    const { status, admin_notes } = req.body || {};

    const updates = [];
    const params = [id, tenantId];

    if (status !== undefined) {
      params.push(status);
      updates.push(`status = $${params.length}`);
    }
    if (admin_notes !== undefined) {
      params.push(admin_notes);
      updates.push(`admin_notes = $${params.length}`);
    }
    params.push(new Date());
    updates.push(`updated_at = $${params.length}`);

    if (!updates.length) return res.json({ ok: true });

    await pool.query(
      `UPDATE complaints SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2`,
      params
    );

    res.json({ ok: true, message: 'Complaint updated.' });
  } catch (err) {
    console.error('[complaints patch] error:', err);
    res.status(500).json({ error: 'Failed to update complaint.' });
  }
});




// ============================================
// API ERROR HANDLER + CATCH-ALL 404
//
// These MUST be registered after every route. Express matches middleware in
// registration order, so a catch-all placed earlier answers /api/datesheet/*
// and /api/complaints/* with 404 before their real handlers ever run.
// ============================================
// ============================================
// JSON ERROR HANDLER — ensures API routes always
// return JSON, never HTML (Express 5 default
// error handler sends HTML in development mode)
// ============================================
app.use('/api', (err, req, res, next) => {
  console.error('API error:', err)
  if (res.headersSent) return next(err)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

// Catch-all: return 404 JSON for any unmatched /api routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` })
})
