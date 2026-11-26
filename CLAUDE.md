# Memory Companion

A daily companion for a person with memory loss (the "loved one", Mom) and the family who
cares for her. Web app first (plain HTML/CSS/JS, no build step), Supabase backend, and a thin
native iPhone/iPad shell in `ios/`.

## Layout

- `index.html`, `app.js`, `styles.css`: the whole web app. Live at
  https://bryanbaise-tech.github.io/memory-companion/ (GitHub Pages, deploys on push to `main`).
- `record.html` / `record.css` / `record.js`: the shareable "record your voice" script page.
- `supabase/schema.sql`: tables, row-level security, functions, triggers, cron. Idempotent; apply
  the whole file with `cd supabase && python3 -c "from mgmt import sql; print(sql(open('schema.sql').read()))"`.
- `supabase/functions/<name>/index.ts`: edge functions (speak, voiceclone, linkinfo,
  deletecircle, deleteaccount, housekeeping). Deploy with `python3 supabase/deploy_function.py <name>`
  (verify_jwt is on).
- `supabase/mgmt.py`: Management API helper; reads the token from `.supabase-token` (git-ignored).
- `ios/`: Xcode project (SwiftUI + WKWebView). It loads the live site and adds phone reminders,
  keep-awake for the picture frame, sound with the silent switch on, and `memorycompanion://` links.

## Rules for every change

- **Any change to a screen** (web or iOS): build the iPhone app, run it in the Simulator, and
  return a screenshot (commands below). Web changes appear in the app only after they are pushed
  and live, because the app loads the live site.
- After changing `app.js` or `styles.css`, bump the `?v=` numbers in `index.html` so phones get
  the new files. Check `app.js` parses before pushing:
  `osascript -l JavaScript -e 'function run(){var s=$.NSString.stringWithContentsOfFileEncodingError("app.js",4,null).js;new Function(s);return "ok"}'`
- Top-level code in `app.js` runs before later `let`/`const` exist: never call, at load time, a
  function that reads state declared further down (this once stopped the whole app in the iPhone shell).
- Security conventions (from three outside reviews; keep them):
  - Every stored string that reaches markup goes through `esc()`; every stored link through
    `safeUrl()` (with a host list for embeds, thumbnails and previews); colors through `safeColor()`.
  - No inline `style=` or `onclick=`: both pages have a Content-Security-Policy. Use classes and
    `data-action` handlers. New external hosts must be added to the CSP meta in `index.html`.
  - Deleting goes through `del()` (a tombstone that keeps the content 30 days; family can restore).
    Never hard-delete from the client. Fields starting with `_` are local only.
  - Show senders with `sender(rec)` (checked against the row's server-set `created_by`).
  - Settings come through `mergeSettings()`, which coerces every field.
- Design taste: soft and warm (Apricot Morning: Lora + Figtree, peach/butter/rose/mint), large
  type, never clinical. Show options before restyling.
- Never commit `.supabase-token`, `.elevenlabs-key`, or anything under `ios/build/`.

## iPhone app: build, run, screenshot

No signing identity is needed for the Simulator.

```sh
cd ios
xcodebuild -project MemoryCompanion.xcodeproj -scheme MemoryCompanion -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E "error|BUILD (SUCCEEDED|FAILED)"

DEV=$(xcrun simctl list devices available | grep "iPhone 18 Pro (" | head -1 | grep -oE '[0-9A-F-]{36}')
xcrun simctl boot $DEV 2>/dev/null; xcrun simctl bootstatus $DEV -b >/dev/null
xcrun simctl install $DEV build/Build/Products/Debug-iphonesimulator/MemoryCompanion.app
xcrun simctl launch $DEV com.bryanbaisetech.memorycompanion
sleep 8 && xcrun simctl io $DEV screenshot /tmp/mc-sim.png   # then view the PNG
```

Debug-only test hooks (compiled out of Release):
- `-mcOpenURL memorycompanion://pair?token=<32 hex>` opens a link 6 s after launch, once the page
  is up, like tapping a link while the app is open (avoids the "Open in Companion?" prompt that
  `simctl openurl` shows). Also works with a real sign-in link (`memorycompanion://auth#access_token=…`).
- Debug builds print page errors, CSP blocks, startup and what each tap hits to the console as
  `[web] …` / `[native] …` (`xcrun simctl launch --console-pty …`, or the Xcode console), and the
  web view is inspectable from Safari → Develop.
- `-mcEval "<js>"` runs JavaScript after every page load (e.g. click a button, then
  `window.webkit.messageHandlers.mc.postMessage({type:"debugDump"})`).
- `-mcSkipNotificationPrompt` schedules without asking. The Simulator cannot tap "Allow", so
  iOS refuses to store them; `debugDump` writes `Documents/pending.json` in the app container
  (`xcrun simctl get_app_container $DEV com.bryanbaisetech.memorycompanion data`) with what the app
  received, what got scheduled, and iOS's errors.

To run on a real iPhone: open `ios/MemoryCompanion.xcodeproj` in Xcode, choose your Apple ID
team under Signing & Capabilities, change the bundle id if needed, pick the phone, Run. A free
Apple ID works (the app expires after 7 days); TestFlight and the App Store need the paid program.

## Not built yet (need the paid Apple Developer Program)

- Share extension ("Share to Companion" from Photos) — needs App Groups.
- Push notifications to family (e.g. "Mom's flower bloomed", missed-medicine alerts) — needs APNs.
- Universal links, so https pairing/invite links open the app instead of Safari.
