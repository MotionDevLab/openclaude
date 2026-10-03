# MotionDevLab/openclaude fork plan — custom providers, effort, default env file

> Status: design (awaiting owner review). No code changed yet.
> Base: `Twigpine/openclaude` `main` @ `9a2910da` (verified in sync with
> `MotionDevLab/openclaude` `main` on 2026-10-03; ahead of the `v0.31.0` tag).
> This file is canonical **in this repo** (`docs/motiondev-fork-plan.md`).
> (A convenience copy also exists in the npm-installed package docs dir —
> any `npm install -g` wipes that directory, so do not treat it as canonical.)

## 1. Goal

Three minimal, orthogonal, mechanism-not-hardcode patches (Approach 1):

1. **User-defined provider presets** — a zen-router-style lane gets a real
   name ("OpenCode Zen Router") in `/provider`, `/model`, and the startup
   banner instead of generic "Local OpenAI-compatible".
2. **First-class effort support for OpenAI-compat lanes** — the effort
   switcher offers low/medium/high on declared lanes instead of
   "Effort not supported", sent as `reasoning_effort`.
3. **Default provider-env-file** — plain `openclaude` boots the configured
   lane with zero typing; explicit `--provider-env-file` / `--provider`
   flags still win.

## 2. Non-goals

- No hardcoded zen-router URLs, model ids, or account specifics in source.
  Everything is user-configured via `settings.json`.
- No change to Anthropic/first-party, Bedrock/Vertex/Foundry, Gemini, or
  Codex paths.
- No automatic 400-retry-without-`reasoning_effort` fallback in v1
  (documented limitation; see §6 Risks).
- No npm publish under a new scope in v1 (install from git branch).

## 3. Design

### 3.1 `customProviders` settings key

New optional top-level `settings.json` key:

```jsonc
"customProviders": [
  {
    "id": "zen-router",                       // required, [a-z0-9-], unique
    "label": "OpenCode Zen Router",           // required, shown in UI
    "baseUrl": "http://127.0.0.1:18905/zen/v1", // required
    "models": ["muse-spark-1.3-contributor-free", "nemotron-3.5-lightning-free"],
    // models omitted or ["*"] = all models discovered on baseUrl
    "supportsEffort": true,                   // default false
    "effortLevels": ["low", "medium", "high"] // default exactly this
  }
]
```

Touch points (source paths in fork):

- **Schema/validation** — wherever `settings.json` is typed/validated
  (find the settings schema module; add `customProviders` with strict
  validation: id pattern, label non-empty, baseUrl parseable).
  Validation MUST permit `http://` for loopback (`127.0.0.1`, `localhost`,
  `::1`) — the existing `requireHttpsBaseUrl`-style helper would reject
  the router, so custom validation is required. Non-loopback `http://`
  stays rejected (same rationale as upstream).
- **Label resolution** — `src/utils/providerDiscovery.ts`,
  `getLocalOpenAICompatibleProviderLabel()`: check custom entries FIRST
  (normalized base URL equality, ignoring trailing slashes; then model
  match, **case-insensitive** mirroring the tier-override convention).
  Return the entry label. Everything else (LM Studio, Ollama,
  route matching, generic fallback) is untouched.
- **Provider UI surfaces** — `src/commands/provider/provider.tsx`,
  `src/components/StartupScreen.ts`, `src/utils/status.tsx`: resolve the
  active lane through the same lookup so banner, `/provider`, and `/model`
  show the custom label. Saved-profile flow (`OpenRouter (active)`,
  Anthropic built-in) is untouched; env-file/flag lanes resolve via the
  new lookup. **v1 scope: label-when-active only** — custom lanes are NOT
  added as switchable entries in the `/provider` menu (switching lanes
  still means relaunch with different env/model). Menu switching is a
  §8 follow-up.
- **Validation & secrets** — invalid entry (bad id, empty label,
  unparseable baseUrl) fails loudly at startup naming entry + field.
  No `apiKey` field on entries by design: secrets stay in env files /
  shell env, never in `settings.json`.

### 3.2 Effort for declared lanes

Mechanism (verified in source — no new wire format invented):

- `src/utils/effort.ts` → `resolveModelReasoningControl()` chain already
  supports a `capability`-sourced resolution with `wireFormat:
  'reasoning_effort'` via `resolveConfigured3PReasoningControl()`, gated
  today on `ANTHROPIC_DEFAULT_*_MODEL` tier env vars
  (`src/utils/model/modelSupportOverrides.ts`).
- **Patch**: extend `resolveConfigured3PReasoningControl()` itself
  (`src/utils/effort.ts` ~line 434; called from
  `resolveModelReasoningControl()` ~line 625, after the metadata and
  compatibility early-returns): in addition to the tier env vars, consult
  the matched `customProviders` entry — if the active `(baseUrl, model)`
  matches an entry with `supportsEffort: true`, return the same
  controllable `levels` resolution with that entry's `effortLevels`
  (validated against `low|medium|high|xhigh|max`) and
  `wireFormat: 'reasoning_effort'`, `source: 'capability'`. One function
  extended, no new resolution step, no touch to the `// @[MODEL LAUNCH]`
  allowlist. Note: when endpoint metadata exists and denies reasoning
  (`resolveModelReasoningControl` early-returns ~lines 614–619), neither
  tier overrides nor this entry apply — correct precedence, document it.
- Existing tier env overrides keep working unchanged (they are evaluated
  in the same chain; explicit tier pin wins on conflict — document this).
- **Memoization**: `get3PModelCapabilityOverride` memoizes on env vars
  only. The settings-based entry lookup must join the memo cache key
  (or bypass memoization) so settings edits take effect; settings are
  guaranteed loaded before these resolutions run (startup order in
  `src/entrypoints/cli.tsx`), which the implementation MUST assert, not
  assume silently.
