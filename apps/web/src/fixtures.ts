import type {
  AuditEventsResponse,
  BootstrapResponse,
  BlueprintRow,
  CompaniesResponse,
  FeaturesResponse,
  ListRentalsResponse,
  MaterialBillRow,
  MeasurementRow,
  ProjectSummary,
  QboConnectionResponse,
  RentalRow,
  ScheduleRow,
  SessionResponse,
  SyncStatusResponse,
} from './api.js'

const company = {
  id: 'company-fixture-la',
  name: 'LA Operations Fixtures',
  slug: 'la-operations',
}

const projects: BootstrapResponse['projects'] = [
  {
    id: 'project-hillcrest',
    customer_id: 'customer-1',
    name: 'Hillcrest Homes - Phase 4',
    customer_name: 'Hillcrest Homes',
    division_code: 'D4',
    status: 'active',
    bid_total: '184250.00',
    labor_rate: '38.00',
    target_sqft_per_hr: '145.00',
    bonus_pool: '4500.00',
    closed_at: null,
    summary_locked_at: null,
    version: 7,
    created_at: '2026-04-20T14:00:00.000Z',
    updated_at: '2026-04-23T17:30:00.000Z',
  },
  {
    id: 'project-riverbend',
    customer_id: 'customer-2',
    name: 'Riverbend Retail Shell',
    customer_name: 'Northline Builders',
    division_code: 'D2',
    status: 'lead',
    bid_total: '93200.00',
    labor_rate: '40.00',
    target_sqft_per_hr: '120.00',
    bonus_pool: '2500.00',
    closed_at: null,
    summary_locked_at: null,
    version: 3,
    created_at: '2026-04-18T10:15:00.000Z',
    updated_at: '2026-04-22T13:05:00.000Z',
  },
]

const workers: BootstrapResponse['workers'] = [
  {
    id: 'worker-ana',
    name: 'Ana Castillo',
    role: 'lead',
    version: 2,
    deleted_at: null,
    created_at: '2026-04-19T09:00:00.000Z',
  },
  {
    id: 'worker-marcus',
    name: 'Marcus Lee',
    role: 'crew',
    version: 1,
    deleted_at: null,
    created_at: '2026-04-19T09:00:00.000Z',
  },
]

const serviceItems: BootstrapResponse['serviceItems'] = [
  {
    code: 'EPS',
    name: 'Exterior panel system',
    category: 'measurable',
    unit: 'sqft',
    default_rate: '8.75',
    source: 'manual',
  },
  { code: 'TRIM', name: 'Trim package', category: 'measurable', unit: 'lf', default_rate: '5.20', source: 'manual' },
  {
    code: 'qbo-112',
    name: 'Sealant allowance',
    category: 'material',
    unit: 'each',
    default_rate: '95.00',
    source: 'qbo',
  },
]

const blueprints: BlueprintRow[] = [
  {
    id: 'blueprint-hillcrest-a1',
    project_id: 'project-hillcrest',
    file_name: 'Hillcrest A1 Exterior.pdf',
    storage_path: 'fixtures/hillcrest-a1.pdf',
    preview_type: 'storage_path',
    calibration_length: '100',
    calibration_unit: 'ft',
    sheet_scale: '1',
    version: 1,
    deleted_at: null,
    replaces_blueprint_document_id: null,
    file_url: '',
    created_at: '2026-04-20T15:00:00.000Z',
  },
  {
    id: 'blueprint-hillcrest-a2',
    project_id: 'project-hillcrest',
    file_name: 'Hillcrest A2 Revision.pdf',
    storage_path: 'fixtures/hillcrest-a2.pdf',
    preview_type: 'storage_path',
    calibration_length: '100',
    calibration_unit: 'ft',
    sheet_scale: '1.1',
    version: 2,
    deleted_at: null,
    replaces_blueprint_document_id: 'blueprint-hillcrest-a1',
    file_url: '',
    created_at: '2026-04-22T15:00:00.000Z',
  },
]

const measurements: MeasurementRow[] = [
  {
    id: 'measurement-east-elevation',
    project_id: 'project-hillcrest',
    blueprint_document_id: 'blueprint-hillcrest-a2',
    service_item_code: 'EPS',
    quantity: '1284.50',
    unit: 'sqft',
    notes: 'east elevation',
    geometry: {
      kind: 'polygon',
      points: [
        { x: 18, y: 22 },
        { x: 70, y: 24 },
        { x: 72, y: 55 },
        { x: 20, y: 58 },
      ],
    },
    version: 4,
    deleted_at: null,
    created_at: '2026-04-22T16:00:00.000Z',
  },
  {
    id: 'measurement-front-trim',
    project_id: 'project-hillcrest',
    blueprint_document_id: 'blueprint-hillcrest-a2',
    service_item_code: 'TRIM',
    quantity: '310.00',
    unit: 'lf',
    notes: 'front trim',
    geometry: {
      kind: 'polygon',
      points: [
        { x: 24, y: 62 },
        { x: 62, y: 62 },
        { x: 62, y: 68 },
        { x: 24, y: 68 },
      ],
    },
    version: 1,
    deleted_at: null,
    created_at: '2026-04-22T16:20:00.000Z',
  },
]

