function csvValue(value) {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvValue).join(',')).join('\n')
}

function browserDownload(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke
}

export async function exportCsv(filename, rows, { directory = '' } = {}) {
  const csv = toCsv(rows)
  const invoke = tauriInvoke()

  if (invoke && directory.trim()) {
    const path = await invoke('write_export_file', {
      directory: directory.trim(),
      filename,
      contents: csv,
    })
    return { path, method: 'file' }
  }

  browserDownload(filename, csv)
  return {
    path: directory.trim() ? `${directory.trim()}\\${filename}` : `Downloads\\${filename}`,
    method: 'download',
  }
}

export function downloadCsv(filename, rows) {
  browserDownload(filename, toCsv(rows))
}
