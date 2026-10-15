# Coda → Supabase copy (Phase 2)

1. Export from Coda and the current feed into a data folder (discos, sources, tag links, tags,
   review decisions, feed storage, CJ's DIG answers). Personal data never goes in this repo.
2. `python3 build.py <data_dir> <out_dir>` applies the tag mapping, CJ's review decisions and the
   agreed rules (see ../tag-mapping/README.md) and writes `part-NNN.sql` files plus `manifest.json`.
   Each part stages JSON in `private.coda_staging`.
3. The parts are run through the Import runner page (it calls the Supabase connector as CJ),
   then `select private.coda_import_apply('<batch>', 'cjennings.me@gmail.com');` does the upserts.

Re-running is safe: discos match by Coda row id, topics by slug, articles by URL hash, sources by
Coda row id / domain. Until cutover Coda wins: discos deleted in Coda are removed, tags and
imported guides are rebuilt from Coda. Run it once more right before cutover (Phase 7).

`supabase/migrations/20261015210000_coda_import.sql` (staging table and apply function) contains
DELETE statements, so CJ runs it in the Supabase SQL editor rather than Claude.

## Personal tags

Tags for people in the user's own life (`PERSONAL` in build.py, confirmed with the user) are created
private to the importing user and marked personal (set `CODA_USER_ID`). The runner calls
`private.coda_import_personal(batch, email)` before `coda_import_apply`. Oct 15: "Anu" (CJ's wife)
had first been imported as the Sumerian god; CJ's 5 discos, guide and paused topic were moved to the
personal topic. The shared "Anu" (Sumerian god) topic stays in the catalog, unused by CJ.