const materialBills: MaterialBillRow[] = [
  {
    id: 'bill-hillcrest-1',
    project_id: 'project-hillcrest',
    vendor: 'Atlas Supply',
    amount: '12640.55',
    bill_type: 'material',
    description: 'panel order deposit',
    occurred_on: '2026-04-22',
    version: 2,
    deleted_at: null,
    created_at: '2026-04-22T18:00:00.000Z',
  },
]

const rentals: RentalRow[] = [
  {
    id: 'rental-hillcrest-scaffold-1',
    company_id: company.id,
    project_id: 'project-hillcrest',
    customer_id: 'customer-1',
    item_description: 'Scaffolding tower 6m',
    daily_rate: '35.00',
    delivered_on: '2026-04-10',
    returned_on: null,
    next_invoice_at: '2026-04-24T00:00:00.000Z',
    invoice_cadence_days: 7,
    last_invoice_amount: '245.00',
    last_invoiced_through: '2026-04-16',
    status: 'active',
    notes: null,
    version: 2,
    deleted_at: null,
    created_at: '2026-04-10T15:00:00.000Z',
    updated_at: '2026-04-17T00:00:00.000Z',
  },
  {
    id: 'rental-hillcrest-mixer-1',
    company_id: company.id,
    project_id: 'project-hillcrest',
    customer_id: 'customer-1',
    item_description: 'Cement mixer',
    daily_rate: '18.00',
    delivered_on: '2026-04-18',
    returned_on: null,
    next_invoice_at: '2026-04-25T00:00:00.000Z',
    invoice_cadence_days: 7,
    last_invoice_amount: null,
    last_invoiced_through: null,
    status: 'active',
    notes: 'Ground floor pours',
    version: 1,
    deleted_at: null,
    created_at: '2026-04-18T14:00:00.000Z',
    updated_at: '2026-04-18T14:00:00.000Z',
  },
]

const schedules: ScheduleRow[] = [
  {
    id: 'schedule-hillcrest-1',
    project_id: 'project-hillcrest',
    scheduled_for: '2026-04-24',
    crew: ['Ana Castillo', 'Marcus Lee'],
    status: 'draft',
    version: 1,
    deleted_at: null,
    created_at: '2026-04-23T09:00:00.000Z',
  },
]

const laborEntries: BootstrapResponse['laborEntries'] = [
  {
    id: 'labor-hillcrest-1',
    project_id: 'project-hillcrest',
    worker_id: 'worker-ana',
    service_item_code: 'EPS',
    hours: '8.00',
    sqft_done: '980.00',
    status: 'confirmed',
    occurred_on: '2026-04-23',
    version: 1,
    deleted_at: null,
    created_at: '2026-04-23T18:10:00.000Z',
  },
]

const bootstrap: BootstrapResponse = {
  company,
  template: {
    slug: 'la-template',
    name: 'LA Operations',
    description: 'Fixture data for local frontend iteration',
  },
  workflowStages: ['lead', 'takeoff', 'estimate', 'scheduled', 'in_progress', 'closeout'],
  divisions: [
    { code: 'D2', name: 'Commercial shell', sort_order: 20 },
    { code: 'D4', name: 'Exterior systems', sort_order: 40 },
  ],
  serviceItems,
  customers: [
    {
      id: 'customer-1',
      name: 'Hillcrest Homes',
      external_id: 'qbo-cust-1042',
      source: 'qbo',
      version: 2,
      deleted_at: null,
    },
    { id: 'customer-2', name: 'Northline Builders', external_id: null, source: 'manual', version: 1, deleted_at: null },
  ],
  projects,
  workers,
  pricingProfiles: [
    {
      id: 'pricing-default',
      name: 'Default LA Pricing',
      is_default: true,
      config: { template: 'la-default' },
      version: 1,
      created_at: '2026-04-18T00:00:00.000Z',
    },
  ],
  bonusRules: [
    {
      id: 'bonus-margin',
      name: 'Margin Bonus',
      config: { basis: 'margin', threshold: 0.15 },
      is_active: true,
      version: 1,
      created_at: '2026-04-18T00:00:00.000Z',
    },
  ],
  integrations: [
    {
      id: 'integration-qbo',
      provider: 'qbo',
      provider_account_id: 'realm-fixture',
      sync_cursor: '42',
      status: 'connected',
    },
  ],
  integrationMappings: [
    {
      id: 'mapping-customer-1',
      provider: 'qbo',
      entity_type: 'customer',
      local_ref: 'customer-1',
      external_id: 'qbo-cust-1042',
      label: 'Hillcrest Homes',
      status: 'active',
      notes: 'fixture mapping',
      version: 1,
      deleted_at: null,
      created_at: '2026-04-20T00:00:00.000Z',
      updated_at: '2026-04-20T00:00:00.000Z',
    },
  ],
  laborEntries,
  materialBills,
  schedules,
}

