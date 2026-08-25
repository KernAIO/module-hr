import { getHost } from '@kernhq/ui'
import { createHrClient, type HrApi } from './index.js'
import { createMockHrApi } from './mock.js'

/**
 * This module's API client.
 *
 * An empty base URL keeps requests same-origin, so the dev proxy and the reverse proxy both work
 * without CORS. `PUBLIC_API_MOCK=1` swaps in the in-memory implementation, which satisfies the same
 * contract types — so no screen has a second code path for demos and end-to-end tests.
 */
export type { HrApi }

let cached: HrApi | null = null

export function getHrApi(): HrApi {
  if (cached) return cached
  cached = getHost().isMock
    ? (createMockHrApi() as unknown as HrApi)
    : createHrClient({
        baseUrl: getHost().apiBaseUrl,
      })
  return cached
}

/** Test seam. */
export function __setHrApi(api: HrApi | null) {
  cached = api
}
