/**
 * `splash-cold-start` — Sitemap §1 panel 5.
 *
 * Branded splash shown during initial app load and as the lazy-route
 * Suspense fallback. Centred SL mark + product name + a "syncing to
 * projects · offline ready" status line above an indeterminate progress
 * bar so the first paint feels intentional rather than blank-then-pop.
 *
 * Stays inert when the user is already past first-load — App.tsx
 * decides when to swap it out.
 */
export interface ColdStartSplashProps {
  /** Override the status line. Defaults to "Syncing to projects · offline ready". */
  status?: string
}

export function ColdStartSplash({ status = 'Syncing to projects · offline ready' }: ColdStartSplashProps) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-ink text-[#f3ecdf] px-6">
      <div className="w-[88px] h-[88px] rounded-2xl bg-accent flex items-center justify-center mb-6 shadow-[0_8px_24px_rgba(217,144,74,0.4)]">
        <span className="font-display text-[36px] font-bold text-white tracking-tight leading-none">SL</span>
      </div>
      <h1 className="font-display text-[22px] font-bold tracking-tight">Sitelayer</h1>
      <p className="text-[13px] text-[#aea69a] mt-1">Construction operations</p>

      <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+24px)] left-0 right-0 px-8">
        <div className="h-1 bg-[#3a342d] rounded-full overflow-hidden">
          <div className="h-full bg-accent w-1/3 animate-[splash-bar_1.4s_ease-in-out_infinite]" />
        </div>
        <div className="text-[11px] text-[#8a8278] text-center mt-2 font-mono tabular-nums">{status}</div>
      </div>

      <style>{`
        @keyframes splash-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(80%); }
          100% { transform: translateX(220%); }
        }
      `}</style>
    </div>
  )
}
