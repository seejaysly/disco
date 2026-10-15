"""Build the Coda -> Supabase import (Phase 2).

Reads the Coda export, the current feed's storage export, the tag proposals and CJ's review
decisions, applies the agreed tagging rules, and writes SQL parts that stage the result as JSON
in private.coda_staging. private.coda_import_apply(batch, email) then upserts everything.

Re-runnable: every row is matched by a natural key (Coda row id, topic slug, article URL hash),
so running it again updates instead of duplicating. That is how the final re-copy at cutover works.

Usage: python3 build.py <data_dir> <out_dir>
data_dir holds: discos.json, sources.json, links.json, coda_tags.json, decisions/*.json,
feeddb/{votes,usedArticles,vocab,settings}/*.json, dig_cj.txt
"""
import glob, hashlib, json, os, re, sys, unicodedata
from collections import defaultdict
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

DATA, OUT = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
MAP = os.path.join(HERE, '..', 'tag-mapping')
BATCH = os.environ.get('BATCH', 'coda')
os.makedirs(OUT, exist_ok=True)

def jl(p): return json.load(open(p, encoding='utf-8'))
def norm(s): return unicodedata.normalize('NFKD', (s or '')).encode('ascii', 'ignore').decode().lower().strip()
def slugify(t):
    s = re.sub(r'[^a-z0-9]+', '-', norm(t)).strip('-')
    return s or 'topic-' + hashlib.md5(t.encode()).hexdigest()[:8]

# ---------------------------------------------------------------- inputs
D = {int(k): v for k, v in jl(f'{DATA}/discos.json').items()}
S = {int(k): v for k, v in jl(f'{DATA}/sources.json').items()}
LINKS = jl(f'{DATA}/links.json')
TAGS = {t['rowid']: t for t in jl(f'{DATA}/coda_tags.json')}
PROP = {p['rowid']: p for p in jl(f'{MAP}/coda_tag_proposals.json')}
CODE2ID = jl(f'{MAP}/dig_code_to_topic_id.json')
REVIEW = jl(f'{MAP}/review_page_data.json')
DEC = {os.path.basename(f)[:-5]: jl(f) for f in glob.glob(f'{DATA}/decisions/*.json')}

DIG_LABEL, DIG_PARENT, DIG_BY_LABEL, BROAD = {}, {}, {}, set()
for line in open(f'{MAP}/dig_catalog_codes.txt', encoding='utf-8'):
    line = line.strip()
    if not line: continue
    code, label = line.split(' ', 1)
    tid = CODE2ID[code]
    DIG_LABEL[tid] = label
    if code.count('.') <= 1: BROAD.add(tid)
    DIG_BY_LABEL.setdefault(label.lower(), tid)
    if '.' in code: DIG_PARENT[tid] = CODE2ID[code.rsplit('.', 1)[0]]

# ---------------------------------------------------------------- topics
# A topic is identified by a ref: a DIG uuid, or 'slug:<slug>' for topics this import creates.
topics = {}          # slug -> {slug,label,kind,parent_id}
aliases = set()      # (alias, ref)
tlinks = set()       # (ref, related_ref, relation)
label_ref = {}       # lower(label or alias) -> ref
ref_label = {}

def ref_parent(ref):
    if ref.startswith('slug:'): return topics.get(ref[5:], {}).get('parent_id')
    return DIG_PARENT.get(ref)

def add_alias(alias, ref):
    if alias.lower() == ref_label.get(ref, '').lower(): return
    if alias.lower() in label_ref and label_ref[alias.lower()] != ref: return  # one topic per short name until the drop step runs
    aliases.add((alias, ref)); label_ref[alias.lower()] = ref

def new_topic(label, kind='subject', parent_code=None, parent_id=None):
    if label.lower() in label_ref: return label_ref[label.lower()]
    if kind == 'subject' and label.lower() in DIG_BY_LABEL and not parent_code:
        ref = DIG_BY_LABEL[label.lower()]; label_ref[label.lower()] = ref; ref_label.setdefault(ref, DIG_LABEL[ref]); return ref
    slug = slugify(label)
    while slug in topics: slug += '-2'
    pid = parent_id or (CODE2ID[parent_code] if parent_code else None)
    topics[slug] = dict(slug=slug, label=label, kind=kind, parent_id=pid if kind in ('subject',) else None)
    ref = 'slug:' + slug
    label_ref[label.lower()] = ref; ref_label[ref] = label
    return ref

