import { expect, test, type Page, type Route } from '@playwright/test'
import { PNG } from 'pngjs'

const PROJECT_ID = '00000000-0000-4000-8000-000000000301'
const BLUEPRINT_ID = '00000000-0000-4000-8000-000000000302'
const PAGE_ID = '00000000-0000-4000-8000-000000000303'
const DRAFT_ID = '00000000-0000-4000-8000-000000000304'

test('renders a nonblank WebGL 3D takeoff preview from mocked measurements', async ({ page }) => {
  const mockState = { sawDraftScopedMeasurements: false, sawAuthenticatedPageFileFetch: false }
  await installApiMocks(page, mockState)
  await page.addInitScript(() => {
    window.localStorage.setItem('sitelayer.act-as', 'e2e-admin')
    window.localStorage.setItem('sitelayer.active-company-slug', 'e2e-fixtures')
  })

  await page.goto(`/projects/${PROJECT_ID}/takeoff-preview?blueprint=${BLUEPRINT_ID}&draft=${DRAFT_ID}`)

  await expect(page.getByRole('heading', { name: '3D takeoff view' })).toBeVisible()
  await expect(page.getByText('4', { exact: true })).toBeVisible()
  await expect(page.getByText('drawable measurements')).toBeVisible()
  await expect(page.getByText(/Scale:\s+0\.500 ft \/ board unit/)).toBeVisible()
  await expect(page.getByTestId('takeoff-preview-source-sheet-status')).toContainText('image underlay')
  await expect.poll(() => mockState.sawDraftScopedMeasurements).toBe(true)
  await expect.poll(() => mockState.sawAuthenticatedPageFileFetch).toBe(true)

  const canvas = page.getByTestId('takeoff-preview-canvas')
  await expect(canvas).toBeVisible()
  await expect
    .poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width * (node as HTMLCanvasElement).height))
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: /09 29 00/ }).click()
  await expect(page.getByText('Selected', { exact: true })).toBeVisible()
  await expect(page.getByText('240.00 sqft')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open measurement' })).toHaveAttribute(
    'href',
    `/projects/${PROJECT_ID}/takeoff/measure-1`,
  )

  const png = PNG.sync.read(await canvas.screenshot())
  expectImageHasSignal(png)
})

test('renders the public demo fixture switcher and export payload', async ({ page }) => {
  await page.goto('/demo/takeoff-preview-3d')

  await expect(page.getByRole('heading', { name: '3D takeoff demo' })).toBeVisible()
  await expect(page.getByText('Simple house plan', { exact: true }).first()).toBeVisible()

  await page.getByTestId('takeoff-demo-fixture-floor-plan').click()
  await expect(page).toHaveURL(/fixture=floor-plan/)
  await expect(page.getByText('Blueprint-style floor plan', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('7', { exact: true })).toBeVisible()
  await expect(page.getByText('drawable measurements')).toBeVisible()

  await page.getByText('Scene JSON').click()
  await expect(page.getByTestId('takeoff-demo-debug-json')).toContainText('"id": "floor-plan"')
  await expect(page.getByTestId('takeoff-demo-debug-json')).toContainText('"service_item_code": "08 50 00"')

  const canvas = page.getByTestId('takeoff-preview-canvas')
  await expect(canvas).toBeVisible()
  await expect
    .poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width * (node as HTMLCanvasElement).height))
    .toBeGreaterThan(0)

  const png = PNG.sync.read(await canvas.screenshot())
  expectImageHasSignal(png)
})

async function installApiMocks(
  page: Page,
  state: { sawDraftScopedMeasurements: boolean; sawAuthenticatedPageFileFetch: boolean },
): Promise<void> {
  await page.route('http://localhost:3001/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === '/api/features') {
      await fulfillJson(route, { tier: 'local', flags: ['read-prod-ro'], ribbon: null })
      return
    }

    if (path === '/api/session') {
      await fulfillJson(route, { activeCompany: { role: 'admin' } })
      return
    }

    if (path === `/api/projects/${PROJECT_ID}/blueprints`) {
      await fulfillJson(route, {
        blueprints: [
          {
            id: BLUEPRINT_ID,
            project_id: PROJECT_ID,
            file_name: 'Public-domain house plan fixture.png',
            storage_path: 'fixtures/public-domain-house-plan.png',
            preview_type: 'image',
            calibration_length: null,
            calibration_unit: null,
            sheet_scale: null,
            version: 1,
            deleted_at: null,
            replaces_blueprint_document_id: null,
            created_at: '2026-05-20T00:00:00.000Z',
          },
        ],
      })
      return
    }

    if (path === `/api/blueprints/${BLUEPRINT_ID}/pages`) {
      await fulfillJson(route, {
        pages: [
          {
            id: PAGE_ID,
            blueprint_document_id: BLUEPRINT_ID,
            page_number: 1,
            storage_path: 'fixtures/public-domain-house-plan-page-1.png',
            calibration_world_distance: '20',
            calibration_world_unit: 'ft',
            calibration_x1: '10',
            calibration_y1: '10',
            calibration_x2: '50',
            calibration_y2: '10',
            calibration_set_at: '2026-05-20T00:00:00.000Z',
            measurement_count: 4,
          },
        ],
      })
      return
    }

    if (path === `/api/blueprint-pages/${PAGE_ID}/file`) {
      expect(route.request().headers()['x-sitelayer-company-slug']).toBe('e2e-fixtures')
      expect(route.request().headers()['x-sitelayer-act-as']).toBe('e2e-admin')
      state.sawAuthenticatedPageFileFetch = true
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: {
          'access-control-allow-origin': 'http://localhost:3100',
        },
        body: blueprintPngFixture(),
      })
      return
    }

    if (path === `/api/projects/${PROJECT_ID}/takeoff-drafts`) {
      await fulfillJson(route, {
        drafts: [
          {
            id: DRAFT_ID,
            company_id: 'company-e2e',
            project_id: PROJECT_ID,
            name: '3D smoke draft',
            type: 'measurement',
            status: 'active',
            version: 1,
            source: 'manual',
            review_required: false,
            pipeline_version: null,
            deleted_at: null,
            created_at: '2026-05-20T00:00:00.000Z',
            updated_at: '2026-05-20T00:00:00.000Z',
          },
        ],
      })
      return
    }

    if (path === `/api/projects/${PROJECT_ID}/takeoff/measurements`) {
      const draftId = url.searchParams.get('draft_id')
      if (draftId !== null) expect(draftId).toBe(DRAFT_ID)
      if (draftId === DRAFT_ID) state.sawDraftScopedMeasurements = true
      await fulfillJson(route, { measurements: measurementsFixture })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `unmocked takeoff preview smoke API path: ${path}` }),
    })
  })
}

