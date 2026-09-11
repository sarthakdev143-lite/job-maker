/**
 * Settings, profile and search recipes live in chrome.storage.local.
 *
 * They are small, read on nearly every operation, and must survive an
 * IndexedDB reset. Every read parses through the zod schema and falls back to
 * defaults, so a partially-written or older-shaped record can never crash the
 * service worker on startup.
 */

import {
  ProfileSchema,
  SearchRecipeSchema,
  SettingsSchema,
  type Profile,
  type SearchRecipe,
  type Settings,
} from './schemas'
import { DEFAULT_PROMPTS, seedRecipes } from './defaults'

const KEYS = {
  settings: 'settings',
  profile: 'profile',
  recipes: 'recipes',
  agentState: 'agentState',
  counters: 'counters',
} as const

export function defaultSettings(): Settings {
  const base = SettingsSchema.parse({})
  base.prompts = { ...DEFAULT_PROMPTS }
  return base
}

export function defaultProfile(): Profile {
  return ProfileSchema.parse({})
}

async function readRaw<T>(key: string): Promise<T | undefined> {
  const bag = await chrome.storage.local.get(key)
  return bag[key] as T | undefined
}

/* --------------------------------------------------------------- settings */

export async function getSettings(): Promise<Settings> {
  const raw = await readRaw<unknown>(KEYS.settings)
  const parsed = SettingsSchema.safeParse(raw ?? {})
  const settings = parsed.success ? parsed.data : defaultSettings()
  // An empty prompt means "use the shipped default" rather than "send nothing".
  for (const key of Object.keys(DEFAULT_PROMPTS) as Array<keyof typeof DEFAULT_PROMPTS>) {
    if (!settings.prompts[key] || !settings.prompts[key].trim()) {
      settings.prompts[key] = DEFAULT_PROMPTS[key]
    }
  }
  return settings
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const parsed = SettingsSchema.parse(settings)
  await chrome.storage.local.set({ [KEYS.settings]: parsed })
  return parsed
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  return saveSettings({ ...current, ...patch })
}

/* ---------------------------------------------------------------- profile */

export async function getProfile(): Promise<Profile> {
  const raw = await readRaw<unknown>(KEYS.profile)
  const parsed = ProfileSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : defaultProfile()
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const parsed = ProfileSchema.parse(profile)
  await chrome.storage.local.set({ [KEYS.profile]: parsed })
  return parsed
}

/** True when the profile has the minimum an ATS will demand. */
export function profileIsUsable(p: Profile): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (!p.firstName.trim()) missing.push('first name')
  if (!p.lastName.trim()) missing.push('last name')
  if (!p.email.trim()) missing.push('email')
  if (!p.phone.trim()) missing.push('phone')
  if (!p.masterResumeText.trim() && p.experience.length === 0) missing.push('resume text or at least one role')
  return { ok: missing.length === 0, missing }
}

/* ---------------------------------------------------------------- recipes */

export async function getRecipes(): Promise<SearchRecipe[]> {
  const raw = await readRaw<unknown[]>(KEYS.recipes)
  if (!Array.isArray(raw)) {
    const seeded = seedRecipes()
    await chrome.storage.local.set({ [KEYS.recipes]: seeded })
    return seeded
  }
  return raw
    .map((r) => {
      const parsed = SearchRecipeSchema.safeParse(r)
      return parsed.success ? parsed.data : null
    })
    .filter((r): r is SearchRecipe => r !== null)
}

export async function saveRecipe(recipe: SearchRecipe): Promise<SearchRecipe[]> {
  const parsed = SearchRecipeSchema.parse(recipe)
  const all = await getRecipes()
  const idx = all.findIndex((r) => r.id === parsed.id)
  if (idx >= 0) all[idx] = parsed
  else all.push(parsed)
  await chrome.storage.local.set({ [KEYS.recipes]: all })
  return all
}

export async function deleteRecipe(id: string): Promise<SearchRecipe[]> {
  const all = (await getRecipes()).filter((r) => r.id !== id)
  await chrome.storage.local.set({ [KEYS.recipes]: all })
  return all
}

/* --------------------------------------------------------------- counters */

type Counters = Record<string, number>

/**
 * Daily caps are enforced against these counters rather than by querying the
 * applications store, so a submission that fails to record still counts
 * against the cap. Erring toward under-applying is the right failure mode.
 */
export async function bumpCounter(key: string, by = 1): Promise<number> {
  const raw = (await readRaw<Counters>(KEYS.counters)) ?? {}
  const next = (raw[key] ?? 0) + by
  raw[key] = next
  await chrome.storage.local.set({ [KEYS.counters]: raw })
  return next
}

export async function getCounter(key: string): Promise<number> {
  const raw = (await readRaw<Counters>(KEYS.counters)) ?? {}
  return raw[key] ?? 0
}

/** Drop counters for days other than today so the object cannot grow forever. */
export async function pruneCounters(todayKey: string): Promise<void> {
  const raw = (await readRaw<Counters>(KEYS.counters)) ?? {}
  const kept: Counters = {}
  for (const [k, v] of Object.entries(raw)) if (k.includes(todayKey)) kept[k] = v
  await chrome.storage.local.set({ [KEYS.counters]: kept })
}

/* ------------------------------------------------------------ agent state */

export async function readPersistedAgentState<T>(fallback: T): Promise<T> {
  const raw = await readRaw<T>(KEYS.agentState)
  return raw ?? fallback
}

export async function writePersistedAgentState<T>(state: T): Promise<void> {
  await chrome.storage.local.set({ [KEYS.agentState]: state })
}

/* ------------------------------------------------------------ import/export */

export async function exportAll(): Promise<string> {
  const [settings, profile, recipes] = await Promise.all([getSettings(), getProfile(), getRecipes()])
  return JSON.stringify({ version: 1, exportedAt: Date.now(), settings, profile, recipes }, null, 2)
}

export async function importAll(payload: string): Promise<{ settings: boolean; profile: boolean; recipes: boolean }> {
  const parsed = JSON.parse(payload) as Record<string, unknown>
  const result = { settings: false, profile: false, recipes: false }

  const s = SettingsSchema.safeParse(parsed.settings)
  if (s.success) {
    await saveSettings(s.data)
    result.settings = true
  }
  const p = ProfileSchema.safeParse(parsed.profile)
  if (p.success) {
    await saveProfile(p.data)
    result.profile = true
  }
  if (Array.isArray(parsed.recipes)) {
    const recipes = parsed.recipes
      .map((r) => SearchRecipeSchema.safeParse(r))
      .filter((r): r is { success: true; data: SearchRecipe } => r.success)
      .map((r) => r.data)
    await chrome.storage.local.set({ [KEYS.recipes]: recipes })
    result.recipes = true
  }
  return result
}
