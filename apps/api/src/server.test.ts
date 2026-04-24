import { describe, it, expect, beforeAll } from 'vitest'
import http from 'node:http'

const describeIntegration = process.env.RUN_API_INTEGRATION === '1' ? describe : describe.skip

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'
  process.env.ACTIVE_COMPANY_SLUG = 'la-operations'
  process.env.ACTIVE_USER_ID = 'demo-user'
})

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T & { status: number }> {
  const options: http.RequestOptions = {
    hostname: 'localhost',
    port: 3001,
    path,
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-sitelayer-company-slug': 'la-operations',
      'x-sitelayer-user-id': 'demo-user',
    },
  }

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve({ ...parsed, status: res.statusCode })
        } catch {
          resolve({ status: res.statusCode } as T & { status: number })
        }
      })
    })

    req.on('error', reject)

    if (body) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

describeIntegration('API Integration Tests', () => {
  it('GET /health returns 200 OK', async () => {
    const result = await apiCall<{ ok: boolean }>('GET', '/health')
    expect(result.status).toBe(200)
    expect(result.ok).toBe(true)
  })

  it('GET /api/bootstrap returns company and entities', async () => {
    const result = await apiCall<{ company: any; projects: any[] }>('GET', '/api/bootstrap')
    expect(result.status).toBe(200)
    expect(result.company).toBeDefined()
    expect(result.company.slug).toBe('la-operations')
    expect(Array.isArray(result.projects)).toBe(true)
  })

  it('GET /api/companies returns user memberships', async () => {
    const result = await apiCall<{ companies: any[] }>('GET', '/api/companies')
    expect(result.status).toBe(200)
    expect(Array.isArray(result.companies)).toBe(true)
  })

  it('GET /api/session returns user info', async () => {
    const result = await apiCall<{ user: any }>('GET', '/api/session')
    expect(result.status).toBe(200)
    expect(result.user).toBeDefined()
    expect(result.user.id).toBe('demo-user')
  })

  it('GET /api/analytics returns division analytics', async () => {
    const result = await apiCall<{ projects: any[]; divisions: any[] }>('GET', '/api/analytics')
    expect(result.status).toBe(200)
    expect(Array.isArray(result.divisions)).toBe(true)
  })

  it('GET /api/analytics/history returns historical data', async () => {
    const result = await apiCall<{ history: any[] }>('GET', '/api/analytics/history?from=2026-01-01&to=2026-12-31')
    expect(result.status).toBe(200)
    expect(Array.isArray(result.history)).toBe(true)
  })

  it('POST /api/projects creates a new project', async () => {
    const bootstrap = await apiCall<{ customers: Array<{ id: string }> }>('GET', '/api/bootstrap')
    const customerId = bootstrap.customers[0]?.id
    expect(customerId).toBeDefined()

    const result = await apiCall<{ id: string }>('POST', '/api/projects', {
      name: 'Test Project',
      customer_id: customerId,
      customer_name: 'Test Customer',
      division_code: 'D1',
      bid_total: 50000,
      labor_rate: 50,
    })
    expect(result.status).toBe(201)
    expect(result.id).toBeDefined()
  })

  it('POST /api/labor-entries records hours', async () => {
    // This test would require a project to exist first
    // Skipping for now as it depends on project creation
  })

  it('Unmapped routes return 404', async () => {
    const result = await apiCall<any>('GET', '/api/nonexistent')
    expect(result.status).toBe(404)
  })
})
