// Memory Companion — nightly housekeeping, called by pg_cron (files can't be deleted from SQL).
//  1) Photos/videos deleted 30+ days ago: remove the file, then the tombstone row.
//  2) Cached voice clips older than 90 days (speak makes them again when needed).
// Only callable with the cron secret, which lives in public.server_secrets and this
// function's environment.
import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Not found" }, 404);
  if (!sameSecret(req.headers.get("x-cron-secret") || "", Deno.env.get("CRON_SECRET") || "")) return json({ error: "Forbidden" }, 403);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const out = { mediaFiles: 0, mediaRows: 0, voiceClips: 0 };
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();

  // 1) Old photo tombstones.
  for (;;) {
    const { data: rows, error } = await admin.from("items").select("circle_id, id, data").eq("store", "media")
      .eq("data->>deleted", "true").lt("updated_at", cutoff).limit(200);
    if (error) { console.error(error); break; }
    if (!rows || !rows.length) break;
    const paths = rows.map((r) => String((r.data as Record<string, unknown>)?.path || ""))
      .filter((p, i) => p.startsWith(`${rows[i].circle_id}/`));
    for (let i = 0; i < paths.length; i += 100) {
      const { error: e } = await admin.storage.from("media").remove(paths.slice(i, i + 100));
      if (e) { console.error(e); return json({ ...out, error: "storage" }, 500); }
    }
    out.mediaFiles += paths.length;
    for (const r of rows) await admin.from("items").delete().match({ circle_id: r.circle_id, store: "media", id: r.id });
    out.mediaRows += rows.length;
    if (rows.length < 200) break;
  }

  // 2) Old voice clips (voice/<voiceId>/<hash>.mp3, plus any from the older flat layout).
  const old = Date.now() - 90 * 86400000;
  const { data: top } = await admin.storage.from("voice").list("", { limit: 1000 });
  const flat = (top || []).filter((o) => o.id).map((o) => o.name);
  for (let i = 0; i < flat.length; i += 100) await admin.storage.from("voice").remove(flat.slice(i, i + 100));
  out.voiceClips += flat.length;
  for (const folder of (top || []).filter((o) => !o.id)) {
    const { data: files } = await admin.storage.from("voice").list(folder.name, { limit: 1000, sortBy: { column: "created_at", order: "asc" } });
    const stale = (files || []).filter((f) => f.id && Date.parse(f.created_at || "") < old).map((f) => `${folder.name}/${f.name}`);
    for (let i = 0; i < stale.length; i += 100) await admin.storage.from("voice").remove(stale.slice(i, i + 100));
    out.voiceClips += stale.length;
  }
  return json(out);
});
