// Memory Companion — deletes the caller's own account (App Store requirement).
// Rule agreed with the family: what a person shared (photos, messages, stories) stays with
// the family unless they also choose "delete what I shared". Their cloned voice is always
// removed (it is their voice). The last family member of a circle that still has other
// must delete the circle (or invite another relative) first.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Please sign in" }, 401);
  let deleteShared = false;
  try { const b = await req.json(); deleteShared = !!(b && typeof b === "object" && b.deleteShared === true); } catch { /* empty body is fine */ }

  // 1) Refuse if this would leave a circle with members but no family.
  const { data: mine } = await admin.from("members").select("circle_id, role").eq("user_id", user.id);
  for (const m of mine || []) {
    if (m.role !== "family") continue;
    const { data: others } = await admin.from("members").select("user_id, role").eq("circle_id", m.circle_id).neq("user_id", user.id);
    if (!(others || []).some((o) => o.role === "family")) {
      return json({ error: "You're the last family member of this care circle. Invite another relative first, or delete the care circle in Settings (below)." }, 409);
    }
  }

  // 2) Their cloned voices: ElevenLabs, the voices table and cached clips.
  const key = Deno.env.get("ELEVENLABS_API_KEY");
  const { data: voices } = await admin.from("voices").select("voice_id").eq("created_by", user.id);
  for (const v of voices || []) {
    if (!key) return json({ error: "Couldn't remove your voice just now. Please try again." }, 502);
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/${v.voice_id}`, { method: "DELETE", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!r || (!r.ok && r.status !== 404)) return json({ error: "Couldn't remove your voice just now. Please try again." }, 502);
    await admin.from("voices").delete().eq("voice_id", v.voice_id);
    const { data: clips } = await admin.storage.from("voice").list(v.voice_id, { limit: 1000 });
    const files = (clips || []).filter((o) => o.id).map((o) => `${v.voice_id}/${o.name}`);
    for (let i = 0; i < files.length; i += 100) await admin.storage.from("voice").remove(files.slice(i, i + 100));
    await admin.from("items").delete().eq("store", "voices").eq("id", v.voice_id);
  }

  // 3) Optionally, everything they shared.
  if (deleteShared) {
    const { data: rows } = await admin.from("items").select("circle_id, store, id, data").eq("created_by", user.id)
      .in("store", ["messages", "media", "story", "music"]);
    const paths = (rows || []).filter((r) => r.store === "media")
      .map((r) => String((r.data as Record<string, unknown>)?.path || "")).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) await admin.storage.from("media").remove(paths.slice(i, i + 100));
    for (const r of rows || []) await admin.from("items").delete().match({ circle_id: r.circle_id, store: r.store, id: r.id });
  }

  // 4) Memberships, then the account itself.
  await admin.from("members").delete().eq("user_id", user.id);
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) { console.error("deleteUser", error); return json({ error: "Couldn't finish deleting your account. Please try again." }, 502); }
  return json({ ok: true });
});
