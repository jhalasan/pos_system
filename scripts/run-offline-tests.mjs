// H2: test:offline used to be a hand-maintained list of test files in
// package.json. New test files silently never ran unless someone remembered
// to add them there -- 9 test files had drifted out of sync with the list
// by the time this was caught (see POS_AUDIT_REGISTER.md). This discovers
// every tests/*.test.js file automatically instead.
//
// admin-vercel-boundary.test.js is excluded on purpose, not by oversight: it
// exercises a different testing concern (the Vercel remote-admin-portal
// CORS/route boundary) and has its own named script, `npm run test:vercel`,
// for clarity. It is safe to run in the same process group as everything
// else here too (node:test isolates each test file in its own process), but
// keeping it separate keeps the two scripts' intent distinct.

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'

const EXCLUDED = new Set(['admin-vercel-boundary.test.js'])

const entries = await readdir('tests')
const testFiles = entries
  .filter((name) => name.endsWith('.test.js') && !EXCLUDED.has(name))
  .sort()
  .map((name) => `tests/${name}`)

if (testFiles.length === 0) {
  console.error('No test files found in tests/.')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  ['--import', './tests/helpers/register-loader.mjs', '--test', ...testFiles],
  { stdio: 'inherit' },
)

child.on('exit', (code) => process.exit(code ?? 1))
