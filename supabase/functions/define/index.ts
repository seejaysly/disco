// Dictionary lookup for vocabulary discos: pronunciation, part of speech, definitions and origin.
// POST { "word": "hegemon" } with the user's sign-in token.
// Replies { word, pronunciation, part_of_speech, definitions: [{ part_of_speech, text, example }], etymology, source }
// or { word, found: false } when nothing is found.
//
// Sources: the Free Dictionary API (built from Wiktionary) for pronunciation and definitions, and
// Wiktionary itself for the word's origin (and for definitions when the first source has none).
// Wiktionary text is CC BY-SA, so the reply names it as the source.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UA = "Disco/2.0 (personal reading notes; vocabulary lookups)";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Api-User-Agent": UA }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<sup[\s\S]*?<\/sup>/gi, "")
      .replace(/<span class="mw-editsection[\s\S]*?<\/span>\s*<\/span>/gi, "")
      .replace(/<[^>]+>/g, ""),
  ).replace(/\s+/g, " ").trim();
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// --- Free Dictionary API ---
async function freeDictionary(word: string) {
  const data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!Array.isArray(data) || !data.length) return null;
  const pronunciation = data.map((e: any) => e.phonetic).find(Boolean)
    || data.flatMap((e: any) => e.phonetics || []).map((p: any) => p.text).find(Boolean) || "";
  const definitions: { part_of_speech: string; text: string; example?: string }[] = [];
  for (const entry of data) {
    for (const m of entry.meanings || []) {
      for (const d of (m.definitions || []).slice(0, 2)) {
        if (definitions.length >= 4) break;
        if (d.definition) definitions.push({ part_of_speech: m.partOfSpeech || "", text: d.definition, example: d.example || undefined });
      }
    }
  }
  const origin = data.map((e: any) => e.origin).find(Boolean) || "";
  return definitions.length ? { pronunciation, definitions, origin } : null;
}

// --- Wiktionary definitions (fallback) ---
async function wiktionaryDefinitions(word: string) {
  const data = await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`);
  const en = data?.en;
  if (!Array.isArray(en)) return null;
  const definitions: { part_of_speech: string; text: string; example?: string }[] = [];
  for (const block of en) {
    for (const d of block.definitions || []) {
      if (definitions.length >= 4) break;
      const text = htmlToText(d.definition || "");
      if (!text) continue;
      const ex = (d.examples || []).map((x: string) => htmlToText(x)).find(Boolean);
      definitions.push({ part_of_speech: (block.partOfSpeech || "").toLowerCase(), text, example: ex || undefined });
    }
  }
  return definitions.length ? { pronunciation: "", definitions, origin: "" } : null;
}

// --- Wiktionary etymology (the English "Etymology" section) ---
async function wiktionaryEtymology(word: string): Promise<string> {
  const base = "https://en.wiktionary.org/w/api.php?format=json&redirects=1&page=" + encodeURIComponent(word);
  const secs = await getJson(`${base}&action=parse&prop=sections`);
  const sections: any[] = secs?.parse?.sections || [];
  const en = sections.findIndex((s) => s.level === "2" && s.line === "English");
  if (en < 0) return "";
  let idx: string | null = null;
  for (let i = en + 1; i < sections.length && sections[i].level !== "2"; i++) {
    if (/^Etymology/.test(sections[i].line)) { idx = sections[i].index; break; }
  }
  if (!idx) return "";
  const page = await getJson(`${base}&action=parse&prop=text&disabletoc=1&section=${idx}`);
  const html: string = page?.parse?.text?.["*"] || "";
  const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((m) => htmlToText(m[1])).filter(Boolean);
  let text = paras.join(" ");
  if (!text) text = htmlToText(html).replace(/^Etymology( \d+)?\s*/i, "");
  if (text.length > 600) text = text.slice(0, 600).replace(/\s+\S*$/, "") + "…";
  return text;
}

async function lookup(word: string) {
  const [dict, etym] = await Promise.all([freeDictionary(word), wiktionaryEtymology(word)]);
  const def = dict || (await wiktionaryDefinitions(word));
  if (!def && !etym) return null;
  const defs = def?.definitions || [];
  return {
    word,
    found: true,
    pronunciation: def?.pronunciation || "",
    part_of_speech: defs[0]?.part_of_speech || "",
    definitions: defs.map((d) => ({ ...d, text: cap(d.text) })),
    etymology: etym || def?.origin || "",
    source: "Wiktionary",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) return json({ error: "Sign in first" }, 401);

  let word = "";
  try {
    word = String((await req.json())?.word || "").trim();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  if (!/^[\p{L}][\p{L}'’-]{0,39}$/u.test(word)) return json({ error: "Send one word" }, 400);

  // Dictionary pages are case-sensitive: try lower case first ("Hegemon" at the start of a
  // sentence is the word "hegemon"), then the word as written.
  let result = await lookup(word.toLowerCase());
  if (!result && word !== word.toLowerCase()) result = await lookup(word);
  return json(result || { word, found: false });
});
