#!/usr/bin/env bash

# ============================================================================
# Canonical Audit
# ============================================================================
#
# What this does:
#   Greps every NestJS API module for hand-rolled revenue/cost/margin math
#   that should route through the canonical @marginfront/db library. If it finds
#   anything, it prints file:line:snippet and exits non-zero. Run it before
#   opening a pull request that touches revenue, cost or margin code.
#
# What the check catches (canon rule ids such as I2 or C1 refer to
# packages/db/CANON.md):
#   R1. Direct Prisma aggregates on invoice totalAmount (bypasses canon I2).
#   R2. Signal-event aggregates in revenue/cost paths (bypasses canon C1).
#   R3. billingPeriodStart/End WHERE clauses on invoice queries (canon I3
#       violation; invoiceDate is the correct field).
#   R4. Unguarded margin percent math. `(x - y) / x * 100` without the
#       safeMarginPercent helper (canon M1 violation; undefined when x === 0).
#   R5. The placeholder MRR formula `activeSubscriptions * 100` (canon MRR1
#       violation; MRR is the contracted monthly recurring revenue of active
#       subscriptions, not a subscription count multiplied by an arbitrary rate).
#   R7. Invoice-line-item sums in revenue totals context (bypasses canon I1).
#   R8. Hand-rolled invoice.amountPaid / amountDue arithmetic outside the
#       payment reconciler and refund finalizer.
#   R9. signal_events groupBy with _sum usageCost outside the canonical library.
#   R10. `const unitCost = 0` hardcode in simulator/calculator paths, the
#        fake-margin anti-pattern (revenue minus a fabricated zero cost).
#        Simulators are revenue-only; real cost comes from canon cost metrics.
#   R11. Prisma @map("<hyphenated>") on an enum value in schema.prisma.
#
# What the check does NOT catch:
#   - Subtle logic bugs inside canonical helpers (unit tests do that).
#   - N+1 patterns. That's a performance concern, not a correctness one.
#   - Cross-file patterns where the math is split between a helper and a
#     caller. You still need code review for those.
#
# How to run:
#   bash scripts/canonical-audit.sh
#
# Exits with code 0 on clean, 1 on any forbidden-pattern hit.
# ============================================================================

set -uo pipefail

# ----------------------------------------------------------------------------
# Colors. Disabled when piping or when NO_COLOR is set.
# ----------------------------------------------------------------------------
if [[ -n "${NO_COLOR:-}" ]] || [[ ! -t 1 ]]; then
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_RESET=''
else
  C_RED=$'\033[0;31m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[0;33m'
  C_RESET=$'\033[0m'
fi

# ----------------------------------------------------------------------------
# Scope: only the api-nest source tree. The canonical library + tests
# intentionally use raw Prisma. They are the source of truth, not consumers.
# Also exclude .spec.ts files (tests use mock prisma aggregates deliberately
# to recompute expected values for parity assertions).
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SEARCH_ROOT="$REPO_ROOT/apps/api-nest/src/modules"

# Output state. `hits` accumulates all findings; we print at the end so the
# user sees a full report instead of a first-failure bail.
hits=0

# ----------------------------------------------------------------------------
# Helper: run a grep across api-nest modules, skipping the revenue-metrics
# service + spec files (which are allowed to reference these patterns). The
# first arg is the pattern, the second is the human-readable explanation.
# An optional third arg provides an additional --exclude glob so individual
# rules can allow-list files where the pattern is legitimate (R2 uses it for
# cost-control.service.ts).
# ----------------------------------------------------------------------------
check_pattern() {
  local pattern="$1"
  local description="$2"
  local extra_exclude="${3:-}"

  # --include filters, --exclude filters, and the paths we're scanning.
  # grep -rE so we support extended regex with pipes. --line-number for
  # file:line output. --with-filename explicit so single-file runs still
  # show the path.
  local result
  if [[ -n "$extra_exclude" ]]; then
    result=$(grep -rnE \
      --include="*.ts" \
      --exclude="*.spec.ts" \
      --exclude="revenue-metrics.service.ts" \
      --exclude-dir="dto" \
      --exclude="$extra_exclude" \
      "$pattern" \
      "$SEARCH_ROOT" 2>/dev/null || true)
  else
    result=$(grep -rnE \
      --include="*.ts" \
      --exclude="*.spec.ts" \
      --exclude="revenue-metrics.service.ts" \
      --exclude-dir="dto" \
      "$pattern" \
      "$SEARCH_ROOT" 2>/dev/null || true)
  fi

  if [[ -n "$result" ]]; then
    local count
    count=$(printf '%s\n' "$result" | wc -l | tr -d ' ')
    hits=$((hits + count))
    printf '%s\n' "${C_RED}FAIL${C_RESET} $description"
    printf '  %d hit(s):\n' "$count"
    printf '%s\n' "$result" | sed 's/^/    /'
    echo ''
  else
    printf '%s\n' "${C_GREEN}PASS${C_RESET} $description"
  fi
}