for tid, lab in DIG_LABEL.items():
    ref_label[tid] = lab
    label_ref.setdefault(lab.lower(), tid)

COLLECTIONS = {'quotes', 'vocabulary', 'wines to try', 'recipes'}
# Tags for people in the user's own life: private to them, never shared or used to pick feed topics.
# Confirmed with the user before adding a name here.
PERSONAL = {'anu': 'person'}
USER_ID = os.environ.get('CODA_USER_ID', '')
personal_topics = []
def personal_topic(label, kind):
    if not USER_ID: raise SystemExit('set CODA_USER_ID to the importing user id (personal tags are owned by them)')
    slug = slugify(label) + '-' + hashlib.md5(USER_ID.encode()).hexdigest()[:8]
    personal_topics.append(dict(slug=slug, label=label, kind=kind))
    ref = 'slug:' + slug; ref_label[ref] = label
    return ref
NOTE_TAGS = {'cj ideas', 'cj thoughts', 'cj quotes'}

# spelling fixes and merges from the review page
rename = {}
for f in REVIEW['fixes']:
    d = DEC.get(f't{f["r"]}', {})
    if d.get('rename', True) is not False: rename[f['r']] = f['fix']
merge_into = {}      # lower(old name) -> canonical name
for i, dp in enumerate(REVIEW['dupes']):
    if DEC.get(f'dupe-{i}', {}).get('merge', True) is False: continue
    for old, _n in dp['from']: merge_into[old.lower()] = dp['name']

name_by_row = {r: rename.get(r, t['name']) for r, t in TAGS.items()}
row_by_name = {}
for r, n in name_by_row.items(): row_by_name.setdefault(n.lower(), r)

tag_ref = {}         # coda tag rowid -> ref (None = not a topic, e.g. CJ ideas)

def place(label, p):
    """Create or map one tag using its proposal p."""
    kind = p.get('kind') or 'subject'
    if label.lower() in COLLECTIONS: return new_topic(label, 'collection')
    if kind == 'subject':
        if p['rel'] == 'same' and p.get('code'):
            ref = CODE2ID[p['code']]; add_alias(label, ref); return ref
        return new_topic(label, 'subject', parent_code=p['code'] if p['rel'] == 'under' else None)
    ref = new_topic(label, kind)
    for c in p.get('links') or []: tlinks.add((ref, CODE2ID[c], 'about'))
    return ref

# canonical names first, so merged short names become their aliases
order = sorted(TAGS, key=lambda r: name_by_row[r].lower() in merge_into)
pending_by = []
for r in order:
    name = name_by_row[r]
    if name.lower() in NOTE_TAGS: tag_ref[r] = None; continue
    if name.lower() in PERSONAL: tag_ref[r] = personal_topic(name, PERSONAL[name.lower()]); continue
    canon = merge_into.get(name.lower())
    if canon:
        cr = row_by_name.get(canon.lower())
        p = PROP.get(cr) or PROP[r]
        ref = label_ref.get(canon.lower()) or place(canon, p)
        add_alias(name, ref); tag_ref[r] = ref
        if r in rename: add_alias(TAGS[r]['name'], ref)
        continue
    ref = place(name, PROP[r]); tag_ref[r] = ref
    if r in rename: add_alias(TAGS[r]['name'], ref)
    if PROP[r].get('kind') == 'work' and PROP[r].get('by'): pending_by.append((ref, PROP[r]['by']))

