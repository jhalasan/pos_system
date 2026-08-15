// Shared by both admin and cashier desktopApi.js. Given a flat list of
// sale_items records (however fetched — one bulk getFullList() covering
// every sale, ideally), groups them by their sale_id relation so a caller
// can look up "the items for sale X" in memory instead of firing one
// request per sale. That N+1 pattern reliably exceeds PocketHost's per-IP
// concurrent-request cap once there are more than a handful of sales,
// silently dropping line items on the overflowed requests.
export function groupSaleItemsBySaleId(items) {
  const map = new Map()
  for (const item of items) {
    const saleId = Array.isArray(item.sale_id ?? item.saleId)
      ? (item.sale_id ?? item.saleId)[0]
      : (item.sale_id ?? item.saleId)
    if (!saleId) continue
    const list = map.get(saleId) || []
    list.push(item)
    map.set(saleId, list)
  }
  return map
}
