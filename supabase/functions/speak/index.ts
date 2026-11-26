// Memory Companion — warm voice service (ElevenLabs).
// The ElevenLabs key lives only here, as a server secret. Callers must be signed in
// AND belong to a care circle, so nobody else can use up the voice allowance.
// Every phrase is cached in the private "voice" bucket, so repeats are free.
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "eleven_multilingual_v2"; // supports the speed setting
const MAX_CHARS = 2500;
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Please sign in" }, 401);
  const { count } = await admin.from("members").select("user_id", { count: "exact", head: true }).eq("user_id", user.id);
  if (!count) return json({ error: "Not part of a care circle" }, 403);

  const key = Deno.env.get("ELEVENLABS_API_KEY");
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.has("status")) return json({ enabled: !!key });
    if (!key) return json({ error: "Warm voice is not set up" }, 503);
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (!r.ok) return json({ error: `ElevenLabs said ${r.status}` }, 502);
    const data = await r.json();
    const voices = (data.voices || []).map((v: Record<string, unknown>) => ({
      id: v.voice_id, name: v.name, labels: v.labels || {}, description: v.description || "", preview: v.preview_url || "",
    }));
    return json({ voices });
  }

  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  if (!key) return json({ error: "Warm voice is not set up" }, 503);

  let body: { text?: string; voiceId?: string; speed?: number };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const text = String(body.text || "").trim().slice(0, MAX_CHARS);
  const voiceId = String(body.voiceId || "").replace(/[^A-Za-z0-9]/g, "");
  const speed = Math.min(1.2, Math.max(0.7, Number(body.speed) || 0.9));
  if (!text || !voiceId) return json({ error: "Missing text or voice" }, 400);

  const path = `${await sha256(`${MODEL}|${voiceId}|${speed}|${text}`)}.mp3`;
  const cached = await admin.storage.from("voice").download(path);
  if (cached.data) {
    return new Response(cached.data, { headers: { ...cors, "Content-Type": "audio/mpeg", "X-Cache": "hit" } });
  }

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed },
    }),
  });
  if (!r.ok) {
    let detail = "";
    try { const e = await r.json(); detail = typeof e.detail === "string" ? e.detail : e.detail?.message || ""; } catch { /* ignore */ }
    return json({ error: `ElevenLabs said ${r.status}. ${detail}`.trim() }, 502);
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  await admin.storage.from("voice").upload(path, audio, { contentType: "audio/mpeg", upsert: true });
  return new Response(audio, { headers: { ...cors, "Content-Type": "audio/mpeg", "X-Cache": "miss" } });
});
