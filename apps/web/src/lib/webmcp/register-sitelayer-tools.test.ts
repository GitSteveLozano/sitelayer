import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the single HTTP client so we can assert the path + body each WebMCP
// tool sends, without standing up a server. `ApiError` is kept REAL (via
// importOriginal) because the tools branch on `err instanceof ApiError`.
const requestMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>()
  return { ...actual, request: requestMock }
})

import { ApiError } from '@/lib/api/client'
import {
  buildSitelayerWebMcpTools,
  isValidWorkflowRoute,
  registerSitelayerWebMcpTools,
} from './register-sitelayer-tools'
import type { WebMcpHost, WebMcpRegistrationInput } from './webmcp-adapter'

afterEach(() => {
  requestMock.mockReset()
})

const toolByName = (name: string) => {
  const tool = buildSitelayerWebMcpTools().find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

describe('isValidWorkflowRoute', () => {
  it('accepts hyphenated lowercase route segments', () => {
    expect(isValidWorkflowRoute('rental-billing-runs')).toBe(true)
    expect(isValidWorkflowRoute('shipments')).toBe(true)
    expect(isValidWorkflowRoute('boms')).toBe(true)
  })

  it('rejects anything that could escape /api/', () => {
    expect(isValidWorkflowRoute('rental-billing-runs/../admin')).toBe(false)
    expect(isValidWorkflowRoute('shipments?x=1')).toBe(false)
    expect(isValidWorkflowRoute('Shipments')).toBe(false)
    expect(isValidWorkflowRoute('a/b')).toBe(false)
    expect(isValidWorkflowRoute('')).toBe(false)
    expect(isValidWorkflowRoute(42)).toBe(false)
    expect(isValidWorkflowRoute(undefined)).toBe(false)
  })
})

describe('buildSitelayerWebMcpTools descriptor shape', () => {
  const tools = buildSitelayerWebMcpTools()

  it('exposes exactly the three workflow tools', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'sitelayer_list_workflows',
      'sitelayer_get_workflow_snapshot',
      'sitelayer_apply_workflow_event',
    ])
  })

  it('every tool has a description, an object inputSchema, and an execute fn', () => {
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema.type).toBe('object')
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('snapshot + apply tools require workflow + id; apply also requires event', () => {
    const snapshot = toolByName('sitelayer_get_workflow_snapshot')
    expect(snapshot.inputSchema.required).toEqual(['workflow', 'id'])
    const apply = toolByName('sitelayer_apply_workflow_event')
    expect(apply.inputSchema.required).toEqual(['workflow', 'id', 'event'])
  })
})

describe('tool execute → request<T>()', () => {
  it('list_workflows GETs the agent-tools manifest', async () => {
    requestMock.mockResolvedValue({ contract_version: 1, workflows: [] })
    const result = await toolByName('sitelayer_list_workflows').execute({})
    expect(requestMock).toHaveBeenCalledWith('/api/agent-tools')
    expect(result).toEqual({ contract_version: 1, workflows: [] })
  })

  it('get_workflow_snapshot GETs /api/<route>/:id with the id encoded', async () => {
    requestMock.mockResolvedValue({ state: 'generated', state_version: 3 })
    const result = await toolByName('sitelayer_get_workflow_snapshot').execute({
      workflow: 'rental-billing-runs',
      id: 'run 1/x',
    })
    expect(requestMock).toHaveBeenCalledWith('/api/rental-billing-runs/run%201%2Fx')
    expect(result).toEqual({ state: 'generated', state_version: 3 })
  })

  it('apply_workflow_event POSTs { event, state_version, payload } to .../events', async () => {
    requestMock.mockResolvedValue({ state: 'approved', state_version: 4 })
    await toolByName('sitelayer_apply_workflow_event').execute({
      workflow: 'rental-billing-runs',
      id: 'run-1',
      event: 'APPROVE',
      state_version: 3,
      payload: { note: 'ok' },
    })
    expect(requestMock).toHaveBeenCalledWith('/api/rental-billing-runs/run-1/events', {
      method: 'POST',
      json: { event: 'APPROVE', state_version: 3, payload: { note: 'ok' } },
    })
  })

  it('apply_workflow_event omits state_version + payload when not supplied', async () => {
    requestMock.mockResolvedValue({ state: 'approved', state_version: 1 })
    await toolByName('sitelayer_apply_workflow_event').execute({
      workflow: 'shipments',
      id: 's1',
      event: 'SHIP',
    })
    expect(requestMock).toHaveBeenCalledWith('/api/shipments/s1/events', {
      method: 'POST',
      json: { event: 'SHIP' },
    })
  })

  it('rejects an invalid workflow route before touching the network', async () => {
    await expect(
      toolByName('sitelayer_get_workflow_snapshot').execute({ workflow: '../admin', id: 'x' }),
    ).rejects.toThrow(/invalid "workflow"/)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('surfaces a 409 ApiError as a structured result (not a throw) so the agent can retry', async () => {
    const snapshot = { state: 'posting', state_version: 5, context: {}, next_events: [] }
    requestMock.mockRejectedValue(
      new ApiError({
        status: 409,
        path: '/api/rental-billing-runs/run-1/events',
        method: 'POST',
        requestId: 'req-1',
        body: { error: 'stale state_version', snapshot },
      }),
    )
    const result = (await toolByName('sitelayer_apply_workflow_event').execute({
      workflow: 'rental-billing-runs',
      id: 'run-1',
      event: 'APPROVE',
      state_version: 1,
    })) as { status: number; body: { snapshot: unknown } }
    expect(result.status).toBe(409)
    expect(result.body.snapshot).toEqual(snapshot)
  })
})

describe('registerSitelayerWebMcpTools feature-detection', () => {
  it('no-ops with a disposer when no WebMCP host is present', () => {
    // No host override and (in jsdom) no navigator.modelContext → detect null.
    const dispose = registerSitelayerWebMcpTools()
    expect(typeof dispose).toBe('function')
    // Disposing a no-op registration must not throw.
    expect(() => dispose()).not.toThrow()
  })

  it('registers every tool with a host and unregisters them on dispose', () => {
    const unregister = vi.fn()
    const registered: WebMcpRegistrationInput[] = []
    const host: WebMcpHost = {
      registerTool: (tool) => {
        registered.push(tool)
        return { unregister }
      },
    }
    const dispose = registerSitelayerWebMcpTools(host)
    expect(registered.map((t) => t.name)).toEqual([
      'sitelayer_list_workflows',
      'sitelayer_get_workflow_snapshot',
      'sitelayer_apply_workflow_event',
    ])
    dispose()
    expect(unregister).toHaveBeenCalledTimes(3)
    // Idempotent: a second dispose does not double-unregister.
    dispose()
    expect(unregister).toHaveBeenCalledTimes(3)
  })

  it('adapts the host handler to the MCP { content:[{type:text}] } envelope', async () => {
    requestMock.mockResolvedValue({ contract_version: 1, workflows: [] })
    let captured: WebMcpRegistrationInput | undefined
    const host: WebMcpHost = {
      registerTool: (tool) => {
        if (tool.name === 'sitelayer_list_workflows') captured = tool
        return { unregister: () => {} }
      },
    }
    registerSitelayerWebMcpTools(host)
    const envelope = await captured!.execute({})
    const block = envelope.content[0]
    expect(block?.type).toBe('text')
    expect(JSON.parse(block?.text ?? 'null')).toEqual({ contract_version: 1, workflows: [] })
  })
})
