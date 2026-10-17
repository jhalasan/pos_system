// Decides how a manager approval (void, discount, cash in/out) is verified.
//
// Online approval calls /api/cashier/authorize-void with THIS CASHIER's cloud
// token. When the cashier's session has no valid cloud login (the "Login
// required" banner), the server rejects every such call with 401 --
// "Authentication is required" -- which says nothing about the manager's code,
// yet it used to be shown as the approval failing. So the client saw the void
// "but it can't be confirmed". In that state the approval goes straight to the
// offline manager-barcode check, which verifies the barcode against the cached
// one-way hashes exactly as it does when the terminal has no internet. A wrong
// barcode is still rejected there. Email/password approval has no offline
// equivalent, so it gets a message that says what to do instead.

export const CASHIER_SESSION_APPROVAL_MESSAGE = 'This cashier is not signed in to the cloud, so a manager email and password cannot be checked. Scan the manager barcode instead, or sign out and sign in again with the cashier email and password.'
export const OFFLINE_PASSWORD_APPROVAL_MESSAGE = 'Manager approval by email and password requires an internet connection. Use a manager barcode instead, or reconnect.'

export function managerApprovalRoute({ offline, rateLimited, sessionAuthorized, usePassword }) {
  if (!offline && !rateLimited && sessionAuthorized) return { route: 'online' }
  if (usePassword) {
    const onlineButSignedOut = !offline && !rateLimited && !sessionAuthorized
    return { route: 'error', message: onlineButSignedOut ? CASHIER_SESSION_APPROVAL_MESSAGE : OFFLINE_PASSWORD_APPROVAL_MESSAGE }
  }
  return { route: 'offline-barcode' }
}
