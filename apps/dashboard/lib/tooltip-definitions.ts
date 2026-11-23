// Central source of truth for every tooltip definition in the app.
// When a term gets updated here, it changes everywhere automatically.

import { docsLink } from '@/config/operator'

const CREDIT_BALANCES_DOCS = docsLink('/api-reference/credit-balances')

interface TooltipDefinition {
  // Bold heading shown in the tooltip
  title: string
  // Plain-English explanation (1-2 sentences)
  description: string
  // Optional extra context — formulas, examples, or caveats
  details?: string
}

/**
 * What usage revenue leaves out, in ONE place: Build's agents table, the ROI
 * agents table and the usage-revenue tiles all label a column "Earned", and a
 * customer must not get two answers. "One-time" is the product's word for these
 * everywhere else, and a setup fee is one of them.
 */
export const FEES_OUTSIDE_USAGE_REVENUE = 'recurring, seat and one-time fees'

// `satisfies` (not a `Record<string, …>` annotation) keeps the literal key
// union alive so TILE_METRIC_REGISTRY (src/lib/component-catalog.ts) can
// type-check its tooltipKey references against the real key set.
export const tooltipDefinitions = {
  // ============================================
  // COST MANAGEMENT KPI CARDS
  // ============================================
  totalCost: {
    title: 'Total Cost',
    description:
      "The total amount you've spent on AI usage across all metrics, agents, and customers during the selected time period.",
  },
  // Hero tile copy for the command center pages, where the window is
  // fixed at last 30 days (the page does not have a date picker).
  totalCostHero: {
    title: 'Total Cost (last 30 days)',
    description:
      'What it cost you to deliver across every event in the last 30 days.',
    details: 'Sourced from MarginFront’s built-in pricing catalog.',
  },
  // Hero tile copy for "Total Revenue". Canon Total Revenue (L2) =
  // events x rate + recurring + seat + onetime. Everything earnable in
  // the window. Distinct from Agent-Earned (events x rate only) which
  // powers the strip's per-agent Revenue label.
  totalRevenueHero: {
    title: 'Total Revenue (last 30 days)',
    description:
      'Everything earnable in the last 30 days: events times your pricing rate, recurring fees, seat fees, and one-time fees.',
    details:
      'Updates in real time. The Collected tile next to this shows what has actually been paid.',
  },
  // Window-agnostic Total Revenue for the customer/subscription detail tiles,
  // which honor a 30d/all-time toggle; totalRevenueHero's "last 30 days" would lie there.
  totalRevenue: {
    title: 'Total Revenue',
    description:
      'Everything earnable: events times your pricing rate, plus recurring, seat, and one-time fees.',
    details: 'Updates in real time.',
  },
  // Cost-vs-Revenue chart tab on the customer + subscription usage detail
  // charts. The two area lines are cumulative cost and cumulative Revenue
  // (earned + fees); the gap between them is the running margin.
  costVsRevenueChart: {
    title: 'Cost vs Revenue',
    description:
      'Your cumulative cost and cumulative revenue over the period, side by side. The gap between the two lines is your margin.',
    details:
      'Revenue here is everything earnable (usage plus recurring, seat, and one-time fees), not just what has been invoiced.',
  },
  // Money page chart title tooltip. The chart's Revenue line
  // is canon Revenue (formula), the R1+R2 accrual from getRevenueMetrics —
  // it never reads invoices, so this entry must never say "bill"
  // (chart-title-tooltip.test.ts enforces it). Distinct from
  // costVsRevenueChart above, the CUMULATIVE customer/subscription variant.
  moneyCostVsRevenue: {
    title: 'Cost vs revenue',
    description:
      'Cost is what you pay AI providers. Revenue is what customers owe you for this window: usage at your pricing rates, plus subscription, seat, and one-time fees, whether or not an invoice has gone out yet.',
    details:
      'Both lines are per-day totals for the selected window. Invoice totals are a different number and live on the Invoices tab.',
  },
  // Agent Strip header for the "Top Agent" anchor card, explaining what
  // each agent card means.
  agentStripTopAgent: {
    title: 'Top Agent (last 30 days)',
    description:
      'The agent that brought in the most revenue this month. Every other agent shows up to the right, ranked by revenue.',
    details:
      "Each card shows that agent's cost, revenue, margin, and how the margin is trending vs the prior 30 days.",
  },
  // Same shape as agentStripTopAgent but ranked by COST, not revenue, so
  // the top tile is the most expensive agent rather than the highest earner.
  agentStripTopCostAgent: {
    title: 'Top Cost Agent (last 30 days)',
    description:
      'The agent costing you the most to run this month. Every other agent shows up to the right, ranked by cost.',
    details:
      "Each card shows that agent's cost, usage-event count, and how cost is trending vs the prior 30 days.",
  },
  avgDailyCost: {
    title: 'Avg Daily Cost',
    description:
      'Your average cost per day during the selected period. Calculated by dividing Total Cost by the number of days.',
    details: 'Formula: Total Cost ÷ Days in Period',
  },
  avgCostPerEvent: {
    title: 'Avg Cost/Event',
    description:
      'How much each usage event costs you on average. Useful for spotting expensive operations.',
    details: 'Formula: Total Cost ÷ Total Events',
  },
  monthlyRunRate: {
    title: 'Monthly Run Rate',
    description:
      "An estimate of what you'd spend in a full month if current usage continues at the same pace.",
    details:
      'Formula: (Total Cost ÷ Days in Period) × 30. This is a projection, not a prediction.',
  },
  costRunRate: {
    title: 'Cost Run Rate',
    description:
      'Projected costs at monthly, quarterly, and annual intervals based on your current daily spend.',
    details:
      'Run Rate = (Total Cost ÷ Days in Period) × Target Days. Industry standard metric used by Stripe, ChartMogul, and SaaS financial reporting.',
  },
  topAgent: {
    title: 'Top Agent',
    description:
      'The AI agent that has consumed the most resources (highest total cost) during the selected period.',
  },

  // ============================================
  // COST MANAGEMENT SECTIONS
  // ============================================
  costTrends: {
    title: 'Cost Trends Over Time',
    description:
      'A chart showing how your costs change day-by-day (or week/month). Look for spikes or patterns.',
  },
  costBreakdowns: {
    title: 'Cost Breakdowns',
    description:
      'See where your money is going — broken down by service, metric, agent, or customer.',
  },
  // The per-row revenue column on the Money breakdown
  // table/donut. Its header flips with the grouping: Earned for agent/task,
  // Billed for customer/plan. Deliberately spells out that this is NOT the
  // Total Revenue tile (per-bucket vs whole-window).
  breakdownRevenueColumn: {
    title: 'Revenue in this table',
    description:
      'Revenue for each row of the current grouping. Group by agent or task and it shows Earned (events times your pricing rate); group by customer or plan and it shows Billed (invoice totals).',
    details:
      'This is per-row revenue, not the same as the Total Revenue tile above: that tile is your whole-window revenue including recurring and seat fees. Rows grouped by model, environment, or day show "—" because there is no honest per-row revenue for those.',
  },
  // The basis chip beside the breakdown "Group by" control
  // (dimensioned-section.tsx), one entry per chip state.
  // Earned = canon R1 (Agent-Earned), Billed = canon I2/I3 (invoice totals),
  // and a "Revenue" chart line or tile is R1+R2 — three different numbers.
  breakdownBasisEarned: {
    title: 'Earned revenue in this table',
    description:
      'With this grouping, the revenue column shows Earned: events times your pricing rate for each row. No subscription, seat, or one-time fees.',
    details:
      'Anything labeled Revenue adds those fees on top, so Earned here reading lower than a Revenue chart or tile is expected, not a bug.',
  },
  breakdownBasisBilled: {
    title: 'Billed revenue in this table',
    description:
      'With this grouping, the revenue column shows Billed: invoice totals for each customer or plan.',
    details:
      'Anything labeled Revenue counts what customers owe as work happens, before any invoice, so Billed and Revenue can honestly differ.',
  },
  breakdownBasisNone: {
    title: 'No revenue for this grouping',
    description:
      'There is no honest way to attribute revenue to these rows, so the table shows cost only.',
    details:
      'Group by agent or task to see Earned revenue, or by customer or plan to see Billed revenue.',
  },

  // ============================================
  // TABLE COLUMN HEADERS
  // ============================================
  units: {
    title: 'Units',
    description:
      'The total quantity of usage — for example, tokens processed, API calls made, or messages sent.',
    details:
      'Units = the sum of quantities across all events. Different from Events, which counts the number of records.',
  },
  events: {
    title: 'Events',
    description:
      "The number of individual usage records. Each time your system logs a usage occurrence, that's one event.",
    details:
      'Example: 1 event with quantity=17 means "one record that reported 17 units of usage."',
  },
  avgCostPerUnit: {
    title: 'Avg Cost/Unit',
    description:
      'How much each unit of usage costs you on average for this item.',
    details: 'Formula: Total Cost ÷ Total Units',
  },
  percentOfTotal: {
    title: '% of Total',
    description:
      'What share of your total cost this item accounts for. Helps you find the biggest cost drivers.',
  },

  // ============================================
  // DIMENSION TABS / FILTERS
  // ============================================
  metric: {
    title: 'Metric',
    description:
      'A measurable activity you track for billing — like "API Calls," "Storage GB," or "Messages Sent." Also called a Usage Metric.',
  },
  agent: {
    title: 'Agent',
    description:
      'An AI agent or service that performs work for your customers. Agents contain one or more metrics that measure what they do.',
  },
  customer: {
    title: 'Customer',
    description:
      'An end-user or company subscribed to one or more of your agents. Their usage generates your costs and revenue.',
  },
  services: {
    title: 'Services',
    description:
      'The underlying AI providers (like OpenAI, Anthropic, etc.) that power your agents. This tab shows cost by provider.',
  },

  // ============================================
  // HOME PAGE
  // ============================================
  totalUsage: {
    title: 'Usage',
    description:
      'Your overall usage. Units = how much was used. Events = how many times an agentic job ran. One event can have many units.',
    details: 'Click to view Usage Events.',
  },
  totalCosts: {
    title: 'Costs',
    description:
      'The total amount spent on AI usage across all agents and customers during this period.',
    details: 'Click to view Cost Management.',
  },
  customers: {
    title: 'Customers',
    description:
      'The number of active customers in your organization — anyone with at least one subscription.',
    details: 'Click to view all customers.',
  },
  usageByMetric: {
    title: 'Usage by Metric',
    description:
      'Shows your top metrics ranked by quantity (units). Each metric represents a billable activity your agents perform.',
  },
  agents: {
    title: 'Agents',
    description:
      'How usage is distributed across your AI agents. Agents are the services that do work for your customers.',
  },
  topCustomersByCost: {
    title: 'Cost Breakdown',
    description:
      'Where your AI costs are going, split by agent or by customer.',
  },
  eventTrend: {
    title: 'Event Trend',
    description:
      'A 30-day chart of daily usage events. Helps you spot patterns, spikes, or drops in activity.',
  },
  ingestionLog: {
    title: 'Ingestion Log',
    description:
      'The raw data feed showing every usage payload your SDK sends in. Useful for debugging and verifying data.',
    details:
      'Each row shows the original payload before processing. Status can be: Pending, Processed, or Error.',
  },

  // ============================================
  // REVENUE FUNNEL + STAGES
  // Only labels whose meaning isn't obvious get a tooltip. Plain labels
  // like "Collected" and "% of revenue" have none.
  // ============================================
  earnedRevenue: {
    title: 'Earned Revenue (last 30d)',
    description: 'Events × pricing + recurring + seat fees.',
    details: 'Excludes setup fees. Updates in real time.',
  },
  // For the /home breakdown tables. Their Agent-Earned numbers exclude the
  // recurring and seat fees that `earnedRevenue` above includes.
  earnedRevenueBreakdown: {
    title: 'Earned Revenue (last 30d)',
    description: 'Events × pricing rate.',
    details: `Excludes ${FEES_OUTSIDE_USAGE_REVENUE}. Updates in real time.`,
  },
  billedRevenue: {
    title: 'Billed Revenue (last 30d)',
    description: 'Invoice totals sent, regardless of payment status.',
    details: "See Collected for what's actually been paid, net of any refunds.",
  },
  usageRevenue: {
    title: 'Usage Revenue (last 30d)',
    description: 'Events × pricing rate for this agent.',
    details: `Excludes ${FEES_OUTSIDE_USAGE_REVENUE}.`,
  },
  eventRevenue: {
    title: 'Event Revenue',
    description: 'Quantity × pricing rate for this one event.',
  },
  grossMarginPct: {
    title: 'Gross Margin (last 30d)',
    description: '(Billed − cost) ÷ billed × 100.',
  },

  // ============================================
  // CANONICAL MARGIN KEYS (4-label model)
  // Each dollar-label has its own margin. Tooltip copy is plain English:
  // no rule codes and no code terms.
  // ============================================
  totalMargin: {
    title: 'Total Margin',
    description:
      'Your total revenue minus your costs, shown as a percentage. Includes all charges: usage, subscriptions, seats, and one-time fees.',
    details: 'Shown as "—" when there is no revenue yet in this window.',
  },
  agentEarnedMargin: {
    title: 'Earned Margin',
    description:
      "This agent's earnings minus its costs, shown as a percentage. Earnings count only events times pricing — no subscription or seat fees.",
    details: 'Shown as "—" when this agent has no earnings yet in this window.',
  },
  billedMargin: {
    title: 'Billed Margin',
    description:
      "What you invoiced minus your costs, shown as a percentage. Counts invoices you've sent (issued or overdue).",
    details: 'Shown as "—" when no invoices have been sent in this window.',
  },
  collectedMargin: {
    title: 'Collected Margin',
    description:
      'What customers actually kept paying you minus your costs, shown as a percentage. Counts only paid invoices, net of any refunds.',
    details: 'Shown as "—" when no invoices have been paid in this window.',
  },
  // ── Finance / Month-End Close headline metrics ──
  // AI gross margin here is the CLASSIFIED-COGS-only headline: revenue
  // minus the cost booked as Production COGS. Uncategorized spend is NOT
  // folded in — it lives on its own line. Keep this in sync with
  // getCostClassificationBreakdown in cost-command-center.ts.
  aiGrossMarginClassified: {
    title: 'AI gross margin (classified)',
    description:
      'Your revenue minus the AI cost booked as cost-of-goods-sold (COGS), shown as a percentage. Uncategorized spend is excluded, not counted as COGS.',
    details:
      'This number moves as you classify uncategorized cost. Shown as "—" when there is no revenue yet in this period.',
  },
  unclassifiedCostBucket: {
    title: 'Uncategorized cost',
    description:
      'AI cost we have not yet sorted into a P&L category. It sits on its own line and is never folded into COGS.',
    details:
      'Classify it on the Cost Management page to sharpen your AI gross margin and coverage score.',
  },
  // Month-End Close "Coverage score" headline. The title avoids
  // "defensibility" because the number measures tagging coverage, not
  // audit-grade rigor. The number is getDefensibilityScore in
  // finance-metrics.ts: a weighted blend of how much AI cost is classified
  // into P&L buckets (60%), mapped to GL codes (25%), and tagged with an
  // environment (15%), renormalized when a term is missing. The key matches
  // that function's name.
  defensibilityScore: {
    title: 'Coverage score',
    description:
      'How audit-ready your cost numbers are — how much of your AI cost is classified into P&L buckets (60%), mapped to GL codes (25%), and tagged with an environment (15%). Reflects tagging coverage, not reconciliation to vendor invoices.',
    details:
      'Higher is better. Classify uncategorized cost, map signals to GL codes, and send the environment tag on your events to raise it.',
  },
  customerShareOfRevenue: {
    title: 'Customer Share of Revenue',
    description:
      'How much of your paid-in revenue this customer represents, all-time. Both sides are net of refunds.',
    details:
      "Calculated as this customer's paid invoices (minus refunds) divided by all paid invoices across your organization (minus refunds).",
  },
  customerShareOfCost: {
    title: 'Customer Share of Cost',
    description:
      'How much of your total cost this customer represents, all-time.',
    details:
      "Calculated as this customer's sum of signal_events.usageCost divided by the org's all-time sum (canon C1). Independent of invoicing — answers 'how much of our spend does this customer drive?'",
  },
  newAgentBadge: {
    title: 'New Agent',
    description:
      "This agent has activity now but didn't have any 30 to 60 days ago. There is nothing to compare against yet.",
    details:
      'A trend arrow will appear once this agent has been active across both windows.',
  },
  mrrDefinition: {
    title: 'MRR',
    description:
      'Monthly value of all active recurring contracts. Adds up subscription fees and seat fees for every active subscription. Yearly plans divide by 12.',
    details: 'Excludes usage (see Run-Rate) and one-time charges.',
  },
  mrrCanonical: {
    title: 'Monthly Recurring Revenue',
    description:
      "Monthly value of this customer's active recurring contracts. Subscription fees and seat fees only.",
    details: 'ARR equals this number times 12. Usage is in Run-Rate MRR.',
  },
  runRateMrr: {
    title: 'Run-Rate MRR',
    description:
      'What this customer would pay per month if the last 30 days of activity keep going. Includes subscription fees and actual usage.',
    details:
      'Differs from MRR if usage is trending up or down. Run-Rate ARR equals Run-Rate MRR times 12.',
  },
  noBilledRevenueBadge: {
    title: 'No Billed Revenue (last 30d)',
    description: 'No invoices attribute to this agent yet.',
    details: 'Events may still be logged.',
  },
  // Window-agnostic KPI-tile copy: the shell's date-range
  // selector means "last 30d" phrasing would lie under a month/custom window.
  overdueAmount: {
    title: 'Overdue',
    description:
      'The dollar total of invoices that are past their due date and still unpaid.',
    details:
      "Money you already earned but have not collected. This is what's overdue right now, so it does not change when you switch the date range above. See the Invoices page for the individual invoices.",
  },
  agentEarned: {
    title: 'Earned',
    description: 'Events times your pricing rate for the selected period.',
    details: `Excludes ${FEES_OUTSIDE_USAGE_REVENUE}. Updates in real time.`,
  },
  arrDefinition: {
    title: 'ARR',
    description:
      'Annual value of all active recurring contracts. MRR times 12.',
    details: 'Excludes usage and one-time charges, same as MRR.',
  },
  netCollected: {
    title: 'Net Collected',
    description: 'Total collected minus refunds.',
  },

  // Generic fallback for a surface that doesn't show one specific stage.
  revenue: {
    title: 'Revenue',
    description:
      'Revenue has three stages in MarginFront: Earned (events × pricing), Billed (invoices sent), Collected (invoices paid). Check the specific tooltip on each tile for the exact stage shown.',
  },
  margin: {
    title: 'Margin',
    description: 'Revenue minus costs: your profit on AI usage.',
  },
  unitCost: {
    title: 'Unit Cost',
    description:
      'Your internal cost to deliver one unit of a metric. Used for margin calculations.',
  },
  unitPrice: {
    title: 'Unit Price',
    description: 'The default price charged to customers per unit of a metric.',
  },
  usageCharge: {
    title: 'Usage Charge',
    description:
      'The calculated charge for a specific usage event (quantity × pricing rules).',
  },
  volumeBased: {
    title: 'Volume-Based',
    description:
      'A metric type that charges for every action, regardless of the result. Example: API calls, file uploads.',
  },
  usageBased: {
    title: 'Usage-Based',
    description:
      'A metric type that only charges for successful outcomes. Example: completed tasks, resolved tickets.',
  },

  // ============================================
  // CUSTOMER FORM FIELDS
  // ============================================
  externalId: {
    title: 'External ID',
    description: 'The unique ID for this customer.',
  },
  customerStatus: {
    title: 'Status',
    description:
      'Active = currently billable. Inactive = paused, no new charges. Suspended = blocked from all activity.',
  },
  billingContact: {
    title: 'Billing Contact',
    description:
      'The person who receives invoices. Can be different from the main contact — useful when accounting handles payments.',
  },
  netTerms: {
    title: 'Net Terms',
    description:
      'How many days the customer has to pay after receiving an invoice. Default is 30 (Net 30).',
  },

  // ============================================
  // AGENT FIELDS
  // ============================================
  agentCode: {
    title: 'Agent Code',
    description:
      'A unique short identifier used in your SDK to send usage events for this agent. Use something readable like "doc-analyzer" or "support-bot".',
  },
  metricsCount: {
    title: 'Metrics',
    description:
      'The number of billable activities defined for this agent. Each metric tracks a different thing the agent does.',
  },
  activePlans: {
    title: 'Active Plans',
    description:
      'How many pricing plans are currently turned on for this agent. Customers subscribe to a plan to start getting billed.',
  },

  // ============================================
  // SUBSCRIPTION FIELDS
  // ============================================
  billingCycle: {
    title: 'Billing Cycle',
    description:
      'How often invoices are generated. Monthly = every month, Yearly = once a year, Custom = a specific number of days you define.',
  },
  billingModel: {
    title: 'Billing Model',
    description:
      'Subscription = fixed recurring fee. Usage = pay only for what you use. Hybrid = a fixed fee plus usage charges on top.',
  },
  billingDay: {
    title: 'Billing Day',
    description:
      'The day of the month (1–31) when the billing cycle resets and a new invoice is generated.',
  },
  subscriptionStatus: {
    title: 'Status',
    description:
      'Active = currently running. Canceled = stopped by the user. Expired = past the end date. Pending = not yet started.',
  },

  // ============================================
  // EVENT DETAILS
  // ============================================
  eventId: {
    title: 'Event ID',
    description:
      "A unique identifier for this usage event. Also acts as an idempotency key — if the same event is sent twice, it won't be processed again.",
  },
  usageDate: {
    title: 'Usage Date',
    description:
      'When the usage actually happened — not when the event was received or processed by the system.',
  },
  eventProcessed: {
    title: 'Processing Status',
    description:
      'PENDING = waiting to be processed. PROCESSED = cost has been calculated. ERROR = something went wrong during processing.',
  },

  // ============================================
  // PRICING CONFIGURE SECTIONS
  // ============================================
  setupFee: {
    title: 'Setup Fee',
    description:
      'A one-time charge when the subscription first starts. Only billed once, not recurring.',
  },
  platformFee: {
    title: 'Platform Fee',
    description:
      'A fixed recurring charge that applies every billing cycle, independent of usage.',
  },
  seatBasedPricing: {
    title: 'Seat-Based Pricing',
    description:
      'Charges based on the number of users or licenses. Can be flat rate per seat or tiered (volume discounts).',
  },
  activityBased: {
    title: 'Usage-Based',
    description:
      'Charges for every event, whether or not it produced a result. Good for API calls, file uploads, and attempts.',
  },
  outcomeBased: {
    title: 'Outcome-Based',
    description:
      'Charges only when the work produced a result. Good for deals closed, tickets resolved, and meetings booked.',
  },
  minimumCommitment: {
    title: 'Minimum Commitment',
    description:
      'The minimum amount billed per period, even if actual usage is lower. Guarantees a baseline revenue.',
  },

  // ============================================
  // REVENUE SIMULATOR
  // ============================================
  revenueSimulator: {
    title: 'Revenue Simulator',
    description:
      "A what-if calculator. Pick a pricing plan, enter how many events you expect, and see what you'd charge and what you'd keep.",
  },
  firstInvoice: {
    title: 'First Invoice',
    description:
      'What the customer pays on their first bill. Includes one-time setup fees plus the first month of recurring and usage charges.',
  },
  recurringMonthly: {
    title: 'Recurring Monthly',
    description:
      'What the customer pays every month after the first invoice. Does not include one-time setup fees.',
  },
  annualTotal: {
    title: 'Annual Total',
    description:
      'One-time fees plus 12 months of recurring charges. Your projected yearly revenue from this customer.',
  },
  revenueDistribution: {
    title: 'Revenue Distribution',
    description:
      'How your revenue breaks down by charge type: setup fees, recurring fees, usage charges, and seat-based charges.',
  },
  revenueByEvent: {
    title: 'Revenue by Event',
    description:
      'How much revenue each event type generates based on your projected volume and pricing.',
  },
  chargeBreakdown: {
    title: 'Charge Breakdown',
    description:
      "Line-by-line detail of every charge. Shows what you'd bill the customer, what it costs you to deliver, and your margin on each item.",
  },
  projectedEvents: {
    title: 'Projected Events',
    description:
      'Enter how many of each event you expect per month. The simulator uses these numbers with your pricing plan to calculate revenue.',
  },
  timeSeriesEarnedScope: {
    title: 'Earned (daily activity)',
    description:
      'What your agents earned each day from actual events. Events only, sized by how many ran and what they were priced at.',
    details:
      'Subscription fees, seat fees, and one-time setup fees show up on invoices, not here. The Revenue by Type card splits those out across the window.',
  },

  // Subscription-detail Metric-Level Breakdown table. Per-signal rows are
  // canon R1 (Agent-Earned: events × pricing rate, per pricing_strategies
  // .signalId). The synthetic "Subscription fees" row at the bottom of
  // the same column carries the R2 sub-level non-usage revenue so rows
  // sum to the tile's canon Revenue.
  metricBreakdownEarned: {
    title: 'Earned (this cycle)',
    description:
      "Each metric's earnings: how many events fired times your pricing rate. Updates in real time — no need to wait for an invoice.",
    details:
      'The "Subscription fees" row at the bottom carries recurring, seat, and one-time fees so the rows add up to your Total Revenue tile.',
  },
  metricBreakdownEarnedMargin: {
    title: 'Earned Margin (this cycle)',
    description:
      "Each metric's earnings minus its delivery cost, with the percentage shown beneath the dollar figure.",
    details:
      'Cost comes from your usage events. Shown as "—" when this metric has no earnings yet in this cycle.',
  },

  // ============================================
  // FINOPS CLOSE METRICS
  // ============================================
  closeProgress: {
    title: 'Close Progress',
    description:
      'The share of the 5 month-end close steps completed for this month: usage recorded, GL codes mapped, costs categorized, account-type mismatches fixed, and the month signed off.',
  },
  unmappedGlSignals: {
    title: 'Unmapped Items',
    description:
      "Signals whose cost landed in the journal's Unmapped bucket this month — each one needs a GL code before the journal posts cleanly.",
    details:
      'A categorized signal that books to its category\'s default GL account counts as mapped. Months closed before this metric existed show "—".',
  },
  categorizedShare: {
    title: 'Categorized',
    description:
      "The share of this month's AI cost sitting on a classified signal (COGS, R&D, and so on) — the coverage input to your defensibility score.",
    details: 'Shows "—" for a month with no AI cost.',
  },
  daysToClose: {
    title: 'Days to Close',
    description:
      'Days left until the close deadline — by MarginFront convention, the 5th calendar day after the month ends.',
    details:
      'This deadline is a convention, not a setting you control yet. Shows "—" while the month is still in progress or once it has been closed.',
  },
  categoryDefaultGl: {
    title: 'Default GL booking',
    description:
      "This signal has no GL code of its own, so its cost books to its category's default GL account.",
    details:
      'Assign a specific GL code in AI Accounting Settings if this signal should book somewhere else.',
  },

  // ============================================
  // NEEDS-ATTENTION ALERT TILE
  // ============================================
  needsAttention: {
    title: 'Needs attention',
    description:
      'Problems MarginFront found in your data that can throw your numbers off, like usage booked to the wrong account type or events missing a cost.',
    details:
      'Each line links to the page where you fix it. An empty list means nothing is blocking accurate numbers.',
  },

  // Card titles for the Cost management tab's charts (canon L1: every
  // $-surface title ties to canon terms and carries a tooltip).
  earnedVsTotalRevenueChart: {
    title: 'Earned vs total revenue',
    description:
      'Two bars per product line: Agent-Earned is what usage generated (events times your pricing rate), and Total Revenue adds recurring, seat, and one-time fees on top.',
    details:
      'A big gap between the bars means most of that line\'s revenue comes from fees, not usage. "Product line" here means agent.',
  },
  costByCategoryAndGl: {
    title: 'Cost by category and GL account',
    description:
      'Your AI spend for the period, split two ways: by P&L category (COGS, R&D, and the rest) and by the GL account it books to.',
    details:
      'Spend flagged as unmapped has no GL code yet; assign one on the AI Accounting Settings tab so the journal export lands on the right line.',
  },

  // The FinOps close checklist tile.
  monthEndClose: {
    title: 'Month-end close',
    description:
      'The steps between "the month ended" and "the numbers are final": classify your spend, map it to GL codes, review the journal, then close the month.',
    details:
      'Each step checks itself off as the work gets done. Closing freezes the month so reports stop moving; you can reopen it later if something was booked wrong.',
  },

  // ============================================
  // CREDIT POOLS
  // Every entry teaches BOTH halves of the alignment rule: what the number
  // means AND that nothing stops at zero, plus how to read the same number
  // from code so the dashboard itself points at the API.
  // ============================================
  creditPools: {
    title: 'Credit pools',
    description:
      'Customers on a credit-pool plan buy a block of units up front, and every event they send draws that block down. This is where you watch it count down.',
    details: `Read the same numbers from code with client.creditBalances.list() or GET /v1/credit-balances.${CREDIT_BALANCES_DOCS ? ` Reference: ${CREDIT_BALANCES_DOCS}` : ''}`,
  },
  creditPoolRemaining: {
    title: 'Units left',
    description:
      'How many units this customer can still draw before the pool is empty. Manual top-ups count toward it.',
    details:
      'Nothing stops at zero. The pool is a meter, not a breaker: calls keep working and the overage keeps billing. Same number as remainingUnits in the API.',
  },
  creditPoolUsed: {
    title: 'Units used',
    description:
      'How many units this customer has drawn during the current billing period.',
    details:
      'Resets when the period rolls over. Same number as consumedUnits in the API.',
  },
  creditPoolOverage: {
    title: 'Billing as overage',
    description:
      "Units used past the pool size this period. These are on the bill at the plan's overage rate.",
    details:
      'Top-ups deliberately do NOT reduce this: the invoice bills usage past the pool size, so a topped-up pool can honestly show units left AND overage at the same time. Same number as overageInProgressUnits in the API.',
  },
  creditPoolAlertsPaused: {
    title: 'Alerts paused',
    description:
      "This subscription's credit-pool emails are silenced. Nobody gets a heads-up as the pool drains.",
    details:
      'Pausing changes emails only. The pool keeps counting down and the balance stays visible here and in the API (alertsPaused).',
  },
  creditPoolActions: {
    title: 'Top up or pause',
    description:
      "Top up adds prepaid units your customer bought (or a credit you're giving them). The countdown and alerts update. The invoice doesn't change.",
    details:
      'Pause stops the warning emails for this subscription only; tracking and billing keep running. Top-ups land in the same numbers you read from code: remainingUnits in GET /v1/credit-balances.',
  },
} as const satisfies Record<string, TooltipDefinition>

