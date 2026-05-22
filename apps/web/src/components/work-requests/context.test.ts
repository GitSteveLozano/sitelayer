import { describe, expect, it, vi } from 'vitest'
import { buildBrowserWorkRequestContext } from './context'

vi.mock('@/lib/api/client', () => ({
  getBuildSha: () => 'build-123',
  nextRequestId: () => 'req-123',
}))

describe('buildBrowserWorkRequestContext', () => {
  it('adds bounded browser state to every work request context', () => {
    window.history.replaceState({}, '', '/projects/project-1?tab=budget')
    Object.defineProperty(window.navigator, 'language', { configurable: true, value: 'en-US' })
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })

    const context = buildBrowserWorkRequestContext({
      entity: { entity_type: 'project', entity_id: 'project-1' },
    })

    expect(context).toMatchObject({
      source: 'web',
      client_request_id: 'req-123',
      build_sha: 'build-123',
      page: {
        path: '/projects/project-1',
        search: '?tab=budget',
        route: '/projects/project-1?tab=budget',
      },
      browser: {
        locale: 'en-US',
        online: true,
        user_agent_family: 'chrome',
        mobile: false,
        viewport: {
          width: 390,
          height: 844,
          device_pixel_ratio: 3,
        },
      },
      entity: { entity_type: 'project', entity_id: 'project-1' },
    })
  })
})