# names CJ added on the review page that weren't Coda tags
NEW = {
 'Albert Camus': ('person', ['13.04.4']), 'Jean-Paul Sartre': ('person', ['13.04.4']),
 'Simone de Beauvoir': ('person', ['13.04.4']), 'Tristan Tzara': ('person', ['01.02.1']),
 'Hugo Ball': ('person', ['01.02.1']), 'Emmy Hennings': ('person', ['01.02.1']),
 'Richard Huelsenbeck': ('person', ['01.02.1']), 'Marcel Duchamp': ('person', ['01.02.1']),
 'Fyodor Dostoevsky': ('person', ['02.02.6']), 'Samuel Beckett': ('person', ['02.02']),
 'Nathanael West': ('person', ['02.02']), 'Bob Dylan': ('person', ['10.01']),
 'Andy Smith': ('person', ['05.07']), 'Jenna Davis': ('person', ['05.07']),
 'Carlton McCoy': ('person', ['05.07']), 'Theodore Roosevelt': ('person', ['08.07']),
 'Gary Farrell': ('group', ['05.07.7']),
 'The Metamorphosis': ('work', ['02.02']), 'The Myth of Sisyphus': ('work', ['13.04.4']),
 'Dream Life of Balso Snell': ('work', ['02.02']), 'Tarantula': ('work', ['02.02']),
 'European literature': ('under', '02.02'), 'French cooking': ('under', '05.04'),
 'Napa wine': ('under', '05.07.7'), 'Sonoma wine': ('under', '05.07.7'),
 'chardonnay': ('under', '05.07'), 'riesling': ('under', '05.07'), 'Sonoma chardonnay': ('under', '05.07'),
 'absurdism': ('under', '13.04'), 'new humanism': ('under', '02.02.5'),
 'architectural design': ('under', '01.01'), 'building design': ('under', '01.01'),
 'artistic styles': ('under', '01.04'), 'barbecuing': ('under', '05.04.6'), 'envy': ('under', '14.03.3'),
 'American politics': ('same', '17.08'), 'cooking techniques': ('same', '05.04.6'),
}
SPELL = {'Jean Paul Sartre': 'Jean-Paul Sartre', 'Simon De Beauvier': 'Simone de Beauvoir'}
BY = {'The Metamorphosis': 'Franz Kafka', 'The Myth of Sisyphus': 'Albert Camus',
      'Dream Life of Balso Snell': 'Nathanael West', 'Tarantula': 'Bob Dylan'}
for label, (k, v) in NEW.items():
    if k == 'same': add_alias(label, CODE2ID[v]); continue
    if k == 'under': new_topic(label, 'subject', parent_code=v); continue
    ref = new_topic(label, k)
    for c in v: tlinks.add((ref, CODE2ID[c], 'about'))
for typed, fixed in SPELL.items(): add_alias(typed, label_ref[fixed.lower()])
# a short name CJ replaced with the full name becomes its alias (Camus -> Albert Camus)
for short, full in [('Camus', 'Albert Camus'), ('Sartre', 'Jean-Paul Sartre'), ('Tzara', 'Tristan Tzara')]:
    r = row_by_name.get(short.lower()); ref_full = label_ref[full.lower()]
    if r and tag_ref.get(r) and tag_ref[r].startswith('slug:') and tag_ref[r] != ref_full:
        topics.pop(tag_ref[r][5:], None)
        tlinks = {t for t in tlinks if t[0] != tag_ref[r]}
        label_ref[short.lower()] = ref_full; aliases.add((short, ref_full)); tag_ref[r] = ref_full
pending_by += [(label_ref[w.lower()], p) for w, p in BY.items()]
if 'franz kafka' not in label_ref and 'kafka' not in label_ref:
    k = new_topic('Franz Kafka', 'person'); tlinks.add((k, CODE2ID['02.02.3'], 'about'))
for wref, person in pending_by:
    pref = label_ref.get(person.lower()) or label_ref.get(person.split()[-1].lower())
    if pref and pref != wref: tlinks.add((wref, pref, 'by'))
# artistic styles: design side of art movements
tlinks.add((label_ref['artistic styles'], CODE2ID['01.02.1'], 'related'))
# US government / American government are one topic
usg = tag_ref[row_by_name['us government']]; ag = row_by_name['american government']
if tag_ref[ag] != usg:
    topics.pop(tag_ref[ag][5:], None); tag_ref[ag] = usg; label_ref['american government'] = usg
    aliases.add(('American government', usg))

def ref_of(name):
    n = SPELL.get(name, name)
    return label_ref.get(n.lower()) or label_ref.get(merge_into.get(n.lower(), '').lower())

def ancestors(ref):
    out, seen = [], set()
    p = ref_parent(ref)
    while p and p not in seen:
        seen.add(p); out.append(p); p = DIG_PARENT.get(p)
    return out

