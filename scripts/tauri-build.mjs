import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cargoBin = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin')
const env = { ...process.env }

if (existsSync(cargoBin)) {
  env.Path = `${cargoBin}${delimiter}${env.Path ?? env.PATH ?? ''}`
  env.PATH = env.Path
}

if (process.platform === 'win32') {
  const result = spawnSync('taskkill', ['/IM', 'nexa-pos-cashier.exe', '/F'], {
    encoding: 'utf8',
    stdio: 'pipe',
  })

  if (result.status === 0) {
    console.log('Closed running nexa-pos-cashier.exe before bundling.')
  }
}

const tauriCli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url))
const child = spawn(process.execPath, [tauriCli, 'build', '--bundles', 'nsis'], {
  env,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
