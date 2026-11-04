// Offline English dictionary: Princeton WordNet 3.0 (meanings, examples,
// synonyms) and CMUdict (pronunciation). Nothing leaves the device, and the
// words you look up are not sent anywhere.
//
// Data is split into small files under dict/ and loaded on first use:
//   w/<letter>.json   word -> synset ids, most common sense first
//   s/<n>.json        definitions, 2000 per file
//   p/<letter>.json   word -> IPA
//   exc.json          irregular forms ("ran" -> "run")

const POS = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' }
const CHUNK = 2000

const files = new Map() // url -> Promise<json | null>
function load(url) {
  if (!files.has(url)) {
    files.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null))
  }
  return files.get(url)
}

const shardKey = w => (/^[a-z]/.test(w) ? w[0] : '_')
const own = (obj, key) => !!obj && Object.hasOwn(obj, key)

async function lemmaIds(word) {
  const shard = await load(`dict/w/${shardKey(word)}.json`)
  return own(shard, word) ? shard[word] : null
}

// ---- finding the base form (WordNet's "morphy")

const RULES = {
  n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y'], ['ings', ''], ['ings', 'e']],
  v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
  a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e']],
}

async function candidates(word) {
  const exc = (await load('dict/exc.json')) ?? {}
  const out = []
  const push = w => { if (w && w !== word && !out.includes(w)) out.push(w) }
  for (const pos of ['n', 'v', 'a', 'r']) if (own(exc[pos], word)) push(exc[pos][word])
  for (const rules of Object.values(RULES)) {
    for (const [suffix, end] of rules) {
      if (word.length > suffix.length + 1 && word.endsWith(suffix)) push(word.slice(0, -suffix.length) + end)
    }
  }
  // running -> runn -> run, stopped -> stopp -> stop
  for (const base of [...out, word]) {
    const m = /^(.*?)([^aeiou])\2$/.exec(base)
    if (m) push(m[1] + m[2])
  }
  // "-ied" and "-ier" forms (carried -> carry, happier -> happy)
  if (/ied$/.test(word)) push(word.slice(0, -3) + 'y')
  if (/ier$|iest$/.test(word)) push(word.replace(/ie(r|st)$/, 'y'))
  return out
}

// ---- cleaning what the reader selected

export function cleanWord(raw) {
  let w = String(raw ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') // quotes, dashes, punctuation at the ends
  w = w.replace(/'s$/i, '').replace(/s'$/i, 's')
  return w.toLowerCase()
}

// A selection counts as a lookup when it is one to three words of letters.
export function lookupable(raw) {
  const w = cleanWord(raw)
  if (!w || w.length > 40) return null
  const words = w.split(' ')
  if (words.length > 3) return null
  if (!words.every(x => /^\p{L}[\p{L}'-]*$/u.test(x))) return null
  return w
}

// ---- main entry

async function entryFor(lemma) {
  const ids = await lemmaIds(lemma)
  if (!ids) return null
  const chunkNos = [...new Set(ids.map(i => Math.floor(i / CHUNK)))]
  const chunks = new Map(await Promise.all(chunkNos.map(async n => [n, await load(`dict/s/${n}.json`)])))
  const groups = []
  for (const id of ids) {
    const row = chunks.get(Math.floor(id / CHUNK))?.[id % CHUNK]
    if (!row) continue
    const [pos, definition, examples, synonyms] = row
    let g = groups.find(x => x.pos === pos)
    if (!g) groups.push(g = { pos, label: POS[pos] ?? pos, senses: [] })
    g.senses.push({ definition, examples, synonyms: synonyms.filter(s => s.toLowerCase() !== lemma) })
  }
  return groups.length ? groups : null
}

const ARCHAIC = new Set(['thou', 'thee', 'thy', 'thine', 'hath', 'doth'])
// contraction -> [word to look up, what it is short for]
const CONTRACTIONS = Object.assign(Object.create(null), Object.fromEntries(Object.entries({
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not', "can't": 'cannot', "won't": 'will not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not', "hasn't": 'has not',
  "haven't": 'have not', "hadn't": 'had not', "couldn't": 'could not', "wouldn't": 'would not',
  "shouldn't": 'should not', "mustn't": 'must not', "ain't": 'am not',
}).map(([k, v]) => [k, [v.split(' ')[0] === 'cannot' ? 'can' : v.split(' ')[0], v]])))

// dict/fn.json: word -> [[kind, meaning, example], ...]
async function functionWord(word) {
  const list = await load('dict/fn.json')
  if (!own(list, word)) return null
  const groups = []
  for (const [label, definition, example] of list[word]) {
    let g = groups.find(x => x.label === label)
    if (!g) groups.push(g = { pos: label, label, senses: [] })
    g.senses.push({ definition, examples: example ? [example] : [], synonyms: [] })
  }
  return groups
}

export async function lookup(raw) {
  const word = lookupable(raw)
  if (!word) return null

  // "don't" is a short form: show the word it stands for.
  if (own(CONTRACTIONS, word)) {
    const [stem, whole] = CONTRACTIONS[word]
    const groups = await functionWord(stem)
    if (groups) return { word, lemma: stem, found: true, inflected: true, short: `Short for “${whole}”`, ipa: null, groups, also: [] }
  }

  // Old pronouns that WordNet knows only as something else ("thou" = 1000).
  let exact = ARCHAIC.has(word) ? await functionWord(word) : await entryFor(word)
  // WordNet leaves out small function words (the, of, how, his...), so a short
  // built-in list covers them. It comes before the suffix rules ("his" is not "hi").
  let builtin = ARCHAIC.has(word) && !!exact
  if (!exact && !word.includes(' ')) {
    exact = await functionWord(word)
    builtin = !!exact
  }
  let lemma = word
  let groups = exact
  const also = []

  if (!word.includes(' ') && !builtin) {
    for (const c of await candidates(word)) {
      const g = await entryFor(c)
      if (!g) continue
      if (!exact) {
        if (!groups) { lemma = c; groups = g } // first match becomes the entry
        else if (also.length < 1) also.push({ lemma: c, groups: g })
      } else if (also.length < 1 && c.length >= 3 && /(ing|ed)$/.test(word) && g.some(x => x.pos === 'v')) {
        // "running" is a word of its own, and also a form of "run".
        also.push({ lemma: c, groups: g.filter(x => x.pos === 'v') })
      }
    }
  }
  // Words with hyphens: try the parts joined or spaced.
  if (!groups && word.includes('-')) {
    for (const c of [word.replace(/-/g, ''), word.replace(/-/g, ' ')]) {
      const g = await entryFor(c)
      if (g) { lemma = c; groups = g; break }
    }
  }
  if (!groups) return { word, found: false }

  return {
    word, lemma, found: true,
    inflected: lemma !== word,
    ipa: await pronunciation(word, lemma),
    groups,
    also,
  }
}

async function pronunciation(word, lemma) {
  if (word.includes(' ')) return null
  for (const w of [word, lemma]) {
    const shard = await load(`dict/p/${shardKey(w)}.json`)
    if (own(shard, w)) return shard[w]
  }
  return null
}

// ---- speaking

let voice = null
export function canSpeak() { return 'speechSynthesis' in window }

export function speak(text) {
  if (!canSpeak()) return false
  try {
    const synth = window.speechSynthesis
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    voice ??= synth.getVoices().find(v => /^en[-_](US|GB)/i.test(v.lang)) ?? null
    if (voice) u.voice = voice
    u.rate = 0.9
    synth.speak(u)
    return true
  } catch {
    return false
  }
}
