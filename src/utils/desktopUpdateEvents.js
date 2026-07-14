export const MANUAL_UPDATE_CHECK_EVENT = 'nexa:check-for-update'
export const UPDATE_CHECK_RESULT_EVENT = 'nexa:update-check-result'

export function requestUpdateCheck() {
  window.dispatchEvent(new CustomEvent(MANUAL_UPDATE_CHECK_EVENT))
}
