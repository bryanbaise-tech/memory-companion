// Memory Companion — turns a family member's recording into an ElevenLabs voice.
// Only family members of the circle may do this. Recordings are read from the
// circle's private storage folder and deleted afterwards. Which circle owns which
// voice is recorded server-side in public.voices (clients can't read or write it).
import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_VOICES_PER_CIRCLE = 6;
const MAX_SAMPLE_BYTES = 25 * 1024 * 1024;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function friendly(status: number, detail: string) {
  if (/instant_voice_cloning|can_not_use|upgrade|subscription|plan/i.test(detail)) {
    return "Your ElevenLabs plan doesn't include voice cloning yet. It needs the Starter plan ($5/month) or higher.";
  }
  if (/permission|missing_permissions|voices_write/i.test(detail) || status === 401) {
    return "The ElevenLabs key isn't allowed to create voices. In ElevenLabs → API Keys, turn on 'Voices: Write' for this key.";
  }
  if (/voice_limit|limit_reached|too many voices/i.test(detail)) return "Your ElevenLabs account has no free voice slots left. Remove an unused voice there first.";
  if (/too short|duration|minimum/i.test(detail)) return "The recording is too short. Please record at least one minute.";
  return "ElevenLabs couldn't make the voice from that recording. Please try again.";
}

// Every cached clip of a voice lives under voice/<voiceId>/ (see speak).
async function removeCachedClips(admin: ReturnType<typeof createClient>, voiceId: string) {
  for (;;) {
    const { data } = await admin.storage.from("voice").list(voiceId, { limit: 1000 });
    const files = (data || []).filter((o) => o.id).map((o) => `${voiceId}/${o.name}`);
    if (!files.length) return;
    for (let i = 0; i < files.length; i += 100) await admin.storage.from("voice").remove(files.slice(i, i + 100));
    if (files.length < 1000) return;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Please sign in" }, 401);

  let body: { action?: string; circleId?: string; name?: string; paths?: unknown; voiceId?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Bad request" }, 400);
  const rawCircle = String(body.circleId || "");
  if (!UUID.test(rawCircle)) return json({ error: "Bad request" }, 400);
  const circleId = rawCircle.toLowerCase(); // storage paths are case-sensitive
  const { data: m } = await admin.from("members").select("role").eq("circle_id", circleId).eq("user_id", user.id).maybeSingle();
  if (!m || m.role !== "family") return json({ error: "Only family members can manage voices" }, 403);

  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key) return json({ error: "Warm voice is not set up" }, 503);

  if (body.action === "delete") {
    const voiceId = String(body.voiceId || "").replace(/[^A-Za-z0-9]/g, "");
    const { data: owned } = await admin.from("voices").select("voice_id").eq("voice_id", voiceId).eq("circle_id", circleId).maybeSingle();
    if (!owned) return json({ error: "That voice isn't part of this circle" }, 404);
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, { method: "DELETE", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15000) });
    if (!r.ok && r.status !== 404) {
      console.error("ElevenLabs delete", r.status, (await r.text()).slice(0, 300));
      return json({ error: "Couldn't remove that voice just now. Please try again." }, 502);
    }
    await admin.from("voices").delete().eq("voice_id", voiceId);
    await removeCachedClips(admin, voiceId);
    return json({ ok: true });
  }

  // action: create
  const { count } = await admin.from("voices").select("voice_id", { count: "exact", head: true }).eq("circle_id", circleId);
  if ((count || 0) >= MAX_VOICES_PER_CIRCLE) return json({ error: `This family already has ${MAX_VOICES_PER_CIRCLE} voices. Remove one first.` }, 400);

  const name = String(body.name || "").trim().slice(0, 60) || "Family voice";
  // Exact shape only: <circle>/voice-samples/<id>.<ext>. No "..", "%" or "\" can get through.
  const shape = new RegExp(`^${circleId}/voice-samples/[a-z0-9]+\\.[a-z0-9]{1,5}$`);
  if (!Array.isArray(body.paths)) return json({ error: "Bad request" }, 400);
  const raw = body.paths.map(String);
  if (raw.some((p) => !shape.test(p) || /\.\.|%|\\/.test(p))) return json({ error: "Bad recording path" }, 400);
  const paths = raw.slice(0, 5);
  if (!paths.length) return json({ error: "No recording found" }, 400);

  // Check sizes before downloading anything into memory.
  const { data: listed } = await admin.storage.from("media").list(`${circleId}/voice-samples`, { limit: 1000 });
  const sizes = new Map((listed || []).map((o) => [`${circleId}/voice-samples/${o.name}`, Number((o.metadata as Record<string, unknown>)?.size || 0)]));
  if (paths.some((p) => !sizes.has(p))) return json({ error: "Couldn't find the recording. Please try again." }, 400);
  const total = paths.reduce((n, p) => n + (sizes.get(p) || 0), 0);
  if (total > MAX_SAMPLE_BYTES) {
    await admin.storage.from("media").remove(paths);
    return json({ error: "That recording is too large. About two minutes is plenty." }, 400);
  }
  if (total < 40_000) return json({ error: "The recording is too short. Please record at least one minute." }, 400);

  const form = new FormData();
  form.append("name", `${name} · Memory Companion`);
  form.append("description", "Family voice recorded for Memory Companion, with permission.");
  form.append("remove_background_noise", "true");
  let downloaded = 0;
  for (const [i, p] of paths.entries()) {
    const { data, error } = await admin.storage.from("media").download(p);
    if (error || !data) return json({ error: "Couldn't read the recording. Please try again." }, 400);
    downloaded += data.size; // re-check: the file could have changed since it was listed
    if (downloaded > MAX_SAMPLE_BYTES) {
      await admin.storage.from("media").remove(paths);
      return json({ error: "That recording is too large. About two minutes is plenty." }, 400);
    }
    const ext = (p.split(".").pop() || "m4a").toLowerCase();
    form.append("files", new File([data], `sample-${i + 1}.${ext}`, { type: data.type || "audio/mpeg" }));
  }

  const r = await fetch("https://api.elevenlabs.io/v1/voices/add", { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  // The recordings are no longer needed once the voice exists (or failed); delete them for privacy.
  await admin.storage.from("media").remove(paths);
  if (!r.ok) {
    console.error("ElevenLabs add", r.status, text.slice(0, 500));
    let detail = text;
    try { const e = JSON.parse(text); detail = typeof e.detail === "string" ? e.detail : (e.detail?.message || e.detail?.status || text); } catch { /* raw */ }
    return json({ error: friendly(r.status, String(detail)) }, 502);
  }
  const d = JSON.parse(text);
  const { error: saveErr } = await admin.from("voices").insert({ voice_id: d.voice_id, circle_id: circleId, created_by: user.id });
  if (saveErr) {
    // Never leave a clone at ElevenLabs that no family owns: remove it again.
    console.error("voices insert", saveErr.message);
    await fetch(`https://api.elevenlabs.io/v1/voices/${d.voice_id}`, { method: "DELETE", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15000) }).catch(() => {});
    const full = /6 voices/.test(saveErr.message);
    return json({ error: full ? `This family already has ${MAX_VOICES_PER_CIRCLE} voices. Remove one first.` : "Couldn't save the voice. Please try again." }, full ? 400 : 502);
  }
  return json({ voiceId: d.voice_id });
});