# ---------------------------------------------------------------- sources, articles, urls
TRACK = re.compile(r'^(utm_|fbclid$|gclid$|_bhlid$|mc_cid$|mc_eid$|ref_src$|sh$|smid$|smtyp$|cmpid$)')
PRIVATE = ('mail.google.com', 'docs.google.com', 'sites.google.com', 'www.google.com/search', 'google.com/search')
def clean_url(u):
    u = (u or '').strip()
    if not re.match(r'^https?://', u): return None
    if any(p in u for p in PRIVATE): return None
    sp = urlsplit(u)
    q = [(k, v) for k, v in parse_qsl(sp.query, keep_blank_values=True) if not TRACK.match(k)]
    if 'youtube.com' in sp.netloc: q = [(k, v) for k, v in q if k in ('v', 't')]
    frag = '' if sp.fragment.startswith(':~:') else sp.fragment
    return urlunsplit((sp.scheme, sp.netloc.lower(), sp.path, urlencode(q), frag))
def domain(u):
    try: return urlsplit(u).netloc.lower().removeprefix('www.') or None
    except Exception: return None
TIDY = {'PsyPost - Psychology News': 'PsyPost', 'Forbes Magazine': 'Forbes', 'the Guardian': 'The Guardian', 'Space': 'Space.com'}
def tidy(name): name = (name or '').strip(); name = TIDY.get(name, name); return re.split(r'\s+\|\s+', name)[0].strip()
PLACEHOLDER = re.compile(r'^(\[NA.*\]|\(orphaned.*\)|CJ vocab|CJ quotes|CJ ideas|\(headers\)|Fractal website|Pre-Einstein)?$', re.I)
def mdy(s):
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})', s or '')
    return f'{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}' if m else None

sources = {}     # key -> {key, kind, name, author, domain, coda_row_id}
articles = {}    # hash -> {url, hash, headline, source_key, published}
def outlet_key(name, url=None):
    dom = domain(url) if url else None
    name = tidy(name) or dom
    if not name: return None
    key = f'outlet:{dom}' if dom else f'outlet-name:{name.lower()}'
    sources.setdefault(key, dict(key=key, kind='outlet', name=name, author=None, domain=dom, coda_row_id=None))
    return key
def article(url, headline, skey, published=None):
    if not url: return None
    h = hashlib.md5(url.encode()).hexdigest()
    a = articles.setdefault(h, dict(url=url, hash=h, headline=headline, source_key=skey, published=published))
    a['headline'] = a['headline'] or headline; a['source_key'] = a['source_key'] or skey
    return h

src_info = {}    # coda source rowid -> (source_key, url, article_hash, details)
for r, s in S.items():
    title, typ = s['title'].strip(), s['type']
    url = clean_url(s['url'])
    author = s['author'].strip() if s['author'] and not s['author'].startswith('http') else None
    det = {k: v for k, v in dict(source_title=title or None, author=author, published=s['published'] or None).items() if v}
    if PLACEHOLDER.match(title) or typ in ('My notes', 'Vocabulary'):
        src_info[r] = (None, url, None, {}); continue
    if typ == 'Book':
        key = f'book:{r}'
        sources[key] = dict(key=key, kind='book', name=title, author=author, domain=None, coda_row_id=str(r))
        src_info[r] = (key, url, None, det); continue
    kind = {'Video': 'video_channel', 'Podcast': 'podcast', 'Live event': 'other'}.get(typ)
    if kind:
        nm = tidy(s['publication']) or domain(url) or title
        key = f'{kind}:{nm.lower()}'
        sources.setdefault(key, dict(key=key, kind=kind, name=nm, author=None, domain=None, coda_row_id=None))
    else:
        key = outlet_key(s['publication'], url)
    h = article(url, title, key, mdy(s['published']))
    src_info[r] = (key, url, h, det)

# ---------------------------------------------------------------- discos and their tags
links_by_disco = defaultdict(list)
for l in LINKS:
    if isinstance(l['tag'], int) and l['tag'] in TAGS and l['disco'] in D: links_by_disco[l['disco']].append(l)
single = {s['r']: s for s in REVIEW['singles']}
HEADER_SRC = {r for r, s in S.items() if s['title'].strip() == '' and s['type'] == 'My notes'}
VOCAB_ROW = next(r for r, t in TAGS.items() if t['name'] == 'vocabulary')
NOTE_ROWS = {r for r, t in TAGS.items() if t['name'].lower() in NOTE_TAGS}