# ----------------------------------------------------------------------------
# Helper: like check_pattern, but takes TWO --exclude allow-list globs. Used
# by R8, which must permit the canonical InvoicePaymentReconciler AND
# InvoiceRefundFinalizer (both legitimately do the invoice.amountPaid /
# amountDue arithmetic that the rule forbids elsewhere).
# ----------------------------------------------------------------------------
check_pattern_two_exclude() {
  local pattern="$1"
  local description="$2"
  local exclude_a="$3"
  local exclude_b="$4"

  local result
  result=$(grep -rnE \
    --include="*.ts" \
    --exclude="*.spec.ts" \
    --exclude="revenue-metrics.service.ts" \
    --exclude-dir="dto" \
    --exclude="$exclude_a" \
    --exclude="$exclude_b" \
    "$pattern" \
    "$SEARCH_ROOT" 2>/dev/null || true)

  if [[ -n "$result" ]]; then
    local count
    count=$(printf '%s\n' "$result" | wc -l | tr -d ' ')
    hits=$((hits + count))
    printf '%s\n' "${C_RED}FAIL${C_RESET} $description"
    printf '  %d hit(s):\n' "$count"
    printf '%s\n' "$result" | sed 's/^/    /'
    echo ''
  else
    printf '%s\n' "${C_GREEN}PASS${C_RESET} $description"
  fi
}

# ============================================================================
# Rule set
# ============================================================================

printf '%s\n' "${C_YELLOW}Canonical Audit${C_RESET}"
printf 'Scanning %s\n\n' "$SEARCH_ROOT"

# R1: Direct invoice totalAmount aggregates in a revenue path. Using
# `prisma.invoices.aggregate({ _sum: { totalAmount } })` bypasses canon I2
# (which excludes draft, uses invoiceDate window) and canon I3 (invoiceDate
# field). The canonical replacement is `canonGetInvoiceTotals`.
check_pattern \
  'prisma\.invoices\.aggregate.*' \
  'R1: prisma.invoices.aggregate is forbidden (use canonGetInvoiceTotals)'

# R2: Event-level SUM without going through canonical library. Signal-event
# aggregates in a revenue / cost path bypass canon C1 (null usageCost
# handling, organizationId filter, usageDate window). Canonical replacement:
# canonGetCostMetrics.
#
# Allow-list: cost-control.service.ts. Its aggregate sums INTERNAL coding-agent
# spend for cap alerts (cccInternalEventFilter, cap-policy.ts), not a customer
# cost path. canonGetCostMetrics measures customer cost metrics and has no
# internal-spend mode, so canon is the wrong tool there by design.
check_pattern \
  'prisma\.signal_events\.aggregate' \
  'R2: prisma.signal_events.aggregate is forbidden (use canonGetCostMetrics)' \
  'cost-control.service.ts'

# R3: billingPeriodStart / billingPeriodEnd in invoice WHERE clauses. Canon
# I3 says invoiceDate is the filter field. Using the billing-period columns
# of the invoice misses invoices whose billing period overlaps the window
# but whose invoiceDate is outside, and includes invoices invoiced-in-window
# whose period is elsewhere.
check_pattern \
  '(where|WHERE).*billingPeriod(Start|End)' \
  'R3: billingPeriodStart/End in invoice WHERE is forbidden (canon I3: use invoiceDate)'

# R4: Unguarded margin percent math. Canon M1 requires marginPercent to be
# null when revenue === 0. The `revenue > 0 ? formula : 0` pattern
# produces a misleading "0% margin" for zero-revenue rows. Replacement:
# safeMarginPercent(revenue, margin).
check_pattern \
  '(revenue|calculatedRevenue)[[:space:]]*>[[:space:]]*0[[:space:]]*\?[[:space:]]*\(.*(revenue|calculatedRevenue).*(cost|totalCost).*\).*\*[[:space:]]*100' \
  'R4: unguarded margin percent ternary is forbidden (canon M1: use safeMarginPercent)'

# R5: The placeholder MRR formula `activeSubscriptions * 100`. Canonical
# MRR1: contracted monthly recurring revenue of active subscriptions, today.
check_pattern \
  'activeSubscriptions[[:space:]]*\*[[:space:]]*100' \
  'R5: activeSubscriptions * 100 placeholder MRR is forbidden (canon MRR1: use canonGetMrr)'

# R7: invoice_line_items aggregates in revenue totals context. Canon I1
# reconciliation says non-draft invoice totals derive from line items by
# construction. Callers don't re-sum line items to get revenue; they read
# invoice.totalAmount (which is the reconciled total).
check_pattern \
  'prisma\.invoice_line_items\.aggregate' \
  'R7: invoice_line_items.aggregate is forbidden in revenue totals (use invoice.totalAmount)'

