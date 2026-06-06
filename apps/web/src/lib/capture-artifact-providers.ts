export type CaptureArtifactProviderInput = {
  captureSessionId: string
  metadata: Record<string, unknown>
}

export type CaptureArtifactProvider = (input: CaptureArtifactProviderInput) => Promise<unknown>

export type CaptureArtifactProviderResult = {
  id: string
  status: 'uploaded' | 'skipped' | 'failed'
  result?: unknown
  error?: string
}

const providers = new Map<string, CaptureArtifactProvider>()

export function registerCaptureArtifactProvider(id: string, provider: CaptureArtifactProvider): () => void {
  providers.set(id, provider)
  return () => {
    if (providers.get(id) === provider) providers.delete(id)
  }
}

export async function uploadRegisteredCaptureArtifacts(
  captureSessionId: string,
  metadata: Record<string, unknown> = {},
): Promise<CaptureArtifactProviderResult[]> {
  const entries = Array.from(providers.entries())
  const results: CaptureArtifactProviderResult[] = []
  for (const [id, provider] of entries) {
    try {
      const result = await provider({ captureSessionId, metadata })
      results.push({
        id,
        status: result ? 'uploaded' : 'skipped',
        ...(result ? { result } : {}),
      })
    } catch (error) {
      results.push({
        id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export function __resetCaptureArtifactProvidersForTests(): void {
  providers.clear()
}
