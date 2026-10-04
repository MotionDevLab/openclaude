# Local auto-mode classifier — plan (PARKED for later execution)

> Status: parked idea, no code changed. Captured 2026-10-04.
> Context: Auto mode (classifier-driven approvals, the opencode-like behavior)
> is compiled in but server-gated — GrowthBook `tengu_auto_mode_config` +
> remote classifier inference, both Anthropic-side. This plan sketches a
> self-hosted equivalent: a local judge (e.g. the `laya` binary already
> installed at `~/.local/bin/laya`, 0.3.21) wired into the classifier path.

## 1. Goal

A "Local Auto" approval mode that behaves like Auto mode (per-tool-use
allow/ask/deny judgments, learning via persisted rules) with zero Anthropic
server dependency: no GrowthBook gate, no remote classifier calls.

## 2. Integration points (verified in tree)

- Gate: `verifyAutoModeGateAccess` / `isAutoModeGateEnabled`
  (`src/utils/permissions/permissionSetup.ts:1231-1295`) reads
  `tengu_auto_mode_config` via `getDynamicConfig_BLOCKS_ON_INIT`. Add a local
  override (settings flag, e.g. `permissions.localAutoMode: true`, and/or env
  `OPENCLAUDE_LOCAL_AUTO_MODE=1`) that bypasses the remote gate.
- Classifier: `classifyBashCommand` (`src/utils/permissions/bashClassifier.ts`),
  `classifierDecision.ts`, `yoloClassifier.ts`. Add a local provider that shells
  out to a configured judge command (default: `laya`) and maps its verdict to
  allow/ask/deny. Command template + timeout in settings.
- Mode plumbing: reuse the existing `auto` mode — `PermissionMode.ts:87-97`,
  `permissionModeOptions.ts:37-43` already include it when
  `feature('TRANSCRIPT_CLASSIFIER')` (true in our build,
  `scripts/build.ts:118`). Local provider replaces only the decision source.
- Killswitches (`bypassPermissionsKillswitch.ts`, `checkAndDisableAutoModeIfNeeded`
  in `REPL.tsx:3272`) stay intact and authoritative.

## 3. Design notes

- **Fail closed.** Classifier timeout / missing binary / parse error → `ask`,
  never `allow`. (Opposite posture from the pid-validation fix, deliberately:
  this path grants execution, so uncertainty must prompt.)
- **Calibration first.** `laya` confidences are currently uncalibrated (known
  temp caveat per its SKILL.md). Ship in "ask on low confidence" posture and
  log every judgment (command hash, verdict, confidence, outcome) to a local
  calibration log; tune thresholds from real data before trusting `allow`.
- **Scope v1 to Bash.** Bash prompts are the observed pain (`laya`, `npm`,
  `git` with varying args defeat exact-match "don't ask again" rules —
  `bashPermissions.ts:2512-2576`). File-edit tools are already covered by
  Accept-edits mode. Transcript-level judging (every tool) comes later.
- **Rule learning stays as-is.** Persisted `Bash(prefix:*)` allow-rules in
  `localSettings` keep working; the local judge only decides the unruled
  remainder. Consider suggesting `prefix:*` rules (not exact text) when the
  judge allows repeatedly — fixes the "similar commands" mismatch where the
  prompt saves exact strings that never match the next invocation.

## 4. Non-goals (v1)

- No remote calls of any kind in the decision path (must work offline; no
  GrowthBook, no API classifier).
- No change to `bypassPermissions` / `fullAccess` semantics.
- No transcript-wide auto-approval; no changes to plan-mode handling.
- No hardcoded judge binary path — settings-configured, defaulting to `laya`
  on PATH.

## 5. Effort / risks

- Medium-large: permission pipeline + settings schema + tests + security review.
- Main risk: prompt-injection / adversarial commands gaming a local judge;
  mitigation is fail-closed defaults + calibration log + keeping hard safety
  prompts (`rm -rf /` class) outside the judge's authority entirely.
- Suggested branch when executed: `feat/local-auto-classifier`.

## 6. Trigger to execute

Revisit when: (a) Auto mode gate confirmed permanently closed for this
fork/account, or (b) laya calibration data shows judgments trustworthy enough
to graduate from advisory to gating.
