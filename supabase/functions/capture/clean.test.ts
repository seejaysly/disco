import { cleanUrl } from "./clean.ts";
const cases: [string, number|undefined, string][] = [
  ["https://www.quantamagazine.org/x/?utm_source=nl&utm_medium=email&fbclid=abc#:~:text=black", undefined, "https://www.quantamagazine.org/x/"],
  ["https://www.nytimes.com/2026/a.html?smid=url-share&id=7#section-2", undefined, "https://www.nytimes.com/2026/a.html?id=7#section-2"],
  ["https://youtu.be/dQw4w9WgXcQ?si=xyz", 95.7, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s"],
  ["https://m.youtube.com/watch?v=abc123&feature=share&list=PL1", 0, "https://www.youtube.com/watch?v=abc123&list=PL1&t=0s"],
  ["https://www.youtube.com/watch?v=AKTyPgwfPgg&list=RDLVAKTyPgwfPgg&start_radio=1", 457, "https://www.youtube.com/watch?v=AKTyPgwfPgg&t=457s"],
  ["https://www.youtube.com/shorts/zz9", undefined, "https://www.youtube.com/watch?v=zz9"],
  ["https://vimeo.com/76979871", 42, "https://vimeo.com/76979871#t=42"],
  ["http://example.com/talk.mp4", 30, "https://example.com/talk.mp4#t=30"],
  ["kindle://book?action=open&asin=B000FC1JAI&location=1234", undefined, "kindle://book?action=open&asin=B000FC1JAI&location=1234"],
];
let fail = 0;
for (const [i, t, want] of cases) { const got = cleanUrl(i, t)?.url; const ok = got === want; if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", i, "->", got, ok ? "" : "want " + want); }
console.log("domain:", cleanUrl("https://www.quantamagazine.org/x")?.domain, cleanUrl("https://amp.theguardian.com/a")?.domain);
console.log("bad url:", cleanUrl("not a url"));
process.exit(fail);
