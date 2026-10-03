# OpenClaude: install & update via MotionDevLab/openclaude

Small instructions card. Stock upstream is `@gitlawb/openclaude`;
everything below installs from **your fork** instead.

Requires Node.js ≥ 22 and bun (the fork builds from source on install).

## Install the fork (first time / new machine)

The `github:` one-liner is currently broken on npm 11 (it materializes a
partial tree with no `bin`/`dist` — reproduced on stock `main` too, so it
is an npm-side issue, not this fork's code). Use the tarball flow instead:

```powershell
git clone https://github.com/MotionDevLab/openclaude.git
cd openclaude
git checkout main
bun install --frozen-lockfile
bun run build
npm pack
npm install -g ./gitlawb-openclaude-<version>.tgz
openclaude --version
openclaude --help
```

## Update to the latest fork code

```powershell
cd openclaude
git pull
bun install --frozen-lockfile
bun run build
npm pack
npm install -g ./gitlawb-openclaude-<version>.tgz
```

## Switch back to stock upstream

```powershell
npm install -g @gitlawb/openclaude@latest
```

Your `~/.openclaude/` (settings, profiles, sessions, provider env files)
is untouched by any install direction.

## Configure custom provider lanes

Optional `settings.json` keys (details: [custom-providers.md](custom-providers.md)):

```jsonc
{
  "customProviders": [
    {
      "id": "my-lane", // [a-z0-9-], unique
      "label": "My Lane", // shown in banner, /provider, /model
      "baseUrl": "https://gateway.example.com/v1",
      "models": ["my-model"], // omitted or ["*"] = all models on baseUrl
      "supportsEffort": true, // effort picker for this lane
      "smallModel": "my-fast-model" // background chores for this lane
    }
  ],
  "providerEnvFile": "~/.openclaude/providers/my-lane.env"
}
```

What this gives you:

- **Named lanes** — the entry label replaces generic
  "Local OpenAI-compatible" in the startup banner, `/provider`,
  `/model`, and status. No secrets in `settings.json` ever; keys stay
  in env files. Plain `http://` is loopback-only.
- **Effort switching** — lanes with `supportsEffort: true` offer
  low/medium/high (or the entry's `effortLevels`) in `/effort` and the
  picker, sent as `reasoning_effort`; `auto` clears the override and
  follows the model default. If a lane's upstream rejects the
  parameter, flip `supportsEffort` off for that entry.
- **Zero-typing boot** — `providerEnvFile` loads at startup when no
  explicit `--provider-env-file` is given (explicit flags always win).
- **In-session switching** — lanes appear in `/provider` → "Set active
  provider" and switch endpoint + model without a restart or anything
  persisted; the next launch re-applies `providerEnvFile`.

## Notes

- Global npm files live under the npm prefix's
  `node_modules\@gitlawb\openclaude\`. **Never store your own notes in
  that directory** — every install wipes it.
- Fork repo: https://github.com/MotionDevLab/openclaude (tracks
  `Twigpine/openclaude`, pin + on-demand rebase policy).
