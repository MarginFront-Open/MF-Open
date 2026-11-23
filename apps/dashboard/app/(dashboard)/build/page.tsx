import Build from '@/features/build'

// No requireRouteRoles on purpose: /build is view-ungated for parity with
// /agents and /metrics-events. Every write stays assertBuildManager-gated
// server-side.
export default function BuildRoute() {
  return <Build />
}
