// Memory Companion — warm voice service (ElevenLabs).
// The ElevenLabs key lives only here, as a server secret. Callers must be signed in
// AND belong to a care circle, so nobody else can use up the voice allowance.
// A caller may only use the account's narrator voices (premade or library voices) or
// family voices cloned for a circle they belong to (public.voices, server-only).
// Every phrase is cached in the private "voice" bucket, so repeats are free.
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "eleven_multilingual_v2"; // supports the speed setting
const MAX_CHARS = 2500;
const DAILY_CHARS = 20000; // per person per day, for new (uncached) speech
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Voice = { voice_id: string; name: string; category?: string; labels?: unknown; description?: string; preview_url?: string };
let voiceCache: { at: number; voices: Voice[] } | null = null;
async function accountVoices(key: string): Promise<Voice[]> {
  if (voiceCache && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.voices;
  const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`voices list ${r.status}`);
  const voices = ((await r.json()).voices || []) as Voice[];
  voiceCache = { at: Date.now(), voices };
  return voices;
}
// Narrator voices: anything in the account that isn't someone's cloned or designed voice.
const isNarrator = (v: Voice) => v.category !== "cloned" && v.category !== "generated";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Please sign in" }, 401);
  const { data: memberships } = await admin.from("members").select("circle_id").eq("user_id", user.id);
  const circles = (memberships || []).map((m) => m.circle_id as string);
  if (!circles.length) return json({ error: "Not part of a care circle" }, 403);

  const key = Deno.env.get("ELEVENLABS_API_KEY");
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.has("status")) return json({ enabled: !!key });
  if (!key) return json({ error: "Warm voice is not set up" }, 503);

  // The family voices this caller may use: those cloned for one of their circles.
  const { data: own } = await admin.from("voices").select("voice_id").in("circle_id", circles);
  const ownIds = new Set((own || []).map((v) => v.voice_id as string));

  let voices: Voice[];
  try { voices = await accountVoices(key); } catch (err) {
    console.error(err);
    return json({ error: "The warm voice service isn't answering. Please try again." }, 502);
  }
  const allowed = (v: Voice) => isNarrator(v) || ownIds.has(v.voice_id);

  if (req.method === "GET") {
    return json({
      voices: voices.filter(allowed).map((v) => ({
        id: v.voice_id, name: v.name, labels: v.labels || {}, description: v.description || "", preview: v.preview_url || "",
      })),
    });
  }

  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  let body: { text?: string; voiceId?: string; speed?: number };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const text = String(body.text || "").trim().slice(0, MAX_CHARS);
  const voiceId = String(body.voiceId || "").replace(/[^A-Za-z0-9]/g, "");
  const speed = Math.min(1.2, Math.max(0.7, Number(body.speed) || 0.9));
  if (!text || !voiceId) return json({ error: "Missing text or voice" }, 400);
  const voice = voices.find((v) => v.voice_id === voiceId);
  if (!voice || !allowed(voice)) return json({ error: "That voice isn't available to this family" }, 403);

  const path = `${await sha256(`${MODEL}|${voiceId}|${speed}|${text}`)}.mp3`;
  const cached = await admin.storage.from("voice").download(path);
  if (cached.data) return new Response(cached.data, { headers: { ...cors, "Content-Type": "audio/mpeg" } });

  const { data: ok } = await admin.rpc("tts_charge", { p_user: user.id, p_chars: text.length, p_limit: DAILY_CHARS });
  if (!ok) return json({ error: "Today's warm-voice allowance is used up. The phone's own voice will read for now." }, 429);

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    console.error("ElevenLabs TTS", r.status, (await r.text()).slice(0, 300));
    return json({ error: r.status === 401 || r.status === 429 ? "The warm voice allowance has run out for now." : "The warm voice couldn't read that. Please try again." }, 502);
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  await admin.storage.from("voice").upload(path, audio, { contentType: "audio/mpeg", upsert: true });
  return new Response(audio, { headers: { ...cors, "Content-Type": "audio/mpeg" } });
});