- The `EffortPicker` UI (`usesOpenAIEffort` / `modelUsesOpenAIEffort`
  path) needs no change: once the model resolves controllable, the
  existing OpenAI-effort picker path handles it.

Out of scope for v1: probing the upstream for `reasoning_effort`
support. If a lane's upstream 400s the parameter, the fix is
`supportsEffort: false` (or omit) for that entry — one line of config.

### 3.3 Default provider-env-file

New optional `settings.json` key:

```jsonc
"providerEnvFile": "~/.openclaude/providers/zen-router.env"
```

Behavior (grounded in `src/entrypoints/cli.tsx` load order ~lines 402–462
and the `cli.test.ts` precedence test at line ~301):

1. CLI parses `--provider-env-file` / `--provider` (remembered as
   explicit inputs).
2. `settings.json` (incl. `env`) applies via
   `applySafeConfigEnvironmentVariables()` (`src/utils/managedEnv.ts`).
3. **NEW**: if no explicit `--provider-env-file` was given AND
   `providerEnvFile` is set, load it now — same `loadEnvFile()` from
   `src/utils/envFile.ts` (same allowlist enforcement), at settings tier.
4. Saved-profile env merges, then re-application of remembered explicit
   inputs (existing behavior — explicit flags always win).

Path rules: expand leading `~` to the user home dir (fixes the exact
PowerShell `~` papercut from 2026-10-02 — Node never expands it);
resolve relative paths against the OpenClaude config dir; missing file =
hard error naming the resolved path (same UX as the flag today).
Collision rule: `loadEnvFile()` only fills unset keys, and settings `env`
applies first — so a key set in both places keeps the settings value;
the file fills gaps only. Document this with an example.

Docs: update README provider/env-file note
("run `openclaude --provider-env-file .env`…") to mention the settings
default, and document `customProviders` + `providerEnvFile` in
`docs/` (new page, linked from README).

## 4. Branch & commit plan

- Feature branch `feat/custom-providers` (already created from `main` @
  `9a2910da`; docs commit `b3518f9` pushed).
- Three discrete code commits (one per §3.1/§3.2/§3.3) + tests per commit, so
  rebases and upstream PRs stay separable.
- Keep the fork's `main` tracking `Twigpine/main`; rebase policy: pin +
  on-demand (no per-release churn).

## 5. Test plan

- `bun test` focused suites for every touched area, esp.:
  `src/utils/effort.test.ts`, `src/utils/envFile.test.ts`,
  `src/utils/providerDiscovery.test.ts`,
  `src/commands/provider/provider.test.tsx`,
  `src/commands/model/model.test.tsx`, `src/entrypoints/cli.test.ts`
  (extend with: default-env-file load order, explicit-flag-wins cases).
- `bun run build` + `bun run smoke` clean.
- Repo pre-push contract per `CONTRIBUTING.md` before any push.
- Live matrix on this machine (Windows PowerShell):
  1. Fresh launch (no flag) → banner shows "OpenCode Zen Router".
  2. `/model` on spark → effort levels offered (no "not supported").
  3. Prompt at low vs high → HTTP 200s in router dashboard logs
     (`http://localhost:18904` → Logs), no 400 spike.
  4. Explicit `--provider-env-file <other>` still overrides the default;
     plain launch with the setting removed behaves exactly as stock.
  5. `npm install -g github:MotionDevLab/openclaude#feat/custom-providers`
     on a clean shell works (see update instructions md).

## 6. Risks

- Upstream is heading toward 0.4.0 (open release-please PR on the fork).
  Mitigation: tiny diffs, upstream-shaped extension points, rebase early
  if 0.4.0 touches `providerDiscovery.ts` / `effort.ts` / `cli.tsx`.
- Some free-lane upstreams may reject `reasoning_effort` (400). v1 has
  no auto-fallback — misbehaving lane = flip `supportsEffort` off.
  (Also note the known intermittent upstream 403 flapping on free lanes —
  unrelated to this work, retries succeed.)
- `bun` toolchain needed for source builds (repo pins via `.bun-version`);
  Node ≥22 for runtime. Windows build quirks possible — validate with
  `bun run build` on this machine before promising installability.

## 7. Decisions (locked)

- `effortLevels` accepts `low|medium|high|xhigh|max`; schema default is
  exactly `["low", "medium", "high"]`. Lanes opt into more.
  (Tier env vars already support `xhigh_effort`/`max_effort` the same way.)
- Upstream PR after v1 is optional; patches are shaped for it.

## 8. Follow-ups (explicitly NOT v1)

- Custom lanes as switchable entries in the `/provider` menu (v1 labels
  the active lane only). A local second opinion scored this 0.84 in
  favor — revisit right after v1 lands if menu switching proves painful.
- Auto-fallback: retry without `reasoning_effort` when an upstream 400s
  it (v1: flip `supportsEffort` off per entry instead).

## Appendix A — validation (2026-10-03)

- Author gap-hunt + source re-check (chain order in `effort.ts`
  ~lines 602–646, load order in `cli.tsx` ~402–462, allowlists in
  `managedEnvConstants.ts`): incorporated above.
- Laya second opinion (`laya-typed-decisions`, `--predict --json`):
  effort mechanism `extend-tier-override-function` (0.76),
  env-file tier `settings-tier-below-explicit-flags` (0.68),
  label mechanism `check-custom-first-in-label-fn` (0.68),
  load-bearing-gap `no` (0.75). Raw output: temp `laya-result.json`
  (not committed).
