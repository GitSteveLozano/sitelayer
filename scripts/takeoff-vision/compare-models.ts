// Bang-for-buck: run the AI takeoff across EVERY Gemini model on one plan and
// rank by real cost (from usageMetadata) + quality (rooms/walls/dims extracted)
// + latency. This calls the PAID Gemini API (a few cents total).
//
//   GEMINI_API_KEY=... npx tsx scripts/takeoff-vision/compare-models.ts [plan.pdf|png]
import { readFileSync } from 'node:fs'
import { createGeminiApiProvider } from '../../packages/pipe-blueprint/src/provider.js'
import { GEMINI_MODELS, estimateTakeoffCost } from '../../packages/pipe-blueprint/src/cost.js'

const PROMPT = [
  'You are a construction takeoff estimator. From this architectural plan, extract the walls, rooms, and any dimension strings you can read.',
  'Return ONLY minified JSON, no prose, no code fences:',
  '{"rooms":[{"name":string,"polygon":[{"x":number,"y":number}]}],"walls":[{"id":string,"a":{"x":number,"y":number},"b":{"x":number,"y":number}}],"dimensionStrings":[string],"notes":[string]}',
  'Coordinates in pixels. If you cannot read the plan, return empty arrays with a note explaining why.',
].join('\n')

function quality(text: string): { valid: boolean; rooms: number; walls: number; dims: number } {
  try {
    const j = JSON.parse(
      text
        .replace(/^```json\s*/i, '')
        .replace(/```$/i, '')
        .trim(),
    ) as Record<string, unknown[]>
    return {
      valid: true,
      rooms: (j.rooms ?? []).length,
      walls: (j.walls ?? []).length,
      dims: (j.dimensionStrings ?? []).length,
    }
  } catch {
    return { valid: false, rooms: 0, walls: 0, dims: 0 }
  }
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'blueprints_sample/blueprints_example.pdf'
  const bytes = readFileSync(file)
  const isPdf = file.toLowerCase().endsWith('.pdf')
  const page = {
    base64: bytes.toString('base64'),
    mimeType: isPdf ? 'application/pdf' : 'image/png',
    widthPx: 1700,
    heightPx: 2200,
    fileExt: isPdf ? 'pdf' : 'png',
  }
  console.log(`▶ comparing ${GEMINI_MODELS.length} Gemini models on ${file} (${(bytes.length / 1024).toFixed(0)} KB)\n`)

  type Row = {
    model: string
    ok: boolean
    ms: number
    usd: number
    batchUsd: number
    inTok: number
    outTok: number
    rooms: number
    walls: number
    dims: number
    valid: boolean
    error?: string
  }
  const rows: Row[] = []
  for (const model of GEMINI_MODELS) {
    const t0 = Date.now()
    try {
      const res = await createGeminiApiProvider({ model }).run({ prompt: PROMPT, page })
      const ms = Date.now() - t0
      const q = quality(res.text)
      const batch = estimateTakeoffCost({
        provider: 'gemini-api',
        model,
        pages: [],
        promptTokens: res.cost.inputTokens,
        outputTokens: res.cost.outputTokens,
        tier: 'batch',
      })
      rows.push({
        model,
        ok: true,
        ms,
        usd: res.cost.billedUsd,
        batchUsd: batch.billedUsd,
        inTok: res.cost.inputTokens,
        outTok: res.cost.outputTokens,
        ...q,
      })
      console.log(
        `✓ ${model.padEnd(24)} $${res.cost.billedUsd.toFixed(5)} (batch $${batch.billedUsd.toFixed(5)})  ${String(ms).padStart(6)}ms  in=${res.cost.inputTokens} out=${res.cost.outputTokens}  rooms=${q.rooms} walls=${q.walls} dims=${q.dims} valid=${q.valid}`,
      )
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 90)
      rows.push({
        model,
        ok: false,
        ms: Date.now() - t0,
        usd: 0,
        batchUsd: 0,
        inTok: 0,
        outTok: 0,
        rooms: 0,
        walls: 0,
        dims: 0,
        valid: false,
        error: msg,
      })
      console.log(`✗ ${model.padEnd(24)} ERROR: ${msg}`)
    }
  }

  const valid = rows.filter((r) => r.ok && r.valid)
  console.log('\n=== bang-for-buck (valid output, cheapest Standard first) ===')
  for (const [i, r] of valid.sort((a, b) => a.usd - b.usd).entries()) {
    console.log(
      `${i + 1}. ${r.model.padEnd(24)} $${r.usd.toFixed(5)}/takeoff (batch $${r.batchUsd.toFixed(5)}) → 1000/mo $${(r.usd * 1000).toFixed(2)} (batch $${(r.batchUsd * 1000).toFixed(2)})  | rooms=${r.rooms} walls=${r.walls} dims=${r.dims} ${r.ms}ms`,
    )
  }
  const totalSpent = rows.reduce((s, r) => s + r.usd, 0)
  console.log(`\nThis comparison spent ~$${totalSpent.toFixed(4)} total across ${rows.length} models.`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
