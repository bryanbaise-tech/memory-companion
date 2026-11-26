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

Done: shared backend, family voices, music links, who-sent-it labels on photos,
the new photo-and-faces look, and the growing flower and garden.

1. **Mom can reply**: a heart button and voice notes back to the sender, plus "Mom saw it."
2. **Picture-frame mode**: an idle slideshow with a big clock, dimmed at night.
   Includes a view of her flower garden filling up over the weeks.
3. **Evening calm mode**: warmer screen, music and a familiar voice from late afternoon.
4. **Life story** and "On this day."
5. **Native iPhone milestone**, done as one piece:
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
6. **App Store** release, which needs the Apple Developer Program ($99 a year).
