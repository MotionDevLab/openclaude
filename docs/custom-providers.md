# Custom provider lanes (`customProviders` + `providerEnvFile`)

Two optional `settings.json` keys. Everything is user-configured — no
hardcoded URLs, model ids, or account specifics in source.

## `customProviders`

User-defined provider lanes. The same mechanism covers gateway-style
lanes AND direct models (e.g. OpenRouter):

```jsonc
{
  "customProviders": [
    {
      "id": "example-lane", // required, [a-z0-9-], unique
      "label": "Example Gateway", // required, shown in UI
      "baseUrl": "http://127.0.0.1:8080/v1", // required
      "models": ["example-model"],
      // models omitted or ["*"] = all models discovered on baseUrl
      "supportsEffort": true, // default false
      "effortLevels": ["low", "medium", "high"], // default exactly this
      "smallModel": "example-small-model",
      // optional per-lane small/fast model for background chores.
      // Fallback chain: entry.smallModel → ANTHROPIC_SMALL_FAST_MODEL env
      // → OPENAI_MODEL. Omitted = divided setup off for that lane.
      "contextWindow": 128000,
      // optional lane-default limits (tokens). Cover every model on the
      // lane — including models with no modelLimits entry — so a lane with
      // many rotating models needs one line instead of one entry per model.
      "maxOutputTokens": 8192
    }
  ],
  "providerEnvFile": "~/.openclaude/providers/example-lane.env"
}
```

What a lane gets you:

1. **Real name** — the entry label replaces generic
   "Local OpenAI-compatible" in the startup banner, `/provider`,
   `/model`, and status. Matching is always by `(baseUrl, model)` —
   base URLs compare ignoring trailing slashes, models compare
   case-insensitively — never by label, so duplicate display labels are
   allowed.
2. **Effort picker** — entries with `supportsEffort: true` offer
   low/medium/high (or the entry's `effortLevels`, validated against
   `low|medium|high|xhigh|max`) on `/effort`, sent as
   `reasoning_effort`. If a lane's upstream 400s the parameter, flip
   `supportsEffort` off for that entry — one line of config. There is
   no automatic retry-without-`reasoning_effort` fallback in v1.
3. **In-session switching** — entries appear in `/provider` →
   "Set active provider" and switch endpoint + model without a restart,
   via a transient profile (never persisted). Switching back to saved
   profiles / Anthropic uses the existing paths. Model choice inside the
   lane stays in `/model` (models are discovered live).

4. **Lane-default limits** — `contextWindow` / `maxOutputTokens`
   on the entry apply to every model served on the lane. Resolution
   order for limits: exact env override → built-in catalog → env
   prefix → per-model `modelLimits` → **lane default** → discovery
   cache → descriptor default. A per-model `modelLimits` entry still
   wins for exceptions; each field falls through independently.

Precedence for effort (inside one resolution): tier env override
`=== false` wins (not controllable, even over a matching entry), else
tier `=== true` keeps the existing resolution, else a matching entry
with `supportsEffort: true` resolves, else not controllable. When
endpoint metadata denies reasoning, neither tier overrides nor entries
apply.

Validation: a bad id, empty label, or unparseable base URL fails loudly
at startup naming entry + field. Plaintext `http://` is allowed for
loopback hosts (`localhost`, `127.0.0.1`, `::1`) only; non-loopback
`http://` stays rejected. There is deliberately no `apiKey` field on
entries — secrets stay in env files / shell env, never in
`settings.json`.

## `providerEnvFile`

Default provider env file loaded at startup when no explicit
`--provider-env-file` was given, so plain `openclaude` boots the
configured lane with zero typing:

```jsonc
{ "providerEnvFile": "~/.openclaude/providers/example-lane.env" }
```

- Leading `~` expands to the home dir; relative paths resolve against
  the OpenClaude config dir; a missing file is a hard error naming the
  resolved path (same UX as the flag).
- Same allowlist as `--provider-env-file`, and it only fills unset
  keys: a key set in both `settings.json` `env` and the file keeps the
  settings value; the file fills gaps only. Example: `OPENAI_MODEL` in
  settings beats `OPENAI_MODEL` in the file, while `OPENAI_API_KEY`
  comes from the file.
- Explicit `--provider-env-file <other>` (and `--provider`) still
  override the default; they are reapplied after every merge and always
  win. An in-session `/provider` switch beats the startup default for
  that session only; the next launch re-applies `providerEnvFile`.