headers, discos, dtags, skipped = [], {}, {}, defaultdict(int)
replaced = {}    # disco -> (old ref, new ref) for guide moves
dropped_broad = []
by_source = set()   # (disco, topic) dropped because the topic is the disco's own book or author
for r, d in D.items():
    tags = [l['tag'] for l in links_by_disco[r]]
    if d['source'] in HEADER_SRC or (not tags and S.get(d['source'], {}).get('title') == '(headers)'):
        if tags: headers.append(r)
        else: skipped['header without a guide'] += 1
        continue
    if not (d['summary'] or d['text']): skipped['empty'] += 1; continue
    key, url, h, det = src_info.get(d['source'], (None, None, None, {}))
    kind = 'vocabulary' if VOCAB_ROW in tags or S.get(d['source'], {}).get('title') == 'CJ vocab' else \
           'note' if set(tags) & NOTE_ROWS or S.get(d['source'], {}).get('title') == 'CJ ideas' else 'highlight'
    details = dict(det)
    if d['question']: details['question'] = d['question']
    if d['order'] is not None: details['order_in_source'] = d['order']
    summ, text = d['summary'] or d['text'], d['text']
    discos[r] = dict(coda_row_id=str(r), kind=kind, quote=summ, text_captured=text if text and text != summ else None,
                     details=details, url=url, source_key=key, article_hash=h, captured_on=mdy(d['date']))
    # tags: Coda tags, then CJ's review decisions for single-tag discos
    refs = [tag_ref[t] for t in tags if tag_ref.get(t)]
    if r in single:
        s, dec = single[r], DEC.get(f'd{r}', {})
        has = tag_ref.get(row_by_name.get(s['tag'].lower()))
        refs = [x for x in refs if x != has]
        if dec.get('replaceHas'):
            new = ref_of(dec['replaceHas']); refs.append(new); replaced[r] = (has, new)
        elif not dec.get('dropHas'): refs.append(has)
        for t in s['add']:
            if t not in dec.get('drop', []): refs.append(ref_of(t))
        for t in dec.get('add', []): refs.append(ref_of(t))
        if None in refs: raise SystemExit(f'unresolved tag on disco {r}: {s} {dec}')
    refs = list(dict.fromkeys(x for x in refs if x))
    # the "Literary Studies of Critical Thought" passages are literary movements, not art movements
    if det.get('source_title') == 'Literary Studies of Critical Thought' and CODE2ID['01.02.1'] in refs:
        refs = [CODE2ID['02.02.5'] if x == CODE2ID['01.02.1'] else x for x in refs]
        replaced[r] = (CODE2ID['01.02.1'], CODE2ID['02.02.5'])
        refs = list(dict.fromkeys(refs))
    # rule 1: the disco's own book and author live on the source, not in tags
    own = {norm(det.get('source_title')), norm(det.get('author'))} - {''}
    before = len(refs)
    own_refs = [x for x in refs if norm(ref_label.get(x) or topics.get(x[5:], {}).get('label', '')) in own
                or any(norm(a) in own for a, rr in aliases if rr == x)]
    by_source.update((r, x) for x in own_refs)
    refs = [x for x in refs if norm(ref_label.get(x) or topics.get(x[5:], {}).get('label', '')) not in own
            and not any(norm(a) in own for a, rr in aliases if rr == x)]
    skipped['tags dropped: own book or author'] += before - len(refs)
    # rule 2: drop a broad topic (a DIG area or subarea, like physics or art) when a narrower one
    # beneath it is on the same disco. Specific topics (DIG level 3 and below) are always kept.
    anc = set(a for x in refs for a in ancestors(x) if a in BROAD)
    dropped_broad.extend((r, x) for x in refs if x in anc)
    refs = [x for x in refs if x not in anc]
    dtags[r] = refs

for ref in [x for v in dtags.values() for x in v]:
    if ref.startswith('slug:') and ref[5:] in topics: ref_label.setdefault(ref, topics[ref[5:]]['label'])

