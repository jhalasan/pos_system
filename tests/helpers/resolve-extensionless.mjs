// Node's ESM loader requires full file specifiers ("./db.js"), but several
// modules under src/admin-page/offline and src/cashier-pos/offline import
// local siblings without the extension (e.g. "./db"). That resolves fine
// under Vite's bundler (which the app actually ships with) but not under
// plain `node --test`, so tests that transitively import those modules
// (e.g. AdminSyncEngine, CashierSyncEngine) fail to load at all.
//
// Rather than touch the extensionless imports app-wide — a large,
// unrelated change — this loader hook retries a failed relative-specifier
// resolution with ".js" appended, scoped to the test run only.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    const looksExtensionless = !/\.[a-zA-Z0-9]+$/.test(specifier)
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelative && looksExtensionless) {
      return nextResolve(`${specifier}.js`, context)
    }
    throw error
  }
}
