export async function activityLogPayloadForSync(payload, resolveUserId) {
  const activityPayload = { ...(payload || {}) }

  // Offline login records can outlive the cashier account they reference
  // (for example after test data is replaced). The relation is optional in
  // PocketBase, so preserve the audit entry without a broken user_id rather
  // than leaving it in the queue forever.
  const userId = await resolveUserId(activityPayload.user_id)
  if (userId) activityPayload.user_id = userId
  else delete activityPayload.user_id

  return activityPayload
}
