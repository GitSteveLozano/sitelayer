// `/crew` is the post-audit bottom-tab destination for labor management.
// It mounts the same role-aware screen as `/time` so the cross-project
// approval queue (owner) / batch entry (foreman) / personal hours
// (worker) are reachable from either route. The drawer still surfaces
// `/time` with the label "Time"; the bottom tab uses the new "Crew"
// label. Both render identically — pick whichever feels right at the
// call site.
import TimeRoute from './time'

export default TimeRoute
