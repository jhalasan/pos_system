import multer from 'multer'
import nodemailer from 'nodemailer'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 2 * 1024 * 1024, fieldSize: 20 * 1024 },
})

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.array('attachments', 5)(req, res, (error) => (error ? reject(error) : resolve()))
  })
}

function allowCors(req, res) {
  const requestedHeaders = req.headers['access-control-request-headers']
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', requestedHeaders || 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '86400')
}

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  allowCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' })

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
    const message = error?.code === 'LIMIT_FILE_SIZE'
      ? 'Each support attachment must be 2 MB or smaller.'
      : (error?.message || 'Unable to send the support email.')
    return res.status(error?.code?.startsWith?.('LIMIT_') ? 413 : 500).json({ error: message })
  }
}