function blueprintPngFixture(): Buffer {
  const png = new PNG({ width: 96, height: 96 })
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const idx = (png.width * y + x) * 4
      const grid = x % 12 === 0 || y % 12 === 0
      const room = x > 18 && x < 78 && y > 16 && y < 74
      png.data[idx] = grid ? 190 : room ? 224 : 248
      png.data[idx + 1] = grid ? 204 : room ? 236 : 250
      png.data[idx + 2] = grid ? 224 : room ? 255 : 252
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

const measurementsFixture = [
  {
    id: 'measure-1',
    project_id: PROJECT_ID,
    blueprint_document_id: BLUEPRINT_ID,
    page_id: PAGE_ID,
    service_item_code: '09 29 00',
    quantity: '240.00',
    unit: 'sqft',
    notes: 'south wall area',
    elevation: 'south',
    image_thumbnail: null,
    geometry: {
      kind: 'polygon',
      points: [
        { x: 22, y: 22 },
        { x: 70, y: 22 },
        { x: 70, y: 38 },
        { x: 22, y: 38 },
      ],
    },
    version: 1,
    created_at: '2026-05-20T00:00:00.000Z',
  },
  {
    id: 'measure-2',
    project_id: PROJECT_ID,
    blueprint_document_id: BLUEPRINT_ID,
    page_id: PAGE_ID,
    service_item_code: '07 21 00',
    quantity: '52.00',
    unit: 'lf',
    notes: null,
    elevation: 'east',
    image_thumbnail: null,
    geometry: {
      kind: 'lineal',
      points: [
        { x: 18, y: 70 },
        { x: 42, y: 76 },
        { x: 66, y: 72 },
      ],
    },
    version: 1,
    created_at: '2026-05-20T00:01:00.000Z',
  },
  {
    id: 'measure-3',
    project_id: PROJECT_ID,
    blueprint_document_id: BLUEPRINT_ID,
    page_id: PAGE_ID,
    service_item_code: '08 50 00',
    quantity: '3.00',
    unit: 'ea',
    notes: null,
    elevation: 'north',
    image_thumbnail: null,
    geometry: {
      kind: 'count',
      points: [
        { x: 30, y: 48 },
        { x: 52, y: 48 },
        { x: 74, y: 48 },
      ],
    },
    version: 1,
    created_at: '2026-05-20T00:02:00.000Z',
  },
  {
    id: 'measure-4',
    project_id: PROJECT_ID,
    blueprint_document_id: BLUEPRINT_ID,
    page_id: PAGE_ID,
    service_item_code: '03 30 00',
    quantity: '18.00',
    unit: 'cy',
    notes: null,
    elevation: null,
    image_thumbnail: null,
    geometry: { kind: 'volume', length: 8, width: 6, height: 4 },
    version: 1,
    created_at: '2026-05-20T00:03:00.000Z',
  },
] as const

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': 'http://localhost:3100',
    },
    body: JSON.stringify(body),
  })
}

function expectImageHasSignal(png: PNG): void {
  let nonBackground = 0
  const unique = new Set<string>()
  let minLuma = 255
  let maxLuma = 0

  for (let index = 0; index < png.data.length; index += 4 * 17) {
    const r = png.data[index] ?? 0
    const g = png.data[index + 1] ?? 0
    const b = png.data[index + 2] ?? 0
    const a = png.data[index + 3] ?? 0
    const backgroundDistance = Math.abs(r - 13) + Math.abs(g - 17) + Math.abs(b - 23)
    if (a > 0 && backgroundDistance > 18) nonBackground += 1
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    minLuma = Math.min(minLuma, luma)
    maxLuma = Math.max(maxLuma, luma)
    unique.add(`${r},${g},${b},${a}`)
  }

  expect(nonBackground).toBeGreaterThan(100)
  expect(unique.size).toBeGreaterThan(8)
  expect(maxLuma - minLuma).toBeGreaterThan(12)
}
