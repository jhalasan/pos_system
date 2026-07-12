const TERMINAL_ID_KEY = 'nexa_terminal_id'
const TERMINAL_NAME_KEY = 'nexa_terminal_name'

function randomSuffix() {
  return globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 6).toUpperCase()
    || Math.random().toString(36).slice(2, 8).toUpperCase()
}

export function getTerminalId() {
  let id = localStorage.getItem(TERMINAL_ID_KEY)
    || localStorage.getItem('nexa_cashier_device_id')
  if (!id) {
    id = `POS-${randomSuffix()}`
    localStorage.setItem(TERMINAL_ID_KEY, id)
  }
  localStorage.setItem('nexa_cashier_device_id', id)
  return id
}

export function getTerminalName() {
  return localStorage.getItem(TERMINAL_NAME_KEY) || getTerminalId()
}

export function setTerminalName(value) {
  const name = String(value || '').trim() || getTerminalId()
  localStorage.setItem(TERMINAL_NAME_KEY, name)
  globalThis.dispatchEvent?.(new CustomEvent('nexa-terminal-changed', { detail: { name } }))
  return name
}
