// S7: DELETE /api/cashiers/:id (and the Tauri app's own local deleteCashier,
// a separate code path talking to PocketBase directly) had no guard at all
// -- either would happily delete the caller's own account, or the last
// remaining admin, locking everyone out of the admin area with no recovery
// path short of direct PocketBase access. Shared here so both call sites
// enforce the identical rule instead of two hand-written copies drifting
// apart over time.
//
// Returns a human-readable error message if the deletion must be blocked,
// or null if it's allowed to proceed.
export function accountDeletionError({ targetId, callerId, targetRole, otherAdminCount }) {
  if (callerId && String(targetId) === String(callerId)) {
    return 'You cannot delete your own account.'
  }
  if (targetRole === 'admin' && Number(otherAdminCount) === 0) {
    return 'Cannot delete the last remaining admin account.'
  }
  return null
}
