// Prove out the AI takeoff: run gemini-3.1-flash-lite on real CubiCasa plans and
// score the extraction against the dataset's ground-truth room annotations.
// Scale-free first metrics: room COUNT error + room-TYPE recall.
//
//   GEMINI_API_KEY=... npx tsx scripts/takeoff-vision/score-cubicasa.ts [sampleDir] [model]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createGeminiApiProvider, createCliProvider } from '../../packages/pipe-blueprint/src/provider.js'

const SAMPLE_DIR = process.argv[2] ?? '/mnt/backup/sitelayer-takeoff-corpus/sample'
const MODEL = process.argv[3] ?? 'gemini-3.1-flash-lite'
// provider: 'api' (paid, pick MODEL) or 'cli' (free gemini-cli subscription, auto-model)
const PROVIDER = (process.argv[4] ?? 'api').toLowerCase()

const PROMPT = [
  'You are a construction takeoff estimator. From this residential floor plan, list every distinct ROOM.',
  'Count ONLY enclosed, habitable rooms. Do NOT split closets, hallways, or dimension/annotation zones into separate rooms.',
  'Merge duplicates — the same room must appear at most once. If you are unsure whether something is a real room, OMIT it.',
  'Return ONLY minified JSON, no prose, no code fences:',
  '{"rooms":[{"name":string,"type":string}]}',
  'type must be one of: bedroom, bathroom, kitchen, living, dining, entry, hall, closet, utility, garage, outdoor, other.',
].join('\n')

// CubiCasa rooms: <g ... class="Space <Type>" ...><polygon points="x,y x,y ...">
function parseGtRooms(svg: string): Array<{ type: string; areaPx: number }> {
  const out: Array<{ type: string; areaPx: number }> = []
  const re = /class="Space (\w+)"[^>]*>\s*<polygon points="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    const type = (m[1] ?? '').toLowerCase()
    const pts = (m[2] ?? '')
      .trim()
      .split(/\s+/)
      .map((p) => p.split(',').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite)) as Array<[number, number]>
    let s = 0
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i]!
      const b = pts[(i + 1) % pts.length]!
      s += a[0] * b[1] - b[0] * a[1]
    }
    out.push({ type, areaPx: Math.abs(s / 2) })
  }
  return out
}

// CubiCasa room types we count as real interior rooms (exclude exterior/unknown).
const INTERIOR = new Set([
  'bedroom',
  'bath',
  'kitchen',
  'livingroom',
  'diningroom',
  'entry',
  'hall',
  'closet',
  'draughtlobby',
  'utility',
  'storage',
  'wc',
  'sauna',
])
// map AI 'type' → a coarse bucket comparable to CubiCasa types
const AI_TO_BUCKET: Record<string, string> = {
  bedroom: 'bedroom',
  bathroom: 'bath',
  kitchen: 'kitchen',
  living: 'livingroom',
  dining: 'diningroom',
  entry: 'entry',
  hall: 'hall',
  closet: 'closet',
  utility: 'utility',
  other: 'other',
}
function gtBucket(t: string): string {
  if (t === 'bath') return 'bath'
  if (t === 'livingroom') return 'livingroom'
  if (t === 'diningroom') return 'diningroom'
  if (t === 'draughtlobby') return 'entry'
  return t
}

async function main(): Promise<void> {
  const ids = readdirSync(SAMPLE_DIR).filter((d) => existsSync(path.join(SAMPLE_DIR, d, 'model.svg')))
  const provider =
    PROVIDER === 'cli' ? createCliProvider({ id: 'gemini-cli' }) : createGeminiApiProvider({ model: MODEL })
  const label = PROVIDER === 'cli' ? 'gemini-cli ($0 subscription)' : `${MODEL} (paid api)`
  console.log(`▶ scoring ${label} on ${ids.length} CubiCasa plans (room count + type recall)\n`)
  const rows: Array<{ id: string; gtN: number; aiN: number; recall: number; ms: number }> = []
  for (const id of ids) {
    const dir = path.join(SAMPLE_DIR, id)
    const svg = readFileSync(path.join(dir, 'model.svg'), 'utf8')
    const gtRooms = parseGtRooms(svg).filter((r) => INTERIOR.has(r.type))
    const gtBuckets = gtRooms.map((r) => gtBucket(r.type))
    const png = readFileSync(path.join(dir, 'F1_scaled.png'))
    const t0 = Date.now()
    // no initializer: the try always assigns it, and the catch always `continue`s,
    // so it's definitely assigned by the time it's read (eslint no-useless-assignment).
    let aiRooms: Array<{ name?: string; type?: string }>
    try {
      const res = await provider.run({
        prompt: PROMPT,
        page: { base64: png.toString('base64'), mimeType: 'image/png', widthPx: 0, heightPx: 0, fileExt: 'png' },
      })
      const j = JSON.parse(
        res.text
          .replace(/^```json\s*/i, '')
          .replace(/```$/i, '')
          .trim(),
      )
      aiRooms = Array.isArray(j.rooms) ? j.rooms : []
    } catch (e) {
      console.log(`✗ ${id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`)
      continue
    }
    const ms = Date.now() - t0
    // type recall: fraction of GT room buckets matched by some AI room (multiset-ish, greedy)
    const aiBuckets = aiRooms.map((r) => AI_TO_BUCKET[(r.type ?? '').toLowerCase()] ?? 'other')
    const pool = [...aiBuckets]
    let matched = 0
    for (const g of gtBuckets) {
      const i = pool.indexOf(g)
      if (i >= 0) {
        matched += 1
        pool.splice(i, 1)
      }
    }
    const recall = gtBuckets.length ? matched / gtBuckets.length : 0
    rows.push({ id, gtN: gtRooms.length, aiN: aiRooms.length, recall, ms })
    console.log(
      `${id.padEnd(6)} GT rooms=${String(gtRooms.length).padStart(2)} [${gtBuckets.join(',')}]  AI rooms=${String(aiRooms.length).padStart(2)} [${aiBuckets.join(',')}]  type-recall=${(recall * 100).toFixed(0)}%  ${ms}ms`,
    )
  }
  if (rows.length) {
    const meanCountErr = rows.reduce((s, r) => s + Math.abs(r.aiN - r.gtN), 0) / rows.length
    const meanRecall = rows.reduce((s, r) => s + r.recall, 0) / rows.length
    console.log('\n=== accuracy (first pass, scale-free) ===')
    console.log(`plans scored:        ${rows.length}`)
    console.log(`mean |room-count err|: ${meanCountErr.toFixed(2)} rooms`)
    console.log(`mean room-type recall: ${(meanRecall * 100).toFixed(0)}%`)
    console.log(
      '\nNOTE: room count + type recall only — absolute area/length accuracy needs the px→meter scale parse (next).',
    )
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
