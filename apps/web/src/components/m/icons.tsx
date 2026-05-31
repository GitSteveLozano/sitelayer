/**
 * Icon set used by the mobile design system. The 5-pointed Spark is custom
 * (it's the AI-marker icon — never substitute lucide's Sparkles, magic wand,
 * or stars per Design Overview/design_system/README.md). Everything else
 * re-exports from lucide-react so we get a consistent stroke weight.
 */
import {
  AlertCircle,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  CloudRain,
  Drill,
  FileText,
  Home,
  Layers,
  MapPin,
  Mic,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Truck,
  Users,
  WifiOff,
  X,
} from 'lucide-react'

export const MI = {
  Alert: AlertCircle,
  AlertTri: AlertTriangle,
  Camera,
  Check: CheckCircle2,
  ChevLeft: ChevronLeft,
  ChevRight: ChevronRight,
  Clock,
  CloudOff,
  CloudRain,
  Drill,
  FileText,
  Home,
  Layers,
  MapPin,
  Mic,
  More: MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Truck,
  Users,
  WifiOff,
  X,
} as const

/**
 * The Spark — the only AI marker the system uses. Five-pointed inset star
 * with rounded interior. Per `mobile-tokens.css` `.m-spark` rules, the
 * `data-state` attribute selects the color (dim/muted/accent/strong).
 */
export function Spark({
  state,
  size = 14,
  className,
  ...rest
}: {
  state?: 'dim' | 'muted' | 'accent' | 'strong'
  size?: number
} & React.SVGProps<SVGSVGElement>) {
  return (
    <span className={`m-spark${className ? ` ${className}` : ''}`} data-state={state ?? 'accent'}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
        <path d="M12 2 L13.7 9.5 L21 11 L13.7 12.5 L12 20 L10.3 12.5 L3 11 L10.3 9.5 Z" />
      </svg>
    </span>
  )
}
