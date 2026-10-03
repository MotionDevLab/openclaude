import { getSettings_DEPRECATED } from './settings/settings.js'

export type CustomProviderEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type CustomProviderEntry = {
  id: string
  label: string
  baseUrl: string
  models?: string[]
  supportsEffort?: boolean
  effortLevels?: CustomProviderEffortLevel[]
  smallModel?: string
}

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/

export const CUSTOM_PROVIDER_EFFORT_LEVELS: readonly CustomProviderEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export const DEFAULT_CUSTOM_PROVIDER_EFFORT_LEVELS: CustomProviderEffortLevel[] = [
  'low',
  'medium',
  'high',
]

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function normalizeModel(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  return host
}

/**
 * Loopback hosts permitted to use plaintext `http://` in `customProviders`
 * entries. Matched against the parsed hostname exactly (never substrings),
 * mirroring the upstream rationale that credentials must not travel in the
 * clear to non-local hosts. `::1` covers the bracketed IPv6 loopback form.
 */
export function isCustomProviderLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Whether a `customProviders` base URL is acceptable: parseable, with an
 * `http(s)` scheme, where plaintext `http://` is restricted to loopback
 * hosts. Non-loopback `http://` stays rejected.
 */
export function isAllowedCustomProviderBaseUrl(baseUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(baseUrl.trim())
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') {
    return true
  }
  if (parsed.protocol === 'http:') {
    return isCustomProviderLoopbackHost(parsed.hostname)
  }
  return false
}

function entryName(entry: unknown, index: number): string {
  if (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { id?: unknown }).id === 'string' &&
    ((entry as { id: string }).id.trim().length > 0)
  ) {
    return `customProviders["${(entry as { id: string }).id}"]`
  }
  return `customProviders[${index}]`
}

/**
 * Validate one `customProviders` entry, returning human-readable problems
 * that name the entry and the field (e.g. `customProviders["zen-router"].baseUrl`).
 * By design there is no `apiKey` field: secrets stay in env files / shell env,
 * never in `settings.json`.
 */
export function validateCustomProviderEntry(entry: unknown, index: number): string[] {
  const name = entryName(entry, index)
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`${name}: entry must be an object`]
  }
  const problems: string[] = []
  const record = entry as Record<string, unknown>

  if (typeof record.id !== 'string' || !CUSTOM_PROVIDER_ID_PATTERN.test(record.id)) {
    problems.push(`${name}.id: must match [a-z0-9-] and be unique`)
  }
  if (typeof record.label !== 'string' || record.label.trim().length === 0) {
    problems.push(`${name}.label: must be a non-empty string`)
  }
  if (typeof record.baseUrl !== 'string' || record.baseUrl.trim().length === 0) {
    problems.push(`${name}.baseUrl: must be a non-empty URL string`)
  } else {
    let parseable = true
    try {
      new URL(record.baseUrl.trim())
    } catch {
      parseable = false
    }
    if (!parseable) {
      problems.push(`${name}.baseUrl: must be a parseable URL`)
    } else if (!isAllowedCustomProviderBaseUrl(record.baseUrl)) {
      problems.push(
        `${name}.baseUrl: plaintext http:// is only allowed for loopback hosts (localhost, 127.0.0.1, ::1)`,
      )
    }
  }
  if (record.models !== undefined) {
    if (
      !Array.isArray(record.models) ||
      record.models.some(m => typeof m !== 'string' || (m as string).trim().length === 0)
    ) {
      problems.push(`${name}.models: must be an array of non-empty model id strings`)
    }
  }
  if (record.supportsEffort !== undefined && typeof record.supportsEffort !== 'boolean') {
    problems.push(`${name}.supportsEffort: must be a boolean`)
  }
  if (record.effortLevels !== undefined) {
    if (
      !Array.isArray(record.effortLevels) ||
      (record.effortLevels as unknown[]).length === 0 ||
      (record.effortLevels as unknown[]).some(
        l => typeof l !== 'string' || !(CUSTOM_PROVIDER_EFFORT_LEVELS as readonly string[]).includes(l),
      )
    ) {
      problems.push(
        `${name}.effortLevels: must be a non-empty array of low|medium|high|xhigh|max`,
      )
    }
  }
  if (
    record.smallModel !== undefined &&
    (typeof record.smallModel !== 'string' || record.smallModel.trim().length === 0)
  ) {
    problems.push(`${name}.smallModel: must be a non-empty model id string`)
  }
  if (record.apiKey !== undefined) {
    problems.push(
      `${name}.apiKey: not supported — keep secrets in env files / shell env, never in settings.json`,
    )
  }
  return problems
}

/**
 * Validate the full `customProviders` list, including duplicate-id detection.
 * Duplicate display labels are allowed: matching is always by
 * `(baseUrl, model)`, never by label.
 */
export function validateCustomProviders(entries: unknown): string[] {
  if (entries === undefined) {
    return []
  }
  if (!Array.isArray(entries)) {
    return ['customProviders: must be an array']
  }
  const problems: string[] = []
  const seenIds = new Set<string>()
  entries.forEach((entry, index) => {
    problems.push(...validateCustomProviderEntry(entry, index))
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      CUSTOM_PROVIDER_ID_PATTERN.test((entry as { id: string }).id)
    ) {
      const id = (entry as { id: string }).id
      if (seenIds.has(id)) {
        problems.push(`customProviders["${id}"].id: duplicate id`)
      } else {
        seenIds.add(id)
      }
    }
  })
  return problems
}

