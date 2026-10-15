# Coda tag → DIG topic mapping (Phase 2)

- `coda_tag_proposals.json`: one entry per Coda tag (by Coda row id): its kind (subject, person,
  work, place, group), and either its placement in the DIG tree (`rel` same/under/none + `code`)
  or its subject `links` (and `by` for works). Proposed by Claude; CJ reviews on the tag review page.
- `dig_catalog_codes.txt`: the DIG taxonomy with the short codes used in the proposals.
- `dig_code_to_topic_id.json`: short code → `topics.id` in Supabase.

CJ's review decisions live in the review page's database (collection `decisions`, keyed `t<rowid>`
for tags and `dupe-<n>` for duplicate merges). The import applies proposals plus those decisions.
- `single_tag_disco_suggestions.json`: extra tags proposed for the 62 discos that carried one tag
  (excluding vocabulary, CJ ideas/thoughts and the 197 guide headers stored as discos in Coda).
  CJ's edits: review page decisions keyed `d<disco rowid>` with `drop` and `add` lists.
- `theme_spread_test_2026-10-15.json`: first theme test. For each tag with 5+ discos, how widely
  its discos' other tags spread across DIG areas (`neff`), share in its own area, and top areas.
  Clear subjects scored ~1.1 to 1.8; themes like death and power ~7.7 to 7.9; reality and time
  scored mid-pack as two-field bridges. See the feed algorithm doc, "Themes, worked out behind the scenes".

## Source vs. tags rule (agreed with CJ, Oct 15)

The source says where a passage came from; tags say what it's about.

- A book's title and author live on the source only. At import, drop any tag on a disco that names
  that disco's own source (title) or the source's author. The disco stays findable under the book,
  and the feed reads the author through the source.
- Keep a person or work tag whenever it isn't the disco's own source: the subject (an article about
  Carlton McCoy), named in the passage (Kafka's *Metamorphosis* cited as an example of absurdism), or
  a quote whose speaker isn't the source's author (Einstein quoted in someone else's article).
  Tagging a work also files the disco under its creator through the work's `by` link.
- Affects 5 of the 62 single-tag suggestions (14348 Daring Greatly; 15314, 15316, 15317, 15318
  Getting More) and the Coda book tags that match a disco's own source (Getting More's 16 are the
  largest group). Tag rows that end up with no discos still import as topics, so a later disco
  about that book can use them.
- Capture tools apply the same rule: tag suggestions leave out the source's own title and author.