# R8: Hand-rolled invoice.amountPaid / amountDue arithmetic. The
# InvoicePaymentReconciler + InvoiceRefundFinalizer are the ONLY writers of
# these fields. A parseFloat-plus-arithmetic on invoice.amountPaid or
# invoice.amountDue in consumer code races on concurrent payments AND
# bypasses the transactional state machine. Every new payment or refund must
# route through the canonical service pair.
#
# The rule detects parseFloat(invoice.amountPaid|amountDue ...) followed on
# the same line by a `+` or `-` arithmetic operator, as in
# `newAmountPaid = parseFloat(x) + paymentAmount`. It intentionally does NOT catch read-only casts like
# `parseFloat(invoice.amountPaid.toString())` used for display serialization,
# because those do no arithmetic and don't participate in any state update.
#
# Allow-list: the two canonical service files where this math legitimately
# lives (they are the authoritative writers).
check_pattern_two_exclude \
  'parseFloat\([^)]*invoice\.amount(Paid|Due)[^)]*\)[[:space:]]*[+\-]' \
  'R8: invoice.amountPaid/amountDue parseFloat arithmetic is forbidden outside Reconciler/Finalizer' \
  'invoice-payment-reconciler.service.ts' \
  'invoice-refund-finalizer.service.ts'

# R9: signal_events groupBy with _sum usageCost outside the canonical library.
# The customer-facing cost path routes through canonGetCostMetrics.
# Direct signal_events.groupBy({ _sum: { usageCost } }) bypasses canon C1
# (null-cost handling, per-day + per-plan + per-model breakdowns, trend
# window composition). The canonical library is the ONLY monetary aggregator.
#
# Non-monetary quantity aggregates (_sum: { quantity }) are allowed and NOT
# matched by this rule: R9 is scoped specifically to `usageCost` inside the
# groupBy call. getUsageSummary in portal-api.service.ts uses this pattern
# legitimately to surface per-signal unit counts.
check_pattern \
  'prisma\.signal_events\.groupBy\([^)]*_sum[^)]*usageCost' \
  'R9: signal_events.groupBy with _sum usageCost is forbidden (use canonGetCostMetrics)'

# R10: Fake-margin anti-pattern. A hardcoded `unitCost = 0` in a simulator
# or calculator path fabricates margin numbers (unitCost × quantity
# → costAmount → revenue - costAmount = marginAmount). The simulator is
# revenue-only. Any surface that needs real cost must read
# signal_events.usageCost via canonical getCostMetrics, not invent a zero.
# The check covers invoice-calculator and every other simulator path.
check_pattern \
  'const[[:space:]]+unitCost[[:space:]]*=[[:space:]]*0' \
  'R10: hardcoded unitCost = 0 is forbidden in revenue simulators (use canonical getCostMetrics for real cost)'

# R11: Prisma @map directives on enum values with hyphens. Any
# @map("<hyphenated>") on an enum value creates a dual-form footgun:
# Prisma's TS client expects the identifier form (underscore) but the DB
# stores the hyphen, and consumers will silently compare the wrong value.
# Rule scope is the schema file only. Non-enum @map on table / column names
# is allowed (those are DB naming conventions, not value-level aliasing).
schema_hits=$(grep -nE '@map\("[^"]*-[^"]*"\)' "$REPO_ROOT/packages/db/prisma/schema.prisma" 2>/dev/null || true)
# Strip out lines whose @map is attached to a model or field declaration
# (e.g., `@@map("table_name")` or `field Type @map("db_column_name")`). The
# footgun only applies to enum value declarations.
schema_enum_hits=$(printf '%s\n' "$schema_hits" | grep -vE '(@@map|[a-zA-Z]+[[:space:]]+[A-Z][a-zA-Z]+)' || true)
if [[ -n "$schema_enum_hits" ]]; then
  count=$(printf '%s\n' "$schema_enum_hits" | wc -l | tr -d ' ')
  hits=$((hits + count))
  printf '%s\n' "${C_RED}FAIL${C_RESET} R11: @map("<hyphenated>") on enum value is forbidden (dual-form footgun)"
  printf '  %d hit(s):\n' "$count"
  printf '%s\n' "$schema_enum_hits" | sed 's/^/    /'
  echo ''
else
  printf '%s\n' "${C_GREEN}PASS${C_RESET} R11: @map(\"<hyphenated>\") on enum value is forbidden (dual-form footgun)"
fi

# ============================================================================
# Report
# ============================================================================
printf '\n'
if [[ $hits -eq 0 ]]; then
  printf '%s\n' "${C_GREEN}All checks passed.${C_RESET} Canonical discipline intact."
  exit 0
else
  printf '%s\n' "${C_RED}${hits} forbidden-pattern hit(s).${C_RESET}"
  printf 'Route the offending callsites through @marginfront/db canonical library\n'
  printf '(getRevenueMetrics, getCostMetrics, getInvoiceTotals, getMrr, safeMarginPercent)\n'
  printf 'before merging.\n'
  exit 1
fi
