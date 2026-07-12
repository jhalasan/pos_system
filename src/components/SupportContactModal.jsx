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
  const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL || 'nexasystems6@gmail.com'
  const supportPhone = import.meta.env.VITE_SUPPORT_PHONE || 'Contact number not configured'

  useEffect(() => () => images.forEach((image) => URL.revokeObjectURL(image.previewUrl)), [images])

  if (!open) return null

  function selectImages(event) {
    images.forEach((image) => URL.revokeObjectURL(image.previewUrl))
    const selected = [...(event.target.files || [])].slice(0, 5).map((file) => ({
      file,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
    }))
    setImages(selected)
  }

  async function submit(event) {
    event.preventDefault()
    if (!description.trim()) return
    const ticket = {
      id: `NEXA-${Date.now().toString(36).toUpperCase()}`,
      source,
      reason,
      description: description.trim(),
      status: 'new',
      createdAt: new Date().toISOString(),
      attachments: images.map(({ file, name }) => ({ name, type: file.type, size: file.size, blob: file })),
    }
    await initializeAdminDb()
    await adminDb.supportTickets.put(ticket)
    setTicketCreated(ticket.id)

    const attachmentNames = images.length
      ? `\n\nScreenshots saved locally with this ticket:\n${images.map((image) => `- ${image.name}`).join('\n')}\nPlease attach these files in your email app before sending.`
      : ''
    const subject = encodeURIComponent(`[${ticket.id}] ${reason}`)
    const body = encodeURIComponent(`Ticket: ${ticket.id}\nSource: ${source}\nReason: ${reason}\n\n${ticket.description}${attachmentNames}`)
    window.location.href = `mailto:${supportEmail}?subject=${subject}&body=${body}`
  }

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="support-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <div><h2 id="support-title">Contact support</h2><p>Create a ticket and open it in your email app.</p></div>
          <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={styles.contacts}>
          <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
          {supportPhone.startsWith('Contact') ? <span>{supportPhone}</span> : <a href={`tel:${supportPhone}`}>{supportPhone}</a>}
        </div>
        {ticketCreated && <div className={styles.success}>Ticket {ticketCreated} was saved locally. Complete sending it in your email app.</div>}
        <form className={styles.form} onSubmit={submit}>
          <label>Reason<select value={reason} onChange={(event) => setReason(event.target.value)}>{reasons.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Description<textarea rows="5" required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Tell us what happened, what you expected, and any error shown." /></label>
          <label>
            Screenshots or images
            <input type="file" accept="image/*" multiple onChange={selectImages} />
            <small>Up to 5 images. Your email app cannot receive automatic attachments, so attach the selected files there before sending.</small>
          </label>
          {images.length > 0 && <div className={styles.previews}>{images.map((image) => <figure key={image.previewUrl}><img src={image.previewUrl} alt={image.name} /><figcaption>{image.name}</figcaption></figure>)}</div>}
          <div className={styles.actions}><button type="button" className={styles.cancel} onClick={onClose}>Cancel</button><button type="submit" className={styles.submit}>Create Ticket</button></div>
        </form>
      </section>
    </div>
  )
}
