# OpenClaude: install & update via MotionDevLab/openclaude

Small instructions card. Stock upstream is `@gitlawb/openclaude`;
everything below installs from **your fork** instead.

## Install the fork (first time / new machine)

```powershell
npm install -g github:MotionDevLab/openclaude#feat/custom-providers
openclaude --version
```

Requires Node.js ≥ 22. The `#branch` suffix picks the feature branch;
omit it to install `main`.

## Update to the latest fork code

```powershell
npm install -g github:MotionDevLab/openclaude#feat/custom-providers
```

Same command — npm rebuilds from the branch tip. No clone needed.

## Switch back to stock upstream

```powershell
npm install -g @gitlawb/openclaude@latest
```

Your `C:\Users\reini\.openclaude\` (settings, profiles, sessions,
`providers\zen-router.env`) is untouched by any install direction.

## Notes

- Global npm files live under
  `C:\Users\reini\AppData\Roaming\npm\node_modules\@gitlawb\openclaude\`.
  **Never store your own notes in that directory** — every install wipes
  it. (The fork plan doc lived there at the owner's request; treat it as
  a convenience copy.)
- Fork repo: https://github.com/MotionDevLab/openclaude (tracks
  `Twigpine/openclaude`, pin + on-demand rebase policy).
