// Where a cashier barcode is verified, and in what order.
//
// 1. The store's own PocketBase (pb_hooks/nexa_barcode_login.pb.js). It needs
//    only the local network, and issues a normal renewable 7-day session.
// 2. The Vercel API (POST /api/cashier/auth/barcode), as before. It needs the
//    internet and issues a 12-hour session, but it exists on every deployment,
//    including stores that have not installed the hook yet.
//
// Why the order matters: when only (2) was available, an internet or Vercel
// outage meant the barcode could not be verified, the terminal fell back to an
// old saved session that had already expired, and every sale then waited
// (sometimes for hours) until a cashier signed in with an email and password.
//
// A 401 from the store server is a FINAL answer -- that server has just looked
// the barcode up and it is not an active cashier -- so it is never retried
// against the cloud. Every other failure (the hook is not installed: 404, the
// server is busy: 5xx/429, a network error, an unexpected reply) falls through
// to the cloud route, exactly as the terminal behaved before the hook existed.

export const LAN_BARCODE_LOGIN_PATH = '/api/nexa/barcode-login'

export async function requestBarcodeSession({ barcode, lan, cloud, allowCloud = true }) {
  let lanFailure
  try {
    const result = await lan(barcode)
    if (result?.user?.token) return { result, via: 'lan' }
    lanFailure = new Error('The store server returned no session for this barcode.')
  } catch (error) {
    if (Number(error?.status) === 401) throw error
    lanFailure = error
  }

  if (!allowCloud) {
    // Background retries use this to spare the cloud route's shared
    // 8-attempts-per-5-minutes limit; status 0 reads as "could not verify".
    const skipped = new Error('Cloud barcode verification was skipped for now.')
    skipped.status = 0
    skipped.cause = lanFailure
    throw skipped
  }

  return { result: await cloud(barcode), via: 'cloud' }
}
