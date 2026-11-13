# Android verification runbook

Goal: verify on an Android emulator that auth works in `apps/mobile`: login, SecureStore token persistence, restart/session restore, logout, expired session, API 401 handling.

## Status (2026-11-13): NOT runtime verified

Attempt: SDK at `~/Android/Sdk` (emulator, platform-tools, android-36 google_apis x86_64) and AVD `crm_pixel` exist, `/dev/kvm` exists, Postgres (port 5436) and the API (`/health` returned `{"ok":true}` on :8787) ran. The emulator process crashed on every start with `Segmentation fault` right after "Emulator is performing a full startup" (tried `-gpu swiftshader_indirect` and `-gpu guest`, with `-no-window -no-snapshot`). `adb devices` stayed empty. No app was ever installed or run on a device. Cause not diagnosed (suspects: host Fedora libs, host GPU/Qt libs, emulator build). Next step for whoever owns the machine: run the emulator with a window (`emulator -avd crm_pixel`) from a normal desktop session, or recreate the AVD / update the emulator via `sdkmanager`.

Mock-only unit tests exist (`packages/api-client/test/client.test.ts`, describe "mobile session wiring (mock only)"). They are NOT runtime verification.

## Code review findings (static, apps/mobile)

- Storage: `src/auth-client.ts` hands `expo-secure-store` to `expoClient({ storagePrefix: "crm" })`. Persistence and restore are done by better-auth's expo plugin, not by repo code. Unverified that it works on device.
- `App.tsx` gates on `authClient.useSession()`; `isPending` shows a spinner, so restore on restart is expected to work if the stored cookie is still valid. Unverified.
- Logout: `authClient.signOut()`. If the network call fails, the error is not surfaced (`.then(() => ({}))` discards it). Unverified whether local state clears offline.
- GAP: `createApiClient` in `App.tsx` does NOT pass `onUnauthorized`. A 401 from `/v1/me` only prints `unauthenticated: ...` and the UI stays "Signed in" until the session hook refetches. Decide whether to call `authClient.signOut()` or refetch the session on 401, then verify on device.
- Dev server is not hardened: `API_URL` defaults to `http://10.0.2.2:8787` (cleartext; fine for the emulator only).

## Prerequisites

```bash
eval "$(fnm env)"; fnm use 24
export ANDROID_HOME=~/Android/Sdk PATH=$PATH:~/Android/Sdk/platform-tools:~/Android/Sdk/emulator
pnpm install
pnpm db:up && pnpm --filter @crm/db migrate     # Postgres on 5436
cp .env.example .env                             # set BETTER_AUTH_SECRET (32+ chars)
pnpm --filter @crm/api dev                       # :8787; check: curl localhost:8787/health
emulator -avd crm_pixel                          # wait for: adb shell getprop sys.boot_completed -> 1
cd apps/mobile && pnpm exec expo start --android # installs Expo Go and opens the app
```

The API trusts origin `crm://` (`apps/api/src/server.ts`). The emulator reaches the host API at `http://10.0.2.2:8787`.

## Steps and expected results

| # | Behaviour | Steps | Expected | Evidence to capture | Result |
|---|-----------|-------|----------|---------------------|--------|
| 1 | Login | Tap "Create account" with a new email and 10+ char password, then sign out, then "Sign in" | `signed-in` text shows the email; "Call /v1/me" shows `API says: <email>` | Screenshot `adb exec-out screencap -p > login.png`; API log line | Unverified |
| 2 | SecureStore persistence | After login: `adb shell run-as host.exp.exponent ls files` is not available for Expo Go; instead check by step 3. For a dev build use `run-as <package>` and confirm no plaintext token in `shared_prefs`/`files` | Token not in plaintext app files | Command output | Unverified |
| 3 | Restart / restore | `adb shell am force-stop host.exp.exponent`, reopen the app | Spinner, then still signed in without typing credentials; `/v1/me` works | Screenshot after relaunch | Unverified |
| 4 | Logout | Tap "Sign out" | Login form shown; `/v1/me` no longer callable; relaunch stays logged out | Screenshots before/after relaunch | Unverified |
| 5 | Expired session | Signed in, then in Postgres delete or expire the session row (`DELETE FROM session` as migrator role, or set `"expiresAt"` in the past), tap "Call /v1/me" | API returns 401; app shows `unauthenticated: ...`. Currently expected GAP: UI stays signed in (see findings) | Screenshot, API log with 401 | Unverified |
| 6 | API 401 handling | Stop the API session validity as in step 5, or send a bad cookie; observe the response | Typed error shown, no crash, no raw token in UI or logs | Screenshot, `adb logcat -d \| grep -i cookie` shows no token | Unverified |
| 7 | Offline | Stop the API, tap "Call /v1/me" | Error text shown, no crash | Screenshot | Unverified |

Mark each row Pass / Fail with evidence paths only after running it. Do not mark Pass from the unit tests.

## Status 2026-11-13: DEFERRED by user decision (UNVERIFIED)
Investigation stopped. Findings so far, recorded as observed, not as a diagnosis: with hardware acceleration the emulator (`crm_pixel`, version 37.2.13.0, android-36 x86_64) segfaults in `qemu-system-x86_64-headless` about 20 seconds after "performing a full startup", with `-gpu swiftshader_indirect`, `-gpu guest`, `-gpu off` and with Vulkan disabled (core dumps recorded by systemd-coredump; the crashing frame was not symbolised). With `-accel off` the process stayed alive and `adb` listed it as `offline`; it was not observed to finish booting within the time spent. The cause is not established. The emulator processes started for this task were stopped; mobile source and configuration are unchanged. Login, SecureStore persistence, restart and session restore, logout, expired session and 401 handling remain UNVERIFIED. Do not claim mobile readiness.
