# Desktop Online Updates

The Windows cashier app checks GitHub Releases shortly after startup and also provides **Settings > General > Check for updates**. An update can be downloaded and installed only outside the cashier workspace, so an active cart is not interrupted.

## One-time GitHub setup

1. Back up both updater keys from `C:\Users\acer\.tauri` in a secure, access-controlled location:
   - `nexa-pos-updater.key` — private; never commit or share it.
   - `nexa-pos-updater.key.pub` — public and already embedded in `tauri.conf.json`.
2. In the GitHub repository, open **Settings > Secrets and variables > Actions**.
3. Create `TAURI_SIGNING_PRIVATE_KEY` with the full contents of `nexa-pos-updater.key`.
4. Create `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with an empty value if GitHub permits it. The initial local key has no password; for better security, generate a password-protected production key before distributing the first updater-enabled installer and replace the embedded public key.
5. Ensure GitHub Actions has permission to create releases. The workflow requests `contents: write`.

The GitHub Releases endpoint in `tauri.conf.json` must be publicly reachable by installed terminals. If the repository remains private, move `latest.json` and the signed installer to a public HTTPS release bucket or use an authenticated update service.

## Publish an update

Update all three versions to the same higher semantic version:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Commit the change, then create and push the matching tag:

```powershell
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

The workflow builds the signed NSIS updater, signature, and `latest.json` as a draft GitHub Release. Review the draft, add release notes, and publish it. Installed apps will see it on their next check.

## Local signed build

`npm run tauri:build` automatically uses `C:\Users\acer\.tauri\nexa-pos-updater.key` when present. The generated installer and `.sig` are under `src-tauri\target\release\bundle\nsis`.

Do not distribute an updater-enabled build until the signing key is backed up. Losing the key prevents those installations from trusting future updates.
