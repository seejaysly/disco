// Disco capture endpoint: one address for the Chrome extension, iPhone Shortcut,
// paste box and Kindle import. Requires the user's sign-in token (Authorization: Bearer ...).
//
// POST body (JSON), all optional except at least one of quote / text_captured / image / video moment:
// {
//   "quote": "summary or the highlighted text",
//   "text_captured": "original captured text",
//   "prefix": "words before", "suffix": "words after", "note": "my note",
//   "url": "https://...", "title": "page title",
//   "site_name": "Quanta Magazine", "author": "...", "published_at": "2026-10-01",
//   "tags": ["black holes", "physics"],
//   "kind": "highlight|vocabulary|image|video|note"   (inferred if left out),
//   "video": { "start_seconds": 95, "end_seconds": 140, "caption_text": "..." },
//   "image": { "storage_path": "<user_id>/file.jpg", "original_url": "...", "alt_text": "...", "caption": "...", "width": 800, "height": 600 },
//   "book": { "title": "...", "author": "...", "asin": "...", "location": 1234 },
//   "capture_method": "extension|shortcut|share|paste|kindle",
//   "client_id": "unique id from the device, so retries never duplicate",
//   "captured_at": "ISO time"
// }

import { createClient } from "npm:@supabase/supabase-js@2";
import { cleanUrl } from "./clean.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const str = (v: unknown, max = 2000) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() && isFinite(+v) ? +v : undefined);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return json({ error: "Sign in first" }, 401);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Body must be a JSON object" }, 400);

  const video = body.video && typeof body.video === "object" ? body.video : null;
  const book = body.book && typeof body.book === "object" ? body.book : null;
  const start = video ? num(video.start_seconds) : undefined;
  const cleaned = cleanUrl(str(body.url, 4000), start);

  const details: Record<string, unknown> =
    body.details && typeof body.details === "object" && !Array.isArray(body.details) ? { ...body.details } : {};
  if (str(body.title, 500)) details.title = str(body.title, 500);
  if (str(body.author, 300)) details.author = str(body.author, 300);
  if (str(body.published_at, 40)) details.published_at = str(body.published_at, 40);

  let kind = str(body.kind, 20);
  let source: Record<string, unknown> | undefined;

  if (book) {
    if (num(book.location) != null) details.location = num(book.location);
    if (str(book.asin, 40)) details.asin = str(book.asin, 40);
    source = { kind: "book", name: str(book.title, 500), author: str(book.author, 300), external_id: str(book.asin, 40) };
  } else if (video || cleaned?.platform) {
    if (video) {
      kind = kind ?? "video";
      details.platform = cleaned?.platform ?? "other";
      if (start != null) details.start_seconds = Math.floor(start);
      if (num(video.end_seconds) != null) details.end_seconds = Math.floor(num(video.end_seconds)!);
      if (str(video.caption_text, 2000)) details.caption_text = str(video.caption_text, 2000);
    }
    source = {
      kind: "video_channel",
      name: str(body.site_name, 300) ?? str(body.author, 300) ?? cleaned?.domain,
      domain: cleaned?.domain,
      external_id: str(body.channel_id, 100),
    };
  } else if (cleaned?.domain) {
    source = { kind: "outlet", name: str(body.site_name, 300) ?? cleaned.domain, domain: cleaned.domain };
  }

  const payload = {
    kind,
    quote: str(body.quote, 20000),
    text_captured: str(body.text_captured, 50000),
    prefix: str(body.prefix, 500),
    suffix: str(body.suffix, 500),
    note: str(body.note, 10000),
    url: cleaned?.url,
    details,
    source,
    tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === "string").slice(0, 25) : [],
    image: body.image && typeof body.image === "object" ? body.image : undefined,
    capture_method: str(body.capture_method, 20) ?? "extension",
    client_id: str(body.client_id, 100),
    captured_at: str(body.captured_at, 40),
  };

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc("capture_disco", { p: payload });
  if (error) {
    const status = error.code === "28000" || error.code === "42501" ? 403 : error.code?.startsWith("22") ? 400 : 500;
    if (status === 500) console.error("capture_disco failed", error);
    return json({ error: error.message }, status);
  }
  return json({ ok: true, ...data, url: payload.url }, data?.duplicate ? 200 : 201);
});
