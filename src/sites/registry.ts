/**
 * Adapter registry.
 *
 * Order matters: the first adapter whose `matches` returns true wins, and the
 * generic adapter is last so it only ever runs as a fallback.
 */

import type { SiteAdapter } from './types'
import { greenhouseAdapter } from './greenhouse'
import { leverAdapter } from './lever'
import { ashbyAdapter } from './ashby'
import { workableAdapter } from './workable'
import { smartRecruitersAdapter } from './smartrecruiters'
import { workdayAdapter } from './workday'
import { indeedAdapter, naukriAdapter } from './boards'
import { genericAdapter } from './generic'

export const ADAPTERS: SiteAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workableAdapter,
  smartRecruitersAdapter,
  workdayAdapter,
  indeedAdapter,
  naukriAdapter,
  genericAdapter,
]

export function adapterForUrl(url: string): SiteAdapter {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.matches(url)) return adapter
    } catch {
      // A malformed URL should not take the whole registry down.
    }
  }
  return genericAdapter
}

export function adapterById(id: string): SiteAdapter {
  return ADAPTERS.find((a) => a.id === id) ?? genericAdapter
}

/** Vendor id from a URL, without needing the adapter object. */
export function vendorForUrl(url: string): string {
  return adapterForUrl(url).id
}

export const VENDOR_IDS = ADAPTERS.map((a) => a.id)

export const VENDOR_LABELS: Record<string, string> = Object.fromEntries(
  ADAPTERS.map((a) => [a.id, a.label])
)
