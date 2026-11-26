// Memory Companion — permanently deletes a care circle and everything in it:
// every file under media/<circle>/, the circle's cloned ElevenLabs voices, then the
// circle row (which cascades to members, items, codes and the voices table).
// Family members of that circle only.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Please sign in" }, 401);

  let circleId = "";
  try { circleId = String((await req.json()).circleId || ""); } catch { return json({ error: "Bad request" }, 400); }
  if (!UUID.test(circleId)) return json({ error: "Bad request" }, 400);
  const { data: m } = await admin.from("members").select("role").eq("circle_id", circleId).eq("user_id", user.id).maybeSingle();
  if (!m || m.role !== "family") return json({ error: "Only family members can delete the care circle" }, 403);

  // 1) Files: walk media/<circle>/ (one level of sub-folders, e.g. voice-samples/).
  const removeFolder = async (prefix: string) => {
    for (;;) {
      const { data: objs, error } = await admin.storage.from("media").list(prefix, { limit: 1000 });
      if (error) throw error;
      const files = (objs || []).filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
      const folders = (objs || []).filter((o) => !o.id).map((o) => `${prefix}/${o.name}`);
      for (const f of folders) await removeFolder(f);
      if (!files.length) return;
      for (let i = 0; i < files.length; i += 100) await admin.storage.from("media").remove(files.slice(i, i + 100));
      if (files.length < 1000) return;
    }
  };
  try { await removeFolder(circleId); } catch (err) {
    console.error("storage", err);
    return json({ error: "Couldn't delete the photos just now. Nothing else was deleted; please try again." }, 502);
  }

  // 2) Cloned voices in ElevenLabs.
  const key = Deno.env.get("ELEVENLABS_API_KEY");
  const { data: voices } = await admin.from("voices").select("voice_id").eq("circle_id", circleId);
  if (key) {
    for (const v of voices || []) {
      const r = await fetch(`https://api.elevenlabs.io/v1/voices/${v.voice_id}`, { method: "DELETE", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15000) });
      if (!r.ok && r.status !== 404) console.error("ElevenLabs delete", v.voice_id, r.status);
    }
  }

  // 3) The circle itself; members, items, codes and voices rows cascade.
  const { error } = await admin.from("circles").delete().eq("id", circleId);
  if (error) { console.error("circle delete", error); return json({ error: "Couldn't finish deleting. Please try again." }, 502); }
  return json({ ok: true });
});
