// React mount for the WebMCP shim.
//
// Mounted ONCE inside the authenticated app shell (a `<SignedIn>` /
// fixture-auth sibling of the capture dock in App.tsx). Registers sitelayer's
// deterministic-workflow tools with the in-tab WebMCP host on mount and
// unregisters on unmount, so the provider state follows the signed-in session
// and never leaks across sign-out. When the browser has no WebMCP surface the
// hook no-ops (the disposer it gets back is a no-op).

import { useEffect } from 'react'
import { registerSitelayerWebMcpTools } from './register-sitelayer-tools'

/**
 * Register the sitelayer WebMCP tools for the lifetime of the calling
 * component. Effect-only; renders nothing. Safe to mount unconditionally —
 * `registerSitelayerWebMcpTools` feature-detects and no-ops without a host.
 */
export function useSitelayerWebMcpTools(): void {
  useEffect(() => {
    const dispose = registerSitelayerWebMcpTools()
    return dispose
  }, [])
}
