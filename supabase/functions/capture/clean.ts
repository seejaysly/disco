// URL cleanup and video deep links for Disco captures.

const TRACKING_PREFIXES = ["utm_", "mc_", "_hs", "vero_", "oly_", "pk_", "hsa_", "ga_"];
const TRACKING_KEYS = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "igshid", "yclid", "twclid", "ttclid",
  "ref", "ref_src", "ref_url", "referrer", "cmpid", "smid", "smtyp", "sr_share", "s_cid", "mkt_tok",
  "spm", "ocid", "icid", "feature", "si", "share", "partner", "at_medium",
  "at_campaign", "guccounter", "guce_referrer", "guce_referrer_sig", "trk", "trkinfo", "__twitter_impression",
]);

export interface CleanResult {
  url: string;
  domain: string | null;
  platform: "youtube" | "vimeo" | null;
}

export function bareDomain(host: string): string {
  return host.toLowerCase().replace(/^(www\d*|m|amp|mobile)\./, "");
}

function youtubeId(u: URL): string | null {
  const host = bareDomain(u.hostname);
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (host === "youtube.com" || host === "music.youtube.com") {
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/);
    if (m) return m[2];
  }
  return null;
}

/** Clean a captured URL. Pass startSeconds to build a deep link to that moment in a video. */
export function cleanUrl(raw: string | null | undefined, startSeconds?: number | null): CleanResult | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    // e.g. kindle:// links: keep as given
    return { url: raw.trim(), domain: null, platform: null };
  }
  u.protocol = "https:";
  const t = startSeconds != null && isFinite(startSeconds) && startSeconds >= 0 ? Math.floor(startSeconds) : null;

  const yt = youtubeId(u);
  if (yt) {
    const out = new URL("https://www.youtube.com/watch");
    out.searchParams.set("v", yt);
    const keepList = u.searchParams.get("list");
    if (keepList) out.searchParams.set("list", keepList);
    if (t != null) out.searchParams.set("t", `${t}s`);
    return { url: out.toString(), domain: "youtube.com", platform: "youtube" };
  }

  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (TRACKING_KEYS.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p))) u.searchParams.delete(key);
  }
  // Drop text-fragment highlights (#:~:text=...) and empty hashes; keep real anchors
  if (u.hash.startsWith("#:~:") || u.hash === "#") u.hash = "";

  const domain = bareDomain(u.hostname);
  let platform: CleanResult["platform"] = null;
  if (domain === "vimeo.com" || domain === "player.vimeo.com") platform = "vimeo";
  if (t != null) {
    // Vimeo and plain video files both understand #t=<seconds>
    u.hash = `t=${t}`;
  }
  let url = u.toString();
  if (url.endsWith("?")) url = url.slice(0, -1);
  return { url, domain, platform };
}