# ---------------------------------------------------------------- guides
guides = defaultdict(list)   # topic ref -> [(group, rank, item)]
for l in LINKS:
    if not (isinstance(l['tag'], int) and l['tag'] in TAGS): continue
    ref = tag_ref.get(l['tag'])
    if not ref: continue
    rank = float(l['rank']) if re.match(r'^-?\d+(\.\d+)?$', l['rank'] or '') else 1e9 + l['rowid']
    item = dict(note=l['notes'] or None)
    if l['disco'] in headers:
        item['header'] = D[l['disco']]['summary'] or D[l['disco']]['text']
    elif l['disco'] in dtags:
        target = ref
        if l['disco'] in replaced and replaced[l['disco']][0] == ref: target = replaced[l['disco']][1]
        # a disco stays in its author's or book's guide even though the tag itself lives on the source
        if target not in dtags[l['disco']] and (l['disco'], target) not in by_source: continue
        item['disco'] = str(l['disco']); ref = target
    else: continue
    guides[ref].append((l['tag'], rank, item))
guide_out = {}
for r, refs in dtags.items():
    for ref in refs:
        if not any(i[2].get('disco') == str(r) for i in guides[ref]):
            guides[ref].append((10**12, 10**12, dict(disco=str(r), note=None, _date=discos[r]['captured_on'] or '')))
for ref, items in guides.items():
    if not any('disco' in i[2] for i in items): continue
    groups = {}
    for g, _, _ in items: groups.setdefault(g, len(groups))
    items.sort(key=lambda x: (groups[x[0]], x[1], x[2].get('_date', '')))
    seen, out = set(), []
    for _, _, it in items:
        k = it.get('disco') or ('h', it['header'])
        if k in seen: continue
        seen.add(k); it.pop('_date', None); out.append(it)
    guide_out[ref] = out
# source guide: discos with an order in their source (Daring Greatly)
src_guides = defaultdict(list)
for r, d in discos.items():
    if 'order_in_source' in d['details'] and d['source_key']: src_guides[d['source_key']].append((d['details']['order_in_source'], str(r)))

# ---------------------------------------------------------------- feed history, vocab, DIG
def docs(name): return [jl(f) for f in sorted(glob.glob(f'{DATA}/feeddb/{name}/*.json'))]
edition_items, votes = [], []
for a in docs('usedArticles'):
    url = clean_url(a.get('url'))
    if not url: continue
    h = article(url, a.get('headline'), outlet_key(a.get('source'), url))
    edition_items.append(dict(edition=a['edition'], hash=h, topic=ref_of(a.get('topic') or '')))
for v in docs('votes'):
    url = clean_url(v.get('url'))
    if not url: continue
    h = article(url, v.get('title'), outlet_key(v.get('source'), url))
    edition_items.append(dict(edition=v['edition'], hash=h, topic=ref_of(v.get('topic') or '')))
    if v.get('vote') in ('up', 'down'):
        votes.append(dict(hash=h, value=1 if v['vote'] == 'up' else -1, edition=v['edition'], ts=v.get('ts')))
prefs = []
st = jl(f'{DATA}/feeddb/settings/sources.json')
for name in st.get('excluded', {}): prefs.append(dict(source_key=outlet_key(name), preference='block'))
for name in st.get('subscribed', {}): prefs.append(dict(source_key=outlet_key(name), preference='subscribed'))

vocab_docs = {v['rowId']: v for v in docs('vocab')}
def head_word(t): return norm(re.split(r'[|\n:(]', t or '')[0].replace('·', '').replace('ˌ', '')).strip(' :')
vocab_by_word = {}
for r, d in discos.items():
    if d['kind'] != 'vocabulary': continue
    vocab_by_word.setdefault(head_word(d['quote']), r)
    paren = re.match(r'^[^(:|\n]*\(([^)]*)\)', d['quote'] or '')
    for w in re.findall(r'(?:plural of|also)\s+([\w\'-]+)', paren[1] if paren else ''):
        vocab_by_word.setdefault(norm(w), r)
for v in vocab_docs.values():
    r = vocab_by_word.get(norm(v['word']))
    if r is None: skipped['vocab definition without a disco'] += 1; continue
    det = discos[r]['details']
    det.update({k: v[k] for k in ('word', 'pron', 'pos', 'senses', 'etymology') if v.get(k)})
for r, d in discos.items():
    if d['kind'] == 'vocabulary' and 'word' not in d['details']: d['details']['word'] = head_word(d['quote'])
