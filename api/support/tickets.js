import multer from 'multer'
import nodemailer from 'nodemailer'

// S4: this endpoint sends mail through the business's own SMTP credential
// and must work for a cashier who isn't logged in (support has to be
// reachable even when login itself is the problem), so it can't require
// auth. Before this fix it also had Access-Control-Allow-Origin: '*' with
// no rate limit and no attachment type filter -- an open, unrestricted mail
// relay reachable by anyone who found the URL, browser or script. Origin
// restriction alone would not have been sufficient on its own (a non-browser
// caller can send any Origin header it likes, or none), so the primary
// control is the per-IP rate limit below; origin restriction and the
// attachment filter are added hardening on top of it, not a substitute.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 2 * 1024 * 1024, fieldSize: 20 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(new Error('Support attachments must be JPEG, PNG, or WEBP images.'))
      return
    }
    cb(null, true)
  },
})

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.array('attachments', 5)(req, res, (error) => (error ? reject(error) : resolve()))
  })
}

// Legitimate callers: the deployed web app calling its own origin (same-
// origin requests carry no Origin header at all, so CORS doesn't apply to
// them), and the desktop (Tauri) app, which calls this Vercel URL
// cross-origin from a fixed tauri:// origin -- same set as desktopOrigins in
// server/index.js, kept in sync manually since this is a standalone
// serverless function that doesn't import that module.
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const desktopOrigins = new Set(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'])

function allowCors(req, res) {
  const origin = req.headers.origin
  const requestedHeaders = req.headers['access-control-request-headers']
  if (!origin || allowedOrigins.includes(origin) || desktopOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', requestedHeaders || 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '86400')
}

// Minimal in-memory sliding-window limiter, same design as server/index.js's
// checkRateLimit (single-process, resets on restart) -- with the added
// caveat that a serverless deployment may run several concurrent instances,
// each with its own copy of this Map, so this is a soft/best-effort bound
// per instance rather than a hard global cap. Still meaningfully raises the
// cost of abusing this as a mail relay compared to no limit at all.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT_MAX_ATTEMPTS = 8
const rateLimitAttempts = new Map()

function checkRateLimit(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
  const now = Date.now()
  const attempts = (rateLimitAttempts.get(ip) || []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)
  if (attempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    res.status(429).json({ error: 'Too many support requests from this connection. Try again in a few minutes.' })
    return false
  }
  attempts.push(now)
  rateLimitAttempts.set(ip, attempts)
  return true
}

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  allowCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' })
  if (!checkRateLimit(req, res)) return

  try {
    await runUpload(req, res)
    const smtpHost = String(process.env.SMTP_HOST || '').trim()
    const smtpUser = String(process.env.SMTP_USER || '').trim()
    const smtpPass = String(process.env.SMTP_PASS || '').trim()
    const recipient = String(process.env.SUPPORT_EMAIL_TO || smtpUser).trim()
    if (!smtpHost || !smtpUser || !smtpPass || !recipient) {
      return res.status(503).json({ error: 'Direct support email is not configured on the server.' })
    }

    const ticketId = String(req.body?.id || '').trim().slice(0, 80)
    const source = String(req.body?.source || 'POS System').trim().slice(0, 120)
    const reason = String(req.body?.reason || 'Other').trim().slice(0, 160)
    const description = String(req.body?.description || '').trim().slice(0, 10000)
    if (!ticketId || !description) return res.status(400).json({ error: 'Ticket ID and description are required.' })

    const files = Array.isArray(req.files) ? req.files : []
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    if (totalBytes > 3.5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Combined support attachments must be 3.5 MB or smaller.' })
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
      auth: { user: smtpUser, pass: smtpPass },
    })
    await transporter.sendMail({
      from: process.env.SUPPORT_EMAIL_FROM || `NEXA POS Support <${smtpUser}>`,
      to: recipient,
      replyTo: smtpUser,
      subject: `[${ticketId}] ${reason}`,
      text: `Ticket: ${ticketId}\nSource: ${source}\nReason: ${reason}\nCreated: ${new Date().toISOString()}\n\n${description}`,
      attachments: files.map((file) => ({
        filename: file.originalname,
        content: file.buffer,
        contentType: file.mimetype,
      })),
    })
    return res.status(201).json({ id: ticketId, delivered: true })
  } catch (error) {
    const isAttachmentLimitError = error?.code?.startsWith?.('LIMIT_')
    const isAttachmentTypeError = /must be JPEG, PNG, or WEBP/.test(error?.message || '')
    const isSmtpAuthError = error?.code === 'EAUTH' || /535[- ]5\.7\.8|username and password not accepted/i.test(error?.message || '')
    const message = error?.code === 'LIMIT_FILE_SIZE'
      ? 'Each support attachment must be 2 MB or smaller.'
      : isAttachmentTypeError
        ? error.message
        : isSmtpAuthError
          ? 'The support email service is not authenticated. Ask the system administrator to update the Gmail App Password in Vercel.'
          : 'The support email could not be sent right now. Please try again later.'
    const status = isAttachmentLimitError ? 413 : isAttachmentTypeError ? 415 : 502
    return res.status(status).json({ error: message })
  }
}
