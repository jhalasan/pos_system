// Shared by both admin desktopApi.js's dashboard() and receipts fetch.
// Batches an id-based OR-filter fetch into chunks small enough to stay well
// under PocketBase's filter-length limit, instead of joining every id into
// one giant OR filter. Confirmed live: 5,953 sale ids in one filter produced
// a ~184,000-character query string, and PocketBase rejected it outright
// with a 400 -- exactly what broke the Vercel admin Dashboard ("Unable to
// load dashboard: Something went wrong") once this store's sales volume
// grew past a few days' worth. The identical join exists here on the
// desktop side, just not yet observed failing because typical date ranges
// selected in the desktop UI stayed smaller -- fixed proactively rather
// than waiting for it to happen here too.
//
// This preserves EXACT id-join precision (unlike filtering the target
// collection by its own `created` timestamp, which would silently miss
// rows belonging to a sale that synced late after being made offline --
// sale_items has no app-set created_at of its own, only PocketBase's
// insert-time `created`, which can lag the parent sale's real time by
// however long the device was offline). Chunks run with limited
// concurrency so a wide date range doesn't fire dozens of requests at once.
//
// chunkSize=80 was picked by directly bisecting against the live server:
// a 100-id filter (3,096 chars) succeeded, a 150-id filter (4,646 chars)
// was rejected with the same 400 -- the real limit sits well below what a
// naive "PocketBase's default max header/URL size is ~8KB" assumption would
// suggest (likely the Tailscale Funnel reverse proxy in front of it, not
// PocketBase itself). 80 leaves real margin under the confirmed-working 100.
export async function fetchByIdChunks(pb, collectionName, idField, ids, { expand, sort, requestKeyPrefix, concurrency = 12, chunkSize = 80 } = {}) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return []

  const chunks = []
  for (let i = 0; i < uniqueIds.length; i += chunkSize) chunks.push(uniqueIds.slice(i, i + chunkSize))

  const collection = pb.collection(collectionName)
  const results = []
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map((chunk, batchIndex) => {
      const filter = chunk.map((id) => pb.filter(`${idField} = {:id}`, { id })).join(' || ')
      return collection.getFullList({
        filter,
        ...(expand ? { expand } : {}),
        ...(sort ? { sort } : {}),
        requestKey: requestKeyPrefix ? `${requestKeyPrefix}:${i + batchIndex}` : null,
      })
    }))
    for (const items of batchResults) results.push(...items)
  }
  return results
}