vs = jl(f'{DATA}/feeddb/settings/vocab.json')
progress = {}
for h in vs.get('history', []):
    v = vocab_docs.get(h['id']); r = v and vocab_by_word.get(norm(v['word']))
    if not r: continue
    p = progress.setdefault(r, dict(disco=str(r), first=h['date'], last=h['date'], times=0, learned=False))
    p['first'] = min(p['first'], h['date']); p['last'] = max(p['last'], h['date']); p['times'] += 1
for i in vs.get('suppressed', {}):
    v = vocab_docs.get(i); r = v and vocab_by_word.get(norm(v['word']))
    if r: progress.setdefault(r, dict(disco=str(r), first=None, last=None, times=0, learned=False))['learned'] = True

dig, dig_answers = [], []
for line in open(f'{DATA}/dig_cj.txt', encoding='utf-8'):
    label, rest = line.strip().split(' — ', 1)
    path, how = rest.rsplit(' · ', 1)
    dig_answers.append(dict(interest=label, category=path, how=how))
    ref = label_ref.get(label.lower()) or ref_of(label)
    if not ref:
        parent = None
        if path != 'Uncategorized':
            area, sub = path.split(' › ')
            parent = next((t for t, l in DIG_LABEL.items() if l == sub and DIG_LABEL.get(DIG_PARENT.get(t)) == area), None)
        ref = new_topic(label, 'subject', parent_id=parent)
    dig.append(ref)
personal_refs = {'slug:' + t['slug'] for t in personal_topics}
paused = [tag_ref[r] for r, t in TAGS.items() if t['exclude'] and tag_ref.get(r) and tag_ref[r] not in dig
          and tag_ref[r] not in personal_refs]

# ---------------------------------------------------------------- write parts
used_refs = {x for v in dtags.values() for x in v} | set(guide_out) | set(dig) | set(paused) | \
            {e['topic'] for e in edition_items if e['topic']}
for (a, b, _) in list(tlinks): used_refs |= {a}
payload = dict(
    personal_topics=personal_topics,
    topics=list(topics.values()),
    aliases=[dict(alias=a, ref=r) for a, r in sorted(aliases)],
    links=[dict(ref=a, related=b, relation=c) for a, b, c in sorted(tlinks)],
    sources=list(sources.values()),
    articles=list(articles.values()),
    discos=[dict(d, tags=dtags[r]) for r, d in discos.items()],
    guides=[dict(ref=ref, items=items) for ref, items in guide_out.items()],
    source_guides=[dict(source_key=k, items=[x for _, x in sorted(v)]) for k, v in src_guides.items()],
    editions=edition_items, votes=votes, prefs=prefs,
    vocab=list(progress.values()),
    dig=dict(refs=list(dict.fromkeys(dig)), answers=dig_answers), paused=list(dict.fromkeys(paused)),
)
parts, n = [], 0
def emit(kind, rows, size=350_000):
    global n
    chunk, cur = [], 2
    for row in rows if isinstance(rows, list) else [rows]:
        s = json.dumps(row, ensure_ascii=False)
        if chunk and cur + len(s) > size: flush(kind, chunk); chunk, cur = [], 2
        chunk.append(s); cur += len(s) + 1
    if chunk: flush(kind, chunk)
def flush(kind, chunk):
    global n
    body = '[' + ','.join(chunk) + ']'
    assert '$J$' not in body
    n += 1
    sql = f"insert into private.coda_staging (batch, part, kind, payload) values ('{BATCH}', {n}, '{kind}', $J${body}$J$::jsonb) on conflict (batch, part) do update set kind = excluded.kind, payload = excluded.payload, loaded_at = now();"
    open(f'{OUT}/part-{n:03d}.sql', 'w', encoding='utf-8').write(sql)
for k, v in payload.items(): emit(k, v)
summary = {k: (len(v) if isinstance(v, list) else 1) for k, v in payload.items()}
summary.update(broad_tags_dropped=len(dropped_broad), parts=n, headers=len(headers), skipped=dict(skipped),
               disco_topics=sum(len(v) for v in dtags.values()),
               guide_items=sum(len(v) for v in guide_out.values()))
json.dump(dict(batch=BATCH, parts=n, summary=summary, broad_examples=__import__('collections').Counter(ref_label.get(x, x) for _, x in dropped_broad).most_common(40)), open(f'{OUT}/manifest.json', 'w'), indent=1)
print(json.dumps(summary, indent=1))
