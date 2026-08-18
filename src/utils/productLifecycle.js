import { normalizeSellingUnits } from './sellingUnits.js'

// Inventory's "Total Products" stat and Dashboard's stock-related stats
// (critical alerts, current stock units, in-stock/low/critical/out-of-stock
// breakdown) used to count every product Dexie/PocketBase had a row for,
// including ones marked archived or deleted (see M9 in POS_AUDIT_REGISTER.md
// for how a product ends up in that state instead of being hard-deleted).
// An archived or deleted product isn't part of the sellable catalog anymore,
// so it shouldn't inflate "how many products do I stock" or trigger a
// restock alert for stock it will never sell again.
//
// Deliberately narrow: only 'archived' and 'deleted' are excluded.
// 'inactive' still counts -- that status means temporarily disabled, not
// removed, and sales-history lookups (resolving a past sale's product name,
// FSN classification) must keep using the *unfiltered* product list, since a
// product sold before being archived still needs to resolve correctly in
// historical reports.
const HIDDEN_CATALOG_LIFECYCLE_STATUSES = new Set(['archived', 'deleted'])

export function isCatalogActive(product) {
  const status = product?.lifecycleStatus || product?.lifecycle_status || 'active'
  return !HIDDEN_CATALOG_LIFECYCLE_STATUSES.has(status)
}

// The database's barcode uniqueness constraint (idx_products_barcode_nonempty
// in pocketbase/pb_schema.json) applies to every product row regardless of
// lifecycle_status -- an archived product still "owns" its barcode forever,
// even though it's no longer sellable and the client wants to put that
// physical barcode label on a new item. A genuinely hard-deleted product has
// no row left at all, so it never hits this: only archived/deleted-but-not-
// yet-hard-deleted products can be sitting on a barcode someone wants back.
export function findArchivedBarcodeOwner(products, barcodes, excludeId = null) {
  const wanted = new Set((barcodes || []).filter(Boolean))
  if (!wanted.size) return null
  return (products || []).find((product) => (
    product.id !== excludeId
    && HIDDEN_CATALOG_LIFECYCLE_STATUSES.has(product.lifecycleStatus || product.lifecycle_status || 'active')
    && getProductBarcodes(product).some((barcode) => wanted.has(barcode))
  )) || null
}

export function getProductBarcodes(product) {
  return [...new Set(normalizeSellingUnits(product).map((unit) => unit.barcode).filter(Boolean))]
}

// Frees every barcode on an archived product so a new/edited product can
// take one over, without violating the "barcode is required" rule that
// normal edits enforce (see assertRequiredProductFields) -- a real empty
// string would fail that check, so each barcode is replaced with a unique
// placeholder instead of cleared outright. The product stays fully findable
// by name/SKU in Inventory; it just stops being reachable by scan, which is
// correct for something that's been retired from the sellable catalog.
export function releasedBarcodePayload(product) {
  const placeholder = `RELEASED-${product.id}`
  return {
    barcode: placeholder,
    sellingUnits: normalizeSellingUnits(product).map((unit, index) => (
      unit.barcode ? { ...unit, barcode: `${placeholder}-${index}` } : unit
    )),
  }
}
