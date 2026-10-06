# Task 4 report: docs/catalog consistency (no behavior code)

## Branch + commit
- Branch: `feat/bg-discoverability` (stayed on it; never touched `main`; no push, no PR, no merge).
- Head at start: `52af1bf5` — Task 3 commit (on top of `2e6368d4` Task 2, `d9e818c1` Task 1; base `main @ 1f0b52ff` unchanged).
- This task's commit: `16bbadcc` (content commit; amended once more to record this SHA, so final HEAD differs by that one line only — see `git log`) — `feat(bg): Task 4 docs/catalog consistency - /bg slash alongside CLI flags (docs-only)`.
- Plan source: `2026-10-06-bg-discoverability.md` Task 4; established names/flags from `task-1-report.md`, `task-2-review.md`, `task-3-report.md` (all read first).

## Files changed (docs-only, 3 files)
- `web/src/data/cliFlags.ts` (+3/−2, background group only): new `/bg` entry (`arg` mirrors the slash `argumentHint` exactly: `[ps|logs <id>|kill <id>|auto-pr <on|off>]`; description covers alias `/jobs`, subcommands `ps|logs|kill|auto-pr`, auto-pr project-opt-in off-by-default, spawn-stays-in-terminal). Two verify-driven touch-ups: `--bg` description gains `(alias --background)`; `kill` description gains `(verified PID only)`. No other group touched.
- `README.md` (+6, one paragraph): TUI discovery paragraph in the `--bg` block (after the auto-PR paragraph, before the local-process paragraph) covering `/bg ps|logs|kill`, `/jobs` alias, `/bg auto-pr <on|off>` off-by-default toggle, spawn-stays-in-terminal, and the `--help` "Background sessions" section.
- This report file (new).
- Deliberately NOT changed: `src/utils/settings/types.ts` (Task 1 added no user-facing settings — verified no diff), any runtime/commander/spawn/finalizer/guard/retention code, `web/src/data/commands.ts` (see concern 1), CI/dependencies.

## Test commands + results
- `bun run web:typecheck` (required since web/ touched) → **0 errors, 0 warnings, 0 hints** (33 files, `astro check`).
- README diff self-review (`git diff` read-through): one paragraph, factual tone matching the surrounding block (backtick spans, parenthetical asides), no invented flags, placed adjacent to flag docs.
- `git status --short` confirms scope: only `README.md` + `web/src/data/cliFlags.ts` modified (+ this report untracked-then-committed); settings and runtime trees clean.
- Did not run: `bun install` (no dependency changes), full Task 5 contract (controller/Task 5 scope).

## Consistency checklist per surface
| Surface | Names | Flags | Defaults-off | Draft-only | Result |
|---|---|---|---|---|---|
| Web catalog (`cliFlags.ts` background group) | `/bg` + `/jobs` alias + `ps\|logs\|kill\|auto-pr` now listed alongside `--bg`/`ps`/`logs`/`kill` | every flag cross-checked: `--bg` (+`--background` alias, `bg.ts:336-343`), `--worktree`, `--keep-worktree` (reserved/inert, `bg.ts:1330-1331`), `--auto-pr` + `--pr-title`/`--pr-dry-run`, `logs [-f]`, `kill` — all match `bg.ts` usage strings (`:1276`, `:1198`, `:1247`) and Task 3 help text (`main.tsx:3729-3737`); nothing invented | worktree entry + auto-pr entry + `/bg` entry all state off-by-default | auto-pr entry states `always --draft` | Pass |
| README `--bg` block | `/bg`, `/jobs`, `/bg auto-pr`, `openclaude --bg`, `--help` "Background sessions" | no flags added beyond the existing block; paragraph references only established names | auto-PR opt-in stated off by default | existing block states `gh pr create --draft`, never ready (unchanged) | Pass |
| `--help` (Task 3, `main.tsx:3729-3737`) | `--bg`, `ps`/`logs`/`kill`, `/bg` pointer | canonical `--bg [--name] [--worktree] [--keep-worktree] [--auto-pr] [--pr-title] [--pr-dry-run]` matches `bg.ts:1276` exactly | not stated in help text (omission, not contradiction) | not stated in help text (omission, not contradiction) | Pass (unchanged this task) |
| Slash finder (Tasks 1+2) | `bg` + `jobs` alias (`index.ts:5-6`), 4 subcommands (`:10-31`), synonyms `background`/`worktree-pr` | top-level hint `[ps\|logs <id>\|kill <id>\|auto-pr <on\|off>]` (`index.ts:9`) — web `/bg` arg mirrors it verbatim | `auto-pr` description "off by default" (`index.ts:27-28`), fail-closed gate (`bg.ts:609-622`) | finalizer `gh pr create --draft` (PR-B, untouched) | Pass (unchanged this task; web now mirrors it) |
| Settings `.describe()` (`types.ts:634-658`, `659-706`) | `autoPR.enabled`/`dryRun`/`cleanup`, `worktree.*` | no flag changes | "Off by default" on `autoPR.enabled` + parent describe; worktree opt-in wording intact | "always created with --draft, never ready" intact | Pass (byte-identical, verified via clean `git status` on that path) |

## Concerns
1. `web/src/data/commands.ts` (slash-command reference) still has no `/bg` entry — the web slash catalog is seeded from `src/commands.ts`, which now registers `bg`, so the seed is stale. Left untouched: plan Task 4 names only the `background` group (CLI catalog), and the background group now covers `/bg` alongside the CLI flags as specified. Flag for controller: a one-line `/bg` addition to `commands.ts` (session category) would close the loop if in scope for Task 5 or a follow-up.
2. `--help` states neither defaults-off nor draft-only (help-text-only section, Task 3 owned) — consistent by omission, but a reader comparing surfaces must look to README/web/settings for those two properties. No change made (Task 3 text frozen; changing it is out of Task 4 scope).
3. `/jobs <partial>` subcommand completion resolves by real name only (pre-existing, noted in Task 2 review) — unaffected by docs edits; mentioned only so the web `/jobs` alias mention is not misread as a completion claim.

## Constraints honored
Bun; no runtime code changed; no subagents dispatched; no push/PR/merge; `main` untouched; settings `.describe()` text unchanged.
