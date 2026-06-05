// Run the AI takeoff vision provider on a plan and print the extraction + cost.
// Proves the FREE gemini-cli/agy path works AND shows the shadow API price.
//
//   npx tsx scripts/takeoff-vision/run-vision.ts <plan.pdf|png> [gemini-cli|agy-cli|stub]
//
// Env: rides the $0 OAuth subscription (unset GEMINI_API_KEY first); GEMINI_CLI_BIN
// overrides the binary.
import { readFileSync } from 'node:fs'
import { createTakeoffVisionProvider, type TakeoffVisionMode } from '../../packages/pipe-blueprint/src/provider.js'

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'blueprints_sample/blueprints_example.pdf'
  const mode = (process.argv[3] ?? 'gemini-cli') as TakeoffVisionMode
  const bytes = readFileSync(file)
  const isPdf = file.toLowerCase().endsWith('.pdf')

  const prompt = [
    'You are a construction takeoff estimator. From this architectural plan, extract the walls, rooms, and any dimension strings you can read.',
    'Return ONLY minified JSON, no prose, no code fences:',
    '{"rooms":[{"name":string,"polygon":[{"x":number,"y":number}]}],"walls":[{"id":string,"a":{"x":number,"y":number},"b":{"x":number,"y":number}}],"dimensionStrings":[string],"notes":[string]}',
    'Coordinates in pixels. If you cannot read the plan, return empty arrays with a note explaining why.',
  ].join('\n')

  console.log(`▶ takeoff vision: ${mode} on ${file} (${(bytes.length / 1024).toFixed(0)} KB)`)
  const provider = createTakeoffVisionProvider(mode)
  const res = await provider.run({
    prompt,
    page: {
      base64: bytes.toString('base64'),
      mimeType: isPdf ? 'application/pdf' : 'image/png',
      widthPx: 1700,
      heightPx: 2200,
      fileExt: isPdf ? 'pdf' : 'png',
    },
  })

  console.log('\n=== model output (first 2500 chars) ===')
  console.log(res.text.slice(0, 2500))
  console.log('\n=== cost ===')
  console.log(JSON.stringify(res.cost, null, 2))
  console.log(
    `\n→ billed $${res.cost.billedUsd} now; this run WOULD cost ~$${res.cost.shadowApiUsd} on the metered API ` +
      `(${res.cost.model}). At 1000 takeoffs/mo that's ~$${(res.cost.shadowApiUsd * 1000).toFixed(2)}/mo.`,
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
