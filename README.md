<img src="assets/icon.svg" width="64" height="64" alt="">

# Memory Companion

A simple, calm daily companion for people living with memory loss, plus a
family mode for the people who care for them.

## Use it

**Web address:** <https://bryanbaise-tech.github.io/memory-companion/>

1. **Family member:** open the address → "I'm family or a caregiver" → enter your email →
   tap the sign-in link in the email → set up your loved one.
2. **Pair their phone/tablet:** Family tools → Family & devices → *Get a pairing code*.
   On their device, open the address → "This phone is for my loved one" → type the code.
   Then Share → **Add to Home Screen**.
3. **Invite relatives:** Family & devices → *Get an invite code*. They sign in with their own
   email, choose "I have an invite code", and join.

## How it works

- **App:** plain HTML/CSS/JavaScript hosted on GitHub Pages (no build step).
- **Data:** Supabase (Postgres + Storage). One *care circle* per loved one; row-level
  security means only circle members can read or change anything. Schema:
  [`supabase/schema.sql`](supabase/schema.sql).
- **Sign-in:** family by email link; the loved one's device signs in anonymously and joins a
  circle with a one-time QR code or link (24 h), or an 8-digit code typed within 30 minutes; guessing is rate-limited per account and per circle.
- **Live updates:** messages and check-offs appear on every device instantly (Supabase Realtime).
- **Warm voice:** the [`speak`](supabase/functions/speak/index.ts) edge function calls ElevenLabs
  ("Brady J – Friendly, Casual, Warm"). The ElevenLabs key is a server secret, only circle
  members can use it, and every phrase is cached so repeats are free.
- **Reminders** pop up, chime and are read aloud while the app is open on the loved one's device.

### Local development

Double-click `start.command` (runs `serve.py` on <http://localhost:8080>). Secrets
(`.elevenlabs-key`, `.supabase-token`) are git-ignored and never served.

## Why it doesn't read the phone's texts directly

iPhones don't let third-party apps read iMessages or SMS at all. Android allows
it only for an app that replaces the default texting app, and Google Play
rarely approves that. Apps in this space use a **family circle** instead:
family members send messages, photos and videos *into* the app. That's the
model here.

## Roadmap

Done: shared backend, family voices, music links, who-sent-it labels on photos,
the new photo-and-faces look, the growing flower and garden, Mom can reply
(hearts, voice messages, seen/read), the pairing security fixes, and
picture-frame mode (photos, garden, night clock), and evening calm mode.

1. **Life story** and "On this day."
2. **Native iPhone milestone**, done as one piece:
   - a Swift app that wraps the web app, with the web files bundled inside so it opens offline
   - real notifications, including "Mom missed her pills" alerts to family and
     a happy "Mom's flower bloomed today 🌸" note
   - a share extension, so family can send photos from the Photos app
   - in-app account deletion (Apple requires it). Decision still needed: when a
     relative deletes their account, what happens to photos and messages they
     shared? Suggested: they stay with the family unless the person also chooses
     "delete what I shared"; deleting the whole family circle removes everything.
     Decided: use this rule. Deleting a circle must also delete media/<circle_id>/*
     in storage on the server side (today only the app's reset button does it).
3. **App Store** release, which needs the Apple Developer Program ($99 a year).

### Security follow-ups (from the second outside review)

Done: per-circle voices (server-only table), strict sample paths, no DELETE broadcasts
(tombstones instead), safe links/colors and escaped ids, SRI on CDN scripts, 8-digit codes
with per-account and per-circle guess limits, family-only hard deletes and storage deletes,
media types restricted, daily warm-voice allowance, voice and sample-size caps, server-side
circle deletion (files + cloned voices), 1-hour signed links, JWT-verified functions,
last-family-member guard, nightly cleanup of tombstones and unpaired anonymous accounts.

Still to do:
- Turn on CAPTCHA (Cloudflare Turnstile) for anonymous sign-ins in the Supabase dashboard,
  then pass the token from the pairing screen.
- Server-verified family PIN (hash in a no-grant table, rate-limited unlock that opens a
  30-minute window for device writes to family data). Today the PIN is a screen lock only.
- Expire old cached voice clips in the private "voice" bucket.
- Optional: store replies and "seen" marks as their own rows stamped by the server, if they
  ever need to be proof rather than a friendly signal.