// ============================================
// ROI PAGE
// ============================================
// Copy that exists nowhere else. A sentence the ROI print or GET
// /api/roi/report also renders is NOT repeated here: report-derivation.ts owns
// that one and spreads it into the hover, so screen, paper and data cannot
// drift. report-derivation.ts composes both halves into ROI_TOOLTIPS.
//
// Earned means the same thing on the ROI page as in tooltipDefinitions above,
// so both read FEES_OUTSIDE_USAGE_REVENUE. events, margin and avgCostPerEvent
// name different numbers here, which roi-tooltip-inventory.test.ts pins one
// by one.
export const roiTooltipCopy = {
  howThisPageWorks: {
    title: 'How this page works',
    description:
      'Opens or closes the three lines that say what we measure and what you tell us.',
  },

  withoutAiHeading: {
    title: 'Without AI',
    description:
      'We measure the with-AI side from real usage. The without-AI side is a number you give us, and it stays labeled as your estimate on this page, in the print and in the data.',
  },
  withAiMeasured: {
    title: 'With AI, measured',
    description:
      "The AI cost we recorded for the counted agents in these dates, from real prices. It's never an estimate.",
  },
  withoutAiEstimate: {
    title: 'Without AI, your estimate',
    description:
      "The number you gave us, worked out by the method named beside it. We can't measure this one, so it's always yours.",
  },
  comparisonCostRow: {
    title: 'the Cost row',
    description:
      'What your AI cost in these dates, next to what you estimate the same work cost without it.',
  },
  comparisonRevenueRow: {
    title: 'the Revenue row',
    description:
      'What the checked agents brought in over these dates, next to what you estimate you would have brought in without AI.',
  },
  comparisonRevenueWithAi: {
    title: 'Revenue with AI',
    description:
      "Every fee the checked agents' subscriptions earned in these dates. It's the same total revenue the What you used AI for table adds up for those agents.",
  },
  comparisonRevenueWithoutAi: {
    title: 'Revenue without AI',
    description:
      "What you told us you'd have brought in a month without AI, pro-rated to these dates. Leave it blank and we assume the same revenue as with AI.",
  },
  comparisonRevenueDifference: {
    title: 'the revenue gap',
    description:
      "How far apart the two revenue numbers are, and what share of the without-AI number that gap is. When you haven't given us a figure we hold the two equal, and this reads About the same.",
  },
  netLine: {
    title: 'the net line',
    description:
      'The cost you saved plus the revenue you gained, as one number. Money lost on either row pulls it down.',
  },
  revenuePerMonthField: {
    title: 'Revenue without AI',
    description:
      "About what you'd have brought in a month without AI. Leave it blank and we assume the same revenue as with AI.",
  },
  comparisonDifference: {
    title: 'Difference',
    description:
      'How far apart the two numbers are, and what share of your estimate that gap is.',
  },
  changeYourNumbers: {
    title: 'Change your numbers',
    description:
      'Opens your without-AI estimate. Changing it moves only the without-AI side, and the measured AI cost never moves.',
  },
  estimateWithoutAi: {
    title: 'Estimate without AI',
    description:
      'Opens the fields where you tell us what this work cost before AI.',
  },
  methodChoice: {
    // Read aloud as "What <title> means", so a plural title turns the label
    // into "What these three methods means".
    title: 'How you want to estimate',
    description:
      'Pick the way you already think about this work: a cost for each one, the people time it took, or one total for the period.',
  },
  closeFields: {
    title: 'Close',
    description: 'Closes these fields and keeps whatever you last saved.',
  },

  agentsHeading: {
    title: 'What you used AI for',
    description:
      'Every agent that recorded usage in these dates, with what it cost and what it earned. The check marks decide which agents the comparison counts.',
  },
  countInComparison: {
    title: 'Count in the comparison',
    description:
      "Checked, this agent's AI cost counts in the Without AI comparison and on the Finished work tab; unchecked, it's left out of both. The tiles under The metrics you care about, and your goals, always count every agent.",
  },
  agentCost: {
    title: 'Cost',
    description:
      "What this agent's usage events cost in these dates, from real prices.",
  },
  revenueBasis: {
    title: 'Earned or Total revenue',
    description:
      'Picks which revenue this table shows for each agent: usage fees only, or every fee on its subscriptions. Margin follows your pick.',
  },
  agentMargin: {
    title: 'Margin',
    description:
      'The revenue column you picked minus Cost, as a percent of that same revenue. A dash means the agent brought in nothing in these dates.',
  },
  showEveryMetric: {
    title: 'Show every metric',
    description:
      "Opens the rest of the metrics. Six of them each cost a slower read, so the page doesn't wait on them to paint.",
  },
  seeExample: {
    title: 'See an example',
    description:
      'Shows the same number written out as a sentence, so you can check it reads the way you expect.',
  },

  finishedHeading: {
    title: 'What you finished',
    description:
      'Things your team recorded as finished, plus the named signals your integrations send, each with the AI cost beside it.',
  },
  finishedName: {
    title: 'the What you finished column',
    description:
      'The name your team gave it when they recorded it, or the signal name your integration sends.',
  },
  finishedHowMany: {
    title: 'How many',
    description: 'How many times that name was recorded in these dates.',
  },
  finishedCostForOne: {
    title: 'Cost for one',
    description: 'AI cost divided by How many.',
  },
  finishedTotalsMeasured: {
    title: 'Measured',
    description:
      'Every costed row in this table was counted and priced from the events themselves, so this total is too.',
  },
  finishedTotalsAttributed: {
    title: 'Attributed',
    description:
      'This row sums every row in this table, so it can blend money we measured with shares we worked out. It reads attributed because the less certain half decides.',
  },
  sourceMeasured: {
    title: 'Measured',
    description:
      'We counted and priced this row from the events themselves. Nothing here is a share or an estimate.',
  },
  sourceAttributed: {
    title: 'Attributed',
    description:
      "A share of spend we did measure, split by count across what was finished. It isn't a price anyone recorded.",
  },
  sourceAttributedShared: {
    title: 'Attributed, shared',
    description:
      "A share of spend we did measure, split by count across what was finished. This row's cost was also split with other things finished on the same work item.",
  },

  goalsHeading: {
    title: 'Your goals',
    description:
      'Targets you set for one metric over dates you choose. Each card measures its own dates, not the dates you picked for this report.',
  },
  goalProgress: {
    title: 'this percent',
    description:
      "On a goal whose number adds up over its dates, like revenue or spend, it's the running total divided by the target. On a goal whose number is a level you hold, like margin percent or average cost, it's how far the number has traveled from where it started toward the target.",
  },
  goalHealthOnTrack: {
    title: 'On track',
    description:
      "A spending cap on this goal is on pace while it's no more than ten points further through its limit than through its dates, and never once it's over the limit; every other target is on pace while it's no more than ten points behind the share of its dates that have gone by. A goal with no end date has no pace to keep, so it stays on track unless a spending cap on it has already gone over the limit.",
  },
  goalHealthAtRisk: {
    title: 'At risk',
    description:
      'One target on this goal is off its pace: a spending cap more than ten points further through its limit than through its dates, or over the limit outright; any other target more than ten points behind the share of its dates that have gone by.',
  },
  goalHealthAchieved: {
    title: 'Achieved',
    description: 'Every target on this goal is met.',
  },
  goalHealthNotStarted: {
    title: 'Not started',
    description: "This goal's start date hasn't arrived yet.",
  },
  goalHealthNoData: {
    title: 'No data yet',
    description:
      "This goal has no target we can measure yet, so there's no progress to show.",
  },
  goalHealthArchived: {
    title: 'Archived',
    description:
      "This goal is archived, so it stopped computing actuals. Unarchive it from the card's menu and it starts again.",
  },
  newGoal: {
    title: 'New goal',
    description:
      'Opens the form where you name a goal, pick a metric and set a target.',
  },
  showArchived: {
    title: 'Show archived',
    description: 'Shows the goals you archived beside the active ones.',
  },
} as const satisfies Record<string, TooltipDefinition>

/**
 * The extra line an ROI metric tile's hover adds under the metric's own
 * sentence. The sentence itself is METRIC_DESCRIPTIONS in report-derivation.ts,
 * which the print and GET /api/roi/report render too.
 */
export const roiMetricTileDetails = {
  everyAgent: 'Every agent, checked or not.',
  marginPercent: 'Margin divided by Revenue.',
} as const
