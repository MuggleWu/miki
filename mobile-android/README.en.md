# Miki · Android client

The phone-side client for the same miki data (a workspace folder). The desktop side is an
Electron app; this one is a Capacitor shell around React. **The scheduling and data layers are
the same set of pure functions** (`src/core`, `src/shared`) — the platforms differ in exactly
three places:

| Layer | Desktop | Phone |
| --- | --- | --- |
| File access | `node:fs` | Capacitor Filesystem bridge (`src/mobile/fs/`; an in-memory implementation is used when developing in a browser) |
| UI | five views plus a separate card window | a touch-oriented set of pages with drawer navigation (`src/ui/`) |
| Cross-device consistency | plain `git pull` / `git push` | in-app sync: fetch → line merge → push (`src/mobile/sync/`) |

## Development and build

```bash
npm install
npm run dev          # develop in a browser (FileStore is in-memory; no emulator needed)
npm run build        # web bundle → dist/
npx cap sync android # copy it into the android/ project
cd android && ./gradlew assembleDebug   # → android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

After changing UI code you must run the whole chain — `npm run build` → `npx cap sync android` →
`gradlew` → install. Editing the output under `android/app/src/main/assets/` directly works until
the next `cap sync` overwrites it.

The first build needs the Android SDK (`platforms;android-36` + `build-tools;36.0.0`) and
`android/local.properties` pointing at it. Dependency sources in `android/build.gradle` prefer
mirrors over the origin: connecting to Maven Central directly from some networks fails during the
TLS handshake. The reasoning and the measured numbers are in the comment at the top of that file.

Gate before committing:

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

The test-suite inventory and two device-only traps (force-rebuilding the scheduling index on the
second load; disabling the HTTP cache in the network layer) are in the "Android app" section of
[docs/en/development.md](../docs/en/development.md) (中文: [docs/zh/development.md](../docs/zh/development.md)).

## Target and configuration

The app targets Android 15 and up (compiled and targeted against API 36, `minSdkVersion 24`) and
runs edge-to-edge, so content is laid out around the system bars and the on-screen keyboard rather
than being resized by the system — see the "Android app" section in the development doc if you are
touching layout or input handling.

The phone workspace is **not** the folder the desktop app has open — it is created by syncing:

1. Install the APK and open **Settings → Sync**.
2. Enter a private git repository (`owner/repo`), the branch to sync (the main branch to start
   with), and a **fine-grained PAT** with **Contents: read/write** on that repository only.
3. Tap **Save and verify** (it calls GitHub to check the repository and branch are reachable), then
   **Sync now** to pull the workspace onto the phone.

Credentials live only in the app's private storage (other apps cannot read them) and the UI shows
only the first and last four characters when echoing them; **Clear credentials** removes the token alone.

## Sync model

Sync runs in one of three modes: a **full** round trip (pull, merge, push), **pull-only** (used on
return to foreground — it never pushes), and **force-pull** (used to discard local state and take
the remote as-is). Data files are NDJSON, so most of the merge is a line union; two cases are
deliberately not guessed at:

- **The same record edited differently on both sides** — the same card id with different content, or
  a JSON document (`decks.json` / `config.json`) that changed in both places — stops the merge and
  reports it instead of picking a winner. `decks.json` and `config.json` are whole documents, so a
  line union is not meaningful for them.
- **Nothing to merge**: when the remote has no new commits, the round trip is a no-op and the app
  does not create an empty commit.

Every sync reports what it did (commits seen, files merged, reviews uploaded); the previous few
workspace snapshots are kept so a bad merge can be rolled back.

## What v1 does not do

- **Append-only, never compacts on the phone.** The phone never rewrites the card base files.
  Compaction (checkpoint + delta convergence) stays on the desktop because that step needs
  information beyond concatenating lines.
- **No extreme-performance claims.** The goal is a usable app on a personal phone; a large
  workspace (200 decks / 5000 cards / 20k events) reaches ready state in 2.3–2.6s, which is enough.
- **Debug signing.** The published artifact is a debug-signed APK (Android shows it as a
  development build). Long-term personal use or migration to a new phone would want a release
  keystore and a versionCode policy; that is not implemented yet.