const syncStatus: SyncStatusResponse = {
  company,
  pendingOutboxCount: 1,
  pendingSyncEventCount: 2,
  latestSyncEvent: {
    created_at: '2026-04-23T18:00:00.000Z',
    entity_type: 'project',
    entity_id: 'project-hillcrest',
    direction: 'outbound',
    status: 'pending',
  },
  connections: [
    {
      id: 'integration-qbo',
      provider: 'qbo',
      provider_account_id: 'realm-fixture',
      sync_cursor: '42',
      last_synced_at: '2026-04-23T17:45:00.000Z',
      status: 'connected',
      version: 2,
      created_at: '2026-04-20T00:00:00.000Z',
    },
  ],
}

const summaries: Record<string, ProjectSummary> = {
  'project-hillcrest': {
    project: projects[0]!,
    metrics: {
      totalMeasurementQuantity: 1594.5,
      estimateTotal: 12728.38,
      laborCost: 304,
      materialCost: 12640.55,
      subCost: 0,
      totalCost: 12944.55,
      margin: { revenue: 184250, cost: 12944.55, profit: 171305.45, margin: 0.9297 },
      bonus: { eligible: true, payoutPercent: 0.12, payout: 540 },
    },
    measurements: measurements.map(({ service_item_code, quantity, unit, notes }) => ({
      service_item_code,
      quantity,
      unit,
      notes,
    })),
    estimateLines: [
      { service_item_code: 'EPS', quantity: '1284.50', unit: 'sqft', rate: '8.75', amount: '11239.38' },
      { service_item_code: 'TRIM', quantity: '310.00', unit: 'lf', rate: '4.80', amount: '1488.00' },
    ],
    laborEntries,
  },
  'project-riverbend': {
    project: projects[1]!,
    metrics: {
      totalMeasurementQuantity: 0,
      estimateTotal: 0,
      laborCost: 0,
      materialCost: 0,
      subCost: 0,
      totalCost: 0,
      margin: { revenue: 93200, cost: 0, profit: 93200, margin: 1 },
      bonus: { eligible: false, payoutPercent: 0, payout: 0 },
    },
    measurements: [],
    estimateLines: [],
    laborEntries: [],
  },
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function projectIdFromPath(path: string) {
  return path.match(/^\/api\/projects\/([^/]+)/)?.[1] ?? ''
}

export function getFixtureResponse<T>(path: string, companySlug: string): T {
  if (path === '/api/features') {
    return clone({
      tier: 'local',
      flags: ['fixtures'],
      ribbon: { label: 'Local fixtures', tone: 'info' },
    } satisfies FeaturesResponse) as T
  }

  if (path === '/api/session') {
    return clone({
      user: { id: 'demo-user', role: 'owner' },
      activeCompany: { ...company, slug: companySlug },
      memberships: [
        {
          id: 'membership-fixture',
          company_id: company.id,
          clerk_user_id: 'demo-user',
          role: 'owner',
          created_at: '2026-04-18T00:00:00.000Z',
          slug: companySlug,
          name: company.name,
        },
      ],
    } satisfies SessionResponse) as T
  }

  if (path === '/api/bootstrap') {
    return clone({ ...bootstrap, company: { ...company, slug: companySlug } }) as T
  }

  if (path === '/api/companies') {
    return clone({
      companies: [
        {
          id: company.id,
          slug: companySlug,
          name: company.name,
          created_at: '2026-04-18T00:00:00.000Z',
          role: 'admin',
        },
      ],
    } satisfies CompaniesResponse) as T
  }

  if (path === '/api/sync/status') {
    return clone({ ...syncStatus, company: { ...company, slug: companySlug } }) as T
  }

  if (path === '/api/integrations/qbo') {
    return clone({
      connection: syncStatus.connections[0] ?? null,
      status: syncStatus,
    } satisfies QboConnectionResponse) as T
  }

  if (path === '/api/analytics') {
    return clone({
      projects: Object.values(summaries).map((summary) => ({
        project: summary.project,
        metrics: {
          totalHours: summary.laborEntries.reduce((sum, entry) => sum + Number(entry.hours), 0),
          totalSqft: summary.laborEntries.reduce((sum, entry) => sum + Number(entry.sqft_done), 0),
          laborCost: summary.metrics.laborCost,
          materialCost: summary.metrics.materialCost,
          subCost: summary.metrics.subCost,
          totalCost: summary.metrics.totalCost,
          revenue: Number(summary.project.bid_total),
          profit: summary.metrics.margin.profit,
          margin: summary.metrics.margin.margin,
          bonus: summary.metrics.bonus,
          sqftPerHr: 122.5,
        },
      })),
      divisions: [
        { divisionCode: 'D4', revenue: 184250, cost: 12944.55, margin: 0.9297, count: 1 },
        { divisionCode: 'D2', revenue: 93200, cost: 0, margin: 1, count: 1 },
      ],
    }) as T
  }

  if (path.startsWith('/api/sync/outbox')) {
    return clone({
      outbox: [
        {
          entity_type: 'project',
          entity_id: 'project-hillcrest',
          mutation_type: 'upsert',
          status: 'pending',
          created_at: '2026-04-23T18:00:00.000Z',
        },
      ],
    }) as T
  }

  if (path.startsWith('/api/rentals')) {
    // Simple status filter: the query string lives on path, so we peek.
    const statusMatch = path.match(/[?&]status=([^&]+)/)
    const status = statusMatch ? decodeURIComponent(statusMatch[1] ?? 'active') : 'active'
    const filtered = rentals.filter((rental) => {
      if (status === 'all') return true
      if (status === 'active') return rental.status === 'active'
      if (status === 'returned') return rental.status === 'returned' || rental.status === 'invoiced_pending'
      if (status === 'closed') return rental.status === 'closed'
      return true
    })
    return clone({ rentals: filtered } satisfies ListRentalsResponse) as T
  }

  if (path.startsWith('/api/audit-events')) {
    return clone({
      events: [
        {
          id: 'audit-1',
          actor_user_id: 'demo-user',
          actor_role: 'owner',
          entity_type: 'project',
          entity_id: 'project-hillcrest',
          action: 'update',
          before: { status: 'lead', bid_total: '150000.00' },
          after: { status: 'active', bid_total: '184250.00' },
          request_id: 'req-abc12345',
          sentry_trace: null,
          created_at: '2026-04-23T17:30:00.000Z',
        },
        {
          id: 'audit-2',
          actor_user_id: 'demo-user',
          actor_role: 'owner',
          entity_type: 'worker',
          entity_id: 'worker-ana',
          action: 'create',
          before: null,
          after: { name: 'Ana Castillo', role: 'lead' },
          request_id: 'req-def67890',
          sentry_trace: null,
          created_at: '2026-04-19T09:00:00.000Z',
        },
      ],
    } satisfies AuditEventsResponse) as T
  }

  const projectId = projectIdFromPath(path)
  if (path.endsWith('/summary')) {
    return clone(summaries[projectId] ?? summaries['project-hillcrest']!) as T
  }
  if (path.endsWith('/blueprints')) {
    return clone({ blueprints: blueprints.filter((blueprint) => blueprint.project_id === projectId) }) as T
  }
  if (path.endsWith('/takeoff/measurements')) {
    return clone({ measurements: measurements.filter((measurement) => measurement.project_id === projectId) }) as T
  }
  if (path.endsWith('/material-bills')) {
    return clone({ materialBills: materialBills.filter((bill) => bill.project_id === projectId) }) as T
  }
  if (path.endsWith('/schedules')) {
    return clone({ schedules: schedules.filter((schedule) => schedule.project_id === projectId) }) as T
  }

  throw new Error(`No fixture response for ${path}`)
}

export function mutateFixtureResponse<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  _companySlug: string,
): T {
  if (method === 'POST' && path.includes('/blueprints/') && path.endsWith('/versions')) {
    return clone({
      ...blueprints[0]!,
      ...(typeof body === 'object' && body !== null ? body : {}),
      id: `blueprint-fixture-${Date.now()}`,
      version: 3,
      created_at: new Date().toISOString(),
    }) as T
  }

  return clone({
    ...(typeof body === 'object' && body !== null ? body : {}),
    fixture: true,
    method,
    path,
  }) as T
}
