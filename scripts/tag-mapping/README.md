# Coda tag → DIG topic mapping (Phase 2)

- `coda_tag_proposals.json`: one entry per Coda tag (by Coda row id): its kind (subject, person,
  work, place, group), and either its placement in the DIG tree (`rel` same/under/none + `code`)
  or its subject `links` (and `by` for works). Proposed by Claude; CJ reviews on the tag review page.
- `dig_catalog_codes.txt`: the DIG taxonomy with the short codes used in the proposals.
- `dig_code_to_topic_id.json`: short code → `topics.id` in Supabase.

CJ's review decisions live in the review page's database (collection `decisions`, keyed `t<rowid>`
for tags and `dupe-<n>` for duplicate merges). The import applies proposals plus those decisions.
