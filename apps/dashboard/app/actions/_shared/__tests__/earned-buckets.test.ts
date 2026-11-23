/**
 * Pure no-DB lock on earnedBucketsFromAgentEarned:
 * the DB-gated parity suite proves canon end-to-end; this fails fast on the
 * bucketing arithmetic alone.
 */
import { earnedBucketsFromAgentEarned } from '../per-event-earned'

const agentEarned = {
  bySubscription: [
    // two subs, same agent + customer, different plans — must sum, not clobber
    { subscriptionId: 's1', customerId: 'c1', agentId: 'a1', planId: 'p1', revenue: 200, eventCount: 3 },
    { subscriptionId: 's2', customerId: 'c1', agentId: 'a1', planId: 'p2', revenue: 100, eventCount: 1 },
    // second agent/customer partition
    { subscriptionId: 's3', customerId: 'c2', agentId: 'a2', planId: 'p1', revenue: 50, eventCount: 1 },
    // null planId row: counts for agent/customer, dropped from plan bucket
    { subscriptionId: 's4', customerId: 'c2', agentId: 'a2', planId: null, revenue: 25, eventCount: 1 },
  ],
  byStrategy: [
    { strategyId: 'st1', signalId: 'sig1', revenue: 250 },
    { strategyId: 'st2', signalId: 'sig1', revenue: 75 }, // same signal via 2nd strategy — sums
    { strategyId: 'st3', signalId: null, revenue: 50 }, // signal-less charge — dropped (Σsignal ≤ Σagent)
  ],
} as never

it('partitions bySubscription into agent/customer/plan sums without double-counting', () => {
  const b = earnedBucketsFromAgentEarned(agentEarned)
  expect(b.byAgentId.get('a1')).toBe(300)
  expect(b.byAgentId.get('a2')).toBe(75)
  expect(b.byCustomerId.get('c1')).toBe(300)
  expect(b.byCustomerId.get('c2')).toBe(75)
  expect(b.byPlanId.get('p1')).toBe(250)
  expect(b.byPlanId.get('p2')).toBe(100)
  expect([...b.byPlanId.values()].reduce((a, v) => a + v, 0)).toBe(350) // null-plan $25 dropped
})

it('sums signal buckets across strategies and drops signal-less rows (Σsignal ≤ Σagent)', () => {
  const b = earnedBucketsFromAgentEarned(agentEarned)
  expect(b.bySignalId.get('sig1')).toBe(325)
  expect(b.bySignalId.size).toBe(1)
  const sigTotal = [...b.bySignalId.values()].reduce((a, v) => a + v, 0)
  const agentTotal = [...b.byAgentId.values()].reduce((a, v) => a + v, 0)
  expect(sigTotal).toBeLessThanOrEqual(agentTotal)
})