/**
 * Read the configured `customProviders` entries from loaded settings.
 * Settings are guaranteed loaded before provider/effort resolution runs
 * (startup order in `src/entrypoints/cli.tsx`: `enableConfigs()` precedes
 * all resolution). Callers read live on every call — deliberately NOT
 * memoized — so settings edits take effect without a restart.
 */
export function getCustomProvidersFromSettings(): CustomProviderEntry[] {
  const settings = getSettings_DEPRECATED() as { customProviders?: unknown } | null | undefined
  const entries = settings?.customProviders
  if (!Array.isArray(entries)) {
    return []
  }
  return entries.filter(
    (entry): entry is CustomProviderEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { label?: unknown }).label === 'string' &&
      typeof (entry as { baseUrl?: unknown }).baseUrl === 'string',
  )
}

function entryCoversAllModels(entry: CustomProviderEntry): boolean {
  if (entry.models === undefined) {
    return true
  }
  const models = entry.models.map(m => m.trim()).filter(m => m.length > 0)
  return models.length === 0 || (models.length === 1 && models[0] === '*')
}

function entryMatchesModel(entry: CustomProviderEntry, model: string | undefined): boolean {
  if (model === undefined || model.trim().length === 0) {
    return true
  }
  if (entryCoversAllModels(entry)) {
    return true
  }
  const normalized = normalizeModel(model)
  return entry.models!.some(m => normalizeModel(m) === normalized)
}

/**
 * Find the first `customProviders` entry matching an active
 * `(baseUrl, model)` lane. Base URLs compare normalized (trailing slashes
 * ignored); models compare case-insensitively, mirroring the tier-override
 * convention. `models` omitted or `["*"]` matches every model discovered on
 * the entry's base URL. When `model` is omitted, matching is by base URL
 * alone. Pass `entries` explicitly in tests to avoid settings I/O.
 */
export function findMatchingCustomProvider(
  baseUrl: string | undefined,
  model?: string | undefined,
  entries?: CustomProviderEntry[],
): CustomProviderEntry | undefined {
  if (!baseUrl || baseUrl.trim().length === 0) {
    return undefined
  }
  let normalizedBase: string
  try {
    normalizedBase = normalizeBaseUrl(new URL(baseUrl.trim()).href)
  } catch {
    normalizedBase = normalizeBaseUrl(baseUrl)
  }
  const list = entries ?? getCustomProvidersFromSettings()
  for (const entry of list) {
    let entryBase: string
    try {
      entryBase = normalizeBaseUrl(new URL(entry.baseUrl.trim()).href)
    } catch {
      continue
    }
    if (entryBase !== normalizedBase) {
      continue
    }
    if (!entryMatchesModel(entry, model)) {
      continue
    }
    return entry
  }
  return undefined
}

/**
 * Menu id prefix for `customProviders` entries in "Set active provider".
 * Saved profiles keep their own ids; the prefix keeps the two namespaces
 * disjoint (matching is always by `(baseUrl, model)`, never by label).
 */
export const CUSTOM_LANE_MENU_ID_PREFIX = 'custom:'

/**
 * The entry's default model for an in-session lane switch: the first listed
 * model when the entry declares a specific list, otherwise the current lane
 * model (wildcard entries declare no opinion; model choice stays in
 * `/model`, whose options are discovered live from the endpoint).
 */
export function getCustomLaneDefaultModel(
  entry: CustomProviderEntry,
  currentModel: string | undefined,
): string | undefined {
  if (!entryCoversAllModels(entry)) {
    const first = entry.models!
      .map(m => m.trim())
      .find(m => m.length > 0)
    if (first) {
      return first
    }
  }
  const current = currentModel?.trim()
  return current && current.length > 0 ? current : undefined
}

/**
 * Build the profile-equivalent env for an in-session lane switch, run
 * through the same session-apply path as saved profiles
 * (`applySavedProfileToCurrentSession` with a transient, never-saved profile
 * file). No key material by design: credentials stay in process.env (loaded
 * from env files), the entry contributes endpoint + model only.
 */
export function buildCustomLaneProfileEnv(
  entry: CustomProviderEntry,
  currentModel: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: entry.baseUrl.trim(),
  }
  const model = getCustomLaneDefaultModel(entry, currentModel)
  if (model) {
    env.OPENAI_MODEL = model
  }
  return env
}

/**
 * Whether a `customProviders` lane is the currently active lane (env truth).
 */
export function isCustomLaneActive(
  entry: CustomProviderEntry,
  baseUrl: string | undefined,
  model: string | undefined,
): boolean {
  return findMatchingCustomProvider(baseUrl, model, [entry]) !== undefined
}

/**
 * Resolve the display label for an active `(baseUrl, model)` lane through
 * the `customProviders` table. Returns undefined when no entry matches so
 * callers fall through to the existing heuristics untouched.
 */
export function getCustomProviderLabel(
  baseUrl: string | undefined,
  model?: string | undefined,
  entries?: CustomProviderEntry[],
): string | undefined {
  return findMatchingCustomProvider(baseUrl, model, entries)?.label
}

/**
 * Resolve the per-lane small/fast model for background chores (token
 * estimation, hook models, search planning, summaries). Returns undefined
 * when the matched entry sets no `smallModel` so callers fall through to the
 * existing chain (`ANTHROPIC_SMALL_FAST_MODEL` → provider default).
 */
export function getCustomProviderSmallModel(
  baseUrl: string | undefined,
  model?: string | undefined,
  entries?: CustomProviderEntry[],
): string | undefined {
  const match = findMatchingCustomProvider(baseUrl, model, entries)
  const smallModel = match?.smallModel?.trim()
  return smallModel && smallModel.length > 0 ? smallModel : undefined
}
