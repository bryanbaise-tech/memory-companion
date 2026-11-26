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
  circle with a one-time 6-digit code (codes expire in 24 h; guessing is rate-limited).
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

1. ~~Shared backend so family can send messages/photos and see check-ins~~ — done.
2. **Real push notifications** for reminders even when the app is closed.
3. **Native app** (React Native / Expo) for the App Store and Play Store, with
   photo-library access and a "lock to this app" kiosk mode.
4. Voice replies, video calling inside the app, medication tracking, and alerts
   to caregivers when a task is missed.
