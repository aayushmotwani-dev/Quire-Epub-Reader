// Dev-only. Builds the offline dictionary in www/dict from Princeton WordNet 3.0
// (definitions, examples, synonyms) and CMUdict (pronunciation).
// Usage: node tools/build-dict.mjs <wordnet-dir> <cmu-pronouncing-dictionary-dir>
import fs from 'node:fs'
import path from 'node:path'

const [wnDir, cmuDir] = process.argv.slice(2)
if (!wnDir || !cmuDir) { console.error('usage: node tools/build-dict.mjs <wordnet-dir> <cmu-dir>'); process.exit(1) }
const OUT = path.join(import.meta.dirname, '..', 'www', 'dict')
fs.rmSync(OUT, { recursive: true, force: true })
for (const d of ['w', 'p', 's']) fs.mkdirSync(path.join(OUT, d), { recursive: true })

const FILES = [['n', 'noun'], ['v', 'verb'], ['a', 'adj'], ['r', 'adv']]
const ids = new Map()        // "n:00001740" -> global id
const synsets = []           // id -> [pos, definition, examples, synonyms]

for (const [pos, name] of FILES) {
  const lines = fs.readFileSync(path.join(wnDir, `data.${name}`), 'utf8').split('\n')
  for (const line of lines) {
    if (!line || line.startsWith('  ')) continue
    const bar = line.indexOf('|')
    const head = line.slice(0, bar).trim().split(' ')
    const gloss = line.slice(bar + 1).trim()
    const offset = head[0]
    const wCnt = parseInt(head[3], 16)
    const words = []
    for (let i = 0; i < wCnt; i++) words.push(head[4 + i * 2].replace(/\((a|p|ip)\)$/i, '').replace(/_/g, ' '))
    // gloss: definition; "example"; "example"
    const parts = gloss.split(/;\s+(?=")/)
    const definition = parts[0].replace(/\s+/g, ' ').trim()
    const examples = parts.slice(1).map(s => s.replace(/^"|"$/g, '').trim()).filter(Boolean).slice(0, 2)
    ids.set(`${pos}:${offset}`, synsets.length)
    synsets.push([pos, definition, examples, [...new Set(words)]])
  }
}
console.log('synsets', synsets.length)

// Lemma -> synset ids. Within a part of speech WordNet orders senses by how
// common they are; across parts of speech we order by the tagged-sense count.
const byLemma = new Map()
let lemmaCount = 0
for (const [pos, name] of FILES) {
  const lines = fs.readFileSync(path.join(wnDir, `index.${name}`), 'utf8').split('\n')
  for (const line of lines) {
    if (!line || line.startsWith('  ')) continue
    const f = line.trim().split(' ')
    const lemma = f[0].replace(/_/g, ' ')
    const synCnt = parseInt(f[2], 10)
    const tagged = parseInt(f[f.length - synCnt - 1], 10) || 0
    const offs = f.slice(f.length - synCnt)
    const list = offs.map(o => ids.get(`${pos}:${o}`)).filter(n => n != null)
    if (!byLemma.has(lemma)) byLemma.set(lemma, [])
    byLemma.get(lemma).push({ tagged, list })
    lemmaCount++
  }
}
const shards = {}
for (const [lemma, groups] of byLemma) {
  groups.sort((a, b) => b.tagged - a.tagged)
  const key = /^[a-z]/.test(lemma) ? lemma[0] : '_'
  ;(shards[key] ??= Object.create(null))[lemma] = groups.flatMap(g => g.list)
}
for (const [k, v] of Object.entries(shards)) fs.writeFileSync(path.join(OUT, 'w', `${k}.json`), JSON.stringify(v))
console.log('lemmas', lemmaCount)

// Definitions in chunks of 2000, loaded on demand.
const CHUNK = 2000
for (let i = 0; i * CHUNK < synsets.length; i++)
  fs.writeFileSync(path.join(OUT, 's', `${i}.json`), JSON.stringify(synsets.slice(i * CHUNK, (i + 1) * CHUNK)))

// Irregular forms ("ran" -> "run").
const exc = {}
for (const [pos, name] of [['n', 'noun'], ['v', 'verb'], ['a', 'adj'], ['r', 'adv']]) {
  const m = Object.create(null)
  for (const line of fs.readFileSync(path.join(wnDir, `${name}.exc`), 'utf8').split('\n')) {
    const [form, ...base] = line.trim().split(' ')
    if (form && base.length) m[form.replace(/_/g, ' ')] = base[0].replace(/_/g, ' ')
  }
  exc[pos] = m
}
fs.writeFileSync(path.join(OUT, 'exc.json'), JSON.stringify(exc))

// ---- pronunciation: ARPAbet -> IPA with a simple syllable-onset heuristic
const IPA = { AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h', IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'r', S: 's', SH: 'ʃ', T: 't', TH: 'θ', UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ' }
const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'])
const STOPS = new Set(['p', 'b', 't', 'd', 'k', 'ɡ', 'f', 'θ'])
const LIQ = new Set(['l', 'r', 'w', 'j'])

function toIPA(arpa) {
  const toks = []
  for (const t of arpa.split(' ')) {
    const m = /^([A-Z]+)([012])?$/.exec(t)
    if (!m || !IPA[m[1]]) return null // annotation or unknown symbol
    toks.push({ p: m[1], stress: m[2] ?? null })
  }
  if (!toks.length) return null
  const syl = toks.map(t => {
    if (!VOWELS.has(t.p)) return { c: true, s: IPA[t.p] }
    let s = IPA[t.p]
    if (t.p === 'AH' && t.stress === '0') s = 'ə'
    if (t.p === 'ER' && t.stress === '0') s = 'ɚ'
    return { c: false, s, stress: t.stress }
  })
  // where each vowel's onset begins
  const marks = new Map() // index -> mark
  let prevVowel = -1
  for (let i = 0; i < syl.length; i++) {
    if (syl[i].c) continue
    if (syl[i].stress === '1' || syl[i].stress === '2') {
      let runStart = prevVowel + 1
      let onset = i
      if (prevVowel < 0) onset = runStart
      else {
        const run = syl.slice(runStart, i).map(x => x.s)
        const n = run.length
        let take = Math.min(1, n)
        if (n >= 2) {
          const a = run[n - 2], b = run[n - 1]
          if ((STOPS.has(a) && LIQ.has(b)) || (a === 's' && ['p', 't', 'k', 'm', 'n', 'l', 'w'].includes(b))) take = 2
          if (take === 2 && n >= 3 && run[n - 3] === 's' && ['p', 't', 'k'].includes(a) && LIQ.has(b)) take = 3
        }
        onset = i - take
      }
      marks.set(onset, syl[i].stress === '1' ? 'ˈ' : 'ˌ')
    }
    prevVowel = i
  }
  return syl.map((x, i) => (marks.get(i) ?? '') + x.s).join('')
}

const cmu = (await import(path.resolve(cmuDir, 'index.js'))).dictionary
const pshards = {}
let pc = 0
for (const [w, arpa] of Object.entries(cmu)) {
  if (!/^[a-z][a-z'-]*$/.test(w)) continue
  const first = arpa.split(' | ')[0] // first listed variant
  const key = w[0]
  const ipa = toIPA(first)
  if (!ipa) continue
  ;(pshards[key] ??= Object.create(null))[w] = ipa
  pc++
}
for (const [k, v] of Object.entries(pshards)) fs.writeFileSync(path.join(OUT, 'p', `${k}.json`), JSON.stringify(v))
console.log('pronunciations', pc)
console.log('sample', toIPA('W AO1 T ER0'), toIPA('AH0 B AE1 N D AH0 N'), toIPA('K AH0 N T EY1 N'))
