// Memory Companion — looks up a song/playlist link's title and cover picture.
// Only YouTube, Spotify and Apple Music links are accepted, and only circle members may ask.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ALLOWED = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$|^open\.spotify\.com$|^(music|embed\.music)\.apple\.com$/i;

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function meta(html: string, prop: string) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"));
  return m ? decode(m[1]) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Please sign in" }, 401);
  const { count } = await admin.from("members").select("user_id", { count: "exact", head: true }).eq("user_id", user.id);
  if (!count) return json({ error: "Not part of a care circle" }, 403);

  let url: URL;
  try { url = new URL(String((await req.json()).url || "")); } catch { return json({ error: "That doesn't look like a link" }, 400); }
  if (url.protocol !== "https:" || !ALLOWED.test(url.hostname)) return json({ error: "Only YouTube, Spotify and Apple Music links" }, 400);

  try {
    if (/youtu/.test(url.hostname)) {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.href)}`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      if (!r.ok) return json({ error: "Couldn't find that YouTube video (is it private?)" }, 404);
      const d = await r.json();
      return json({ title: d.title || "", artist: d.author_name || "", thumb: d.thumbnail_url || "" });
    }
    if (/spotify/.test(url.hostname)) {
      const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url.href)}`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      if (!r.ok) return json({ error: "Couldn't find that on Spotify" }, 404);
      const d = await r.json();
      return json({ title: d.title || "", artist: "", thumb: d.thumbnail_url || "" });
    }
    // Apple Music has no public lookup, so read the page's title and cover picture.
    const r = await fetch(url.href, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MemoryCompanion/1.0)" }, redirect: "manual", signal: AbortSignal.timeout(8000) });
    if (!r.ok) return json({ error: "Couldn't find that on Apple Music" }, 404);
    const html = (await r.text()).slice(0, 400000);
    const title = meta(html, "apple:title");
    if (!title || /web player/i.test(title)) return json({ error: "Couldn't find that on Apple Music. Check the link." }, 404);
    // og:title looks like "Abbey Road by The Beatles on Apple Music"
    const artist = (meta(html, "og:title").match(/ by (.+?) on Apple\s*Music$/i) || [])[1] || "";
    return json({ title, artist: artist.trim(), thumb: meta(html, "og:image") });
  } catch (err) {
    console.error("linkinfo", err);
    return json({ error: "Couldn't look that link up just now. Please try again." }, 502);
  }
});
