// The one shared governor instance for the whole app. Every paced
// PocketBase client (admin and cashier alike, across every module that
// constructs one) must be wrapped with THIS instance, not a fresh
// `createGovernor()` call of its own — a governor per call site would mean
// a separate in-memory token bucket per site, which defeats the entire
// point of Task 1's design (one shared pacing budget against PocketHost,
// mirrored cross-window via `storage` under the module's default key).
//
// `pocketbaseRateLimit.js` delegates to this same instance so legacy
// callers of that facade observe the exact same rate-limit state as every
// paced client.
import { createGovernor } from './pocketbaseGovernor'

export const sharedGovernor = createGovernor()
