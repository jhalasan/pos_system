import { useEffect, useState } from 'react'
import { adminDb, initializeAdminDb } from '../admin-page/offline/db'
import styles from './SupportContactModal.module.css'

const reasons = [
  'Unable to log in',
  'Barcode scanner or printer issue',
  'Product or inventory issue',
  'Checkout or payment issue',
  'Sync or internet connection issue',
  'Report or transaction issue',
  'Other',
]

export default function SupportContactModal({ open, onClose, source = 'POS System' }) {
  const [reason, setReason] = useState(reasons[0])
  const [description, setDescription] = useState('')
  const [images, setImages] = useState([])
  const [ticketCreated, setTicketCreated] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL || 'nexasystems6@gmail.com'
  const supportPhone = import.meta.env.VITE_SUPPORT_PHONE || 'Contact number not configured'
  const isDesktop = Boolean(globalThis.__TAURI_INTERNALS__ || globalThis.__TAURI__)
  const supportApiUrl = String(import.meta.env.VITE_SUPPORT_API_URL || (isDesktop
    ? 'https://pos-system-taupe-eight.vercel.app/api'
    : '/api')).replace(/\/$/, '')

  useEffect(() => () => images.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [images])

  if (!open) return null

  function selectImages(event) {
    images.forEach((image) => URL.revokeObjectURL(image.previewUrl))
    const selectedFiles = [...(event.target.files || [])].slice(0, 5)
    const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0)
    if (selectedFiles.some((file) => file.size > 2 * 1024 * 1024) || totalBytes > 3.5 * 1024 * 1024) {
      setSendError('Each image must be 2 MB or smaller, with a combined maximum of 3.5 MB.')
      event.target.value = ''
      setImages([])
      return
    }
    setSendError('')
    const selected = selectedFiles.map((file) => ({
      file,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
    }))
    setImages(selected)
  }

  async function submit(event) {
    event.preventDefault()
    if (!description.trim()) return
    setSending(true)
    setSendError('')
    const ticket = {
      id: `NEXA-${Date.now().toString(36).toUpperCase()}`,
      source,
      reason,
      description: description.trim(),
      status: 'sending',
      createdAt: new Date().toISOString(),
      attachments: images.map(({ file, name }) => ({ name, type: file.type, size: file.size, blob: file })),
    }
    try {
      await initializeAdminDb()
      await adminDb.supportTickets.put(ticket)
      const body = new FormData()
      body.append('id', ticket.id)
      body.append('source', ticket.source)
      body.append('reason', ticket.reason)
      body.append('description', ticket.description)
      images.forEach(({ file }) => body.append('attachments', file, file.name))
      const response = await fetch(`${supportApiUrl}/support/tickets`, { method: 'POST', body })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.delivered) throw new Error(result.error || `Support server returned HTTP ${response.status}.`)
      await adminDb.supportTickets.update(ticket.id, { status: 'sent', sentAt: new Date().toISOString() })
      setTicketCreated(ticket.id)
      setDescription('')
      setImages([])
    } catch (error) {
      await adminDb.supportTickets.update(ticket.id, { status: 'failed', lastError: error.message }).catch(() => {})
      const message = error instanceof TypeError && /fetch/i.test(error.message || '')
        ? 'The support email service could not be reached. Check the internet connection or server deployment.'
        : (error.message || 'Unable to deliver the ticket.')
      setSendError(`${message} The ticket remains saved on this device.`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="support-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <div><h2 id="support-title">Contact support</h2><p>Send a support ticket directly to the NEXA Systems team.</p></div>
          <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={styles.contacts}>
          <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
          {supportPhone.startsWith('Contact') ? <span>{supportPhone}</span> : <a href={`tel:${supportPhone}`}>{supportPhone}</a>}
        </div>
        {ticketCreated && <div className={styles.success}>Ticket {ticketCreated} was emailed successfully.</div>}
        {sendError && <div className={styles.error} role="alert">{sendError}</div>}
        <form className={styles.form} onSubmit={submit}>
          <label>Reason<select value={reason} onChange={(event) => setReason(event.target.value)}>{reasons.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Description<textarea rows="5" required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Tell us what happened, what you expected, and any error shown." /></label>
          <label>
            Screenshots or images
            <input type="file" accept="image/*" multiple onChange={selectImages} />
            <small>Up to 5 images. Each image must be 2 MB or smaller; combined attachments must not exceed 3.5 MB.</small>
          </label>
          {images.length > 0 && <div className={styles.previews}>{images.map((image) => <figure key={image.previewUrl}><img src={image.previewUrl} alt={image.name} /><figcaption>{image.name}</figcaption></figure>)}</div>}
          <div className={styles.actions}><button type="button" className={styles.cancel} onClick={onClose} disabled={sending}>Cancel</button><button type="submit" className={styles.submit} disabled={sending}>{sending ? 'Sending…' : 'Send Ticket'}</button></div>
        </form>
      </section>
    </div>
  )
}
