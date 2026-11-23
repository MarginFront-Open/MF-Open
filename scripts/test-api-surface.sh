#!/usr/bin/env bash

# ============================================================================
# MarginFront API Surface Test Script
# ============================================================================
#
# What this does:
#   Pretends to be a real MarginFront customer. Runs end-to-end tests against
#   the unified public API: creates a customer, agent, signal, pricing plan,
#   subscription; logs a usage event; reads everything back; cleans up.
#
#   Three test phases:
#     Canonical /v1/<resource> URLs with the SECRET key
#     Alias paths (/v1/sdk/* and /v1/org/:orgId/*)
#     PUBLISHABLE key permission enforcement (write must be rejected)
#
# Why it exists:
#   It checks end to end that every admin endpoint accepts API-key auth and
#   that the URL shape holds. Run it after any refactor of the API routes.
#
# How to use it:
#   1. Open a terminal in the project root.
#   2. Make sure the API server is running (cd apps/api-nest && npm run dev).
#      The script will check and tell you what to do if it isn't.
#   3. Put your credentials in scripts/.env.local (created once, reused forever):
#        MF_API_SECRET_KEY=mf_sk_test_...
#        MF_API_PUBLISHABLE_KEY=mf_pk_test_...
#      That file is gitignored (matched by .env*.local in .gitignore), so your
#      keys stay out of git.
#   4. Run the script:
#        bash scripts/test-api-surface.sh
#
# What you'll see:
#   Green ✓ for each test that passes, red ✗ for any that fail. On failure,
#   the script prints the actual server error and stops. Test records are
#   left behind in the database so you can inspect them in Prisma Studio.
#   On success, everything the script created is deleted and you get a clean
#   "all green" summary.
#
# Safety:
#   - Defaults to http://localhost:4000 (your local API, never production).
#   - API keys are never written to logs, never echoed, never passed on the
#     command line. They live only in process memory and HTTP headers.
#   - All curl calls are silent (`curl -s`). No command echoing, no verbose
#     output that could leak a key on failure.
#   - If MF_API_BASE_URL points anywhere other than localhost, the
#     script pauses and requires you to type "yes-production" before running.
#
# URL shape:
#   - Canonical URLs live under /v1/<resource> (no /sdk/, no orgId path).
#   - The API key alone identifies your organization. No MF_ORG_ID needed.
#   - The /v1/sdk/* and /v1/org/:orgId/* paths work as aliases, and
#     Phase 2 below smoke-tests that.
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# Load credentials from scripts/.env.local if it exists. See header for format.
# Nothing from the file is ever printed to stdout. Keys live only in process
# memory and HTTP headers.
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env.local"
  set +a
fi

# ----------------------------------------------------------------------------
# Colors. Set NO_COLOR=1 to disable.
# ----------------------------------------------------------------------------
if [[ -n "${NO_COLOR:-}" ]] || [[ ! -t 1 ]]; then
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_RESET=''
else
  C_RED=$'\033[0;31m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
fi

# ----------------------------------------------------------------------------
# Counters and state.
# ----------------------------------------------------------------------------
PASS=0
FAIL=0
FAILED_TESTS=()

TS="$(date +%Y%m%d-%H%M%S)"

TMP_DIR="$(mktemp -d -t mf-api-test.XXXXXX)"
LAST_RESPONSE="$TMP_DIR/last_response.json"
LAST_STATUS="$TMP_DIR/last_status.txt"

ADMIN_CUSTOMER_ID=""
ADMIN_AGENT_ID=""
ADMIN_SIGNAL_ID=""
ADMIN_PLAN_ID=""
ADMIN_STRATEGY_ID=""
ADMIN_SUBSCRIPTION_ID=""
SDK_CUSTOMER_ID=""

CUSTOMER_EXTERNAL_ID="test-customer-$TS"
AGENT_CODE="test-agent-$TS"
SIGNAL_NAME="test-signal-$TS"

# Honors SKIP_CLEANUP env var. Set SKIP_CLEANUP=1 before running to keep
# test records in the DB after a successful run (useful for manual
# verification in the dashboard or Prisma Studio).
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

# The key the run_test helper currently uses. Switched between phases.
MF_CURRENT_KEY=""

# Derived at runtime from /v1/verify. Used only in the Phase 2 alias-path
# tests, since the canonical API doesn't need orgId at all.
MF_ORG_ID_DERIVED=""

# ----------------------------------------------------------------------------
# Print helpers.
# ----------------------------------------------------------------------------
print_section() {
  echo ""
  echo "${C_BLUE}━━━ $1 ━━━${C_RESET}"
}

print_info() {
  echo "${C_DIM}$1${C_RESET}"
}

print_pass() {
  local name="$1"
  local detail="$2"
  echo "  ${C_GREEN}✓${C_RESET} $name  ${C_DIM}$detail${C_RESET}"
}

print_fail() {
  local name="$1"
  local detail="$2"
  echo "  ${C_RED}✗${C_RESET} $name  ${C_DIM}$detail${C_RESET}"
}

# ----------------------------------------------------------------------------
# Sanity checks.
# ----------------------------------------------------------------------------

check_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    cat >&2 <<EOF
${C_RED}ERROR:${C_RESET} This script needs 'jq' (a JSON parser) and it's not installed.

What to do:
  1. Run this command in your terminal:
       brew install jq
  2. Wait for it to finish (takes about 30 seconds).
  3. Run this script again.

EOF
    exit 1
  fi
}

check_env_vars() {
  if [[ -z "${MF_API_SECRET_KEY:-}" ]]; then
    cat >&2 <<EOF
${C_RED}ERROR:${C_RESET} MF_API_SECRET_KEY is not set.

What this is:
  Your MarginFront SECRET API key (starts with mf_sk_). The script uses this
  for all Phase 1 and Phase 2 tests.

What to do (easiest — set it once and forget it):
  1. Open http://localhost:3000 in your browser.
  2. Go to: Developer Zone → API Keys
  3. Copy an existing secret key, or create one if the list is empty.
  4. Open or create the file scripts/.env.local and paste these two lines
     (replace the placeholders with your real keys):
       MF_API_SECRET_KEY=mf_sk_test_your_real_secret_key
       MF_API_PUBLISHABLE_KEY=mf_pk_test_your_real_publishable_key
     That file is already gitignored — it will NEVER be committed.
  5. Run this script again.

EOF
    exit 1
  fi

  if [[ -z "${MF_API_PUBLISHABLE_KEY:-}" ]]; then
    print_info "  (MF_API_PUBLISHABLE_KEY not set — Phase 3 publishable-key tests will be skipped)"
  fi
}

# ----------------------------------------------------------------------------
# Confirm target. Localhost proceeds silently. Production requires an explicit
# confirmation phrase.
# ----------------------------------------------------------------------------
confirm_target() {
  if [[ "$MF_API_BASE_URL" =~ localhost|127\.0\.0\.1 ]]; then
    return 0
  fi

  cat >&2 <<EOF
${C_YELLOW}⚠️  You are pointing at a non-local server:${C_RESET}
   $MF_API_BASE_URL

This script creates and deletes real records. If this is your production
API, a mistake here could pollute real customer data.

To continue, type the phrase:  yes-production
Anything else will abort.

EOF
  read -r answer
  if [[ "$answer" != "yes-production" ]]; then
    echo "${C_RED}Aborted.${C_RESET}" >&2
    exit 1
  fi
}

# ----------------------------------------------------------------------------
# Check that the API is reachable. If not, print step-by-step instructions.
# ----------------------------------------------------------------------------
check_api_running() {
  local url="$MF_API_BASE_URL/v1/verify"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 5 \
    -H "x-api-key: $MF_API_SECRET_KEY" \
    "$url" || echo "000")

  if [[ "$status" == "000" ]]; then
    cat >&2 <<EOF
${C_RED}The API server isn't responding at $MF_API_BASE_URL${C_RESET}

Is it running? Here's how to start it:

  1. Open a new terminal window (not this one — keep this one open).
  2. Paste this command and press Enter:
       cd <repo-root>/apps/api-nest && npm run dev
  3. Wait until you see:
       "Application is running on: http://localhost:4000"
     (takes about 15-20 seconds)
  4. Come back to this terminal and press Enter to continue.

EOF
    read -r _
    check_api_running
    return
  fi

  if [[ "$status" == "401" ]] || [[ "$status" == "403" ]]; then
    cat >&2 <<EOF
${C_RED}The API rejected your secret key (HTTP $status).${C_RESET}

What this means:
  The server is running, but MF_API_SECRET_KEY is either wrong or belongs
  to a different environment.

What to do:
  1. Double-check your secret key in the dashboard:
       http://localhost:3000 → Developer Zone → API Keys
  2. Copy a fresh key and update scripts/.env.local
  3. Run this script again.

EOF
    exit 1
  fi

  if [[ "$status" != "200" ]]; then
    echo "${C_RED}Unexpected response from /v1/verify: HTTP $status${C_RESET}" >&2
    exit 1
  fi
}

# ----------------------------------------------------------------------------
# Derive organization ID from the API key by calling /v1/verify.
# Only used by the Phase 2 alias-path tests (the canonical API doesn't need
# orgId at all; the key alone identifies the org).
# ----------------------------------------------------------------------------
derive_org_id() {
  local body
  body=$(curl -s --max-time 5 \
    -H "x-api-key: $MF_API_SECRET_KEY" \
    "$MF_API_BASE_URL/v1/verify" || echo "")
  MF_ORG_ID_DERIVED=$(echo "$body" | jq -r '.organization.id // .organizationId // empty' 2>/dev/null || echo "")

  if [[ -z "$MF_ORG_ID_DERIVED" ]]; then
    echo "${C_RED}Could not derive organization ID from /v1/verify response.${C_RESET}" >&2
    echo "${C_DIM}Response body: $body${C_RESET}" >&2
    exit 1
  fi
}

# ----------------------------------------------------------------------------
# The main workhorse. Every test flows through this function.
#
# Arguments:
#   $1 = human-readable test name
#   $2 = HTTP method (GET, POST, PATCH, DELETE)
#   $3 = URL path (starts with /v1/...)
#   $4 = expected HTTP status code (or pipe-separated list like "401|403")
#   $5 = (optional) JSON request body
#
# Uses $MF_CURRENT_KEY as the x-api-key header. Set this before each phase.
# ----------------------------------------------------------------------------
run_test() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected="$4"
  local body="${5:-}"

  local url="$MF_API_BASE_URL$path"
  local status

  if [[ -n "$body" ]]; then
    status=$(curl -s -o "$LAST_RESPONSE" -w "%{http_code}" \
      -X "$method" "$url" \
      -H "x-api-key: $MF_CURRENT_KEY" \
      -H "Content-Type: application/json" \
      -d "$body" || echo "000")
  else
    status=$(curl -s -o "$LAST_RESPONSE" -w "%{http_code}" \
      -X "$method" "$url" \
      -H "x-api-key: $MF_CURRENT_KEY" || echo "000")
  fi

  echo "$status" > "$LAST_STATUS"

  # Check if status matches expected. Expected can be a single code or a
  # pipe-separated list of acceptable codes.
  if [[ "|$expected|" == *"|$status|"* ]]; then
    print_pass "$name" "($status)"
    PASS=$((PASS + 1))
    return 0
  fi

  # Failure path.
  print_fail "$name" "(expected $expected, got $status)"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("$name")
  SKIP_CLEANUP=1

  echo ""
  echo "  ${C_YELLOW}What happened:${C_RESET} $method $path returned HTTP $status"
  echo "  ${C_YELLOW}Response body:${C_RESET}"
  if [[ -s "$LAST_RESPONSE" ]]; then
    if jq . < "$LAST_RESPONSE" >/dev/null 2>&1; then
      jq . < "$LAST_RESPONSE" | sed 's/^/    /'
    else
      sed 's/^/    /' < "$LAST_RESPONSE"
    fi
  else
    echo "    (empty)"
  fi
  echo ""
  print_leftover_records
  echo ""
  echo "${C_RED}Stopping before cascading errors make the output unreadable.${C_RESET}"
  echo "${C_DIM}Re-run the script after you fix the issue. Leftover test data is in your database for inspection.${C_RESET}"
  exit 1
}

# ----------------------------------------------------------------------------
# Extract an ID from the last response.
# ----------------------------------------------------------------------------
last_id() {
  local key="${1:-id}"
  jq -r ".$key // empty" < "$LAST_RESPONSE"
}

# ----------------------------------------------------------------------------
# Assert something about the response body of the last request.
#
# Arguments:
#   $1 = human-readable description of what we're checking
#   $2 = a jq expression that returns true/false (use `jq -e` semantics)
#
# Use this AFTER run_test to verify that the response body actually contains
# what you expected, not only that the status code was right. Essential for
# ingestion-pipeline checks where a 200 response doesn't guarantee the data
# actually landed in the DB.
#
# Example:
#   run_test "Log usage event" POST /v1/usage/record 200 "$body"
#   assert_jq "event was accepted" '.successful == 1'
#   assert_jq "zero failures"      '.failed == 0'
# ----------------------------------------------------------------------------
assert_jq() {
  local description="$1"
  local jq_expr="$2"

  if jq -e "$jq_expr" < "$LAST_RESPONSE" >/dev/null 2>&1; then
    print_pass "  → $description" ""
    PASS=$((PASS + 1))
    return 0
  fi

  # Assertion failure counts as a test failure.
  print_fail "  → $description" "(assertion did not hold)"
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("$description")
  SKIP_CLEANUP=1

  echo ""
  echo "  ${C_YELLOW}Assertion failed:${C_RESET} $jq_expr"
  echo "  ${C_YELLOW}Response body:${C_RESET}"
  if [[ -s "$LAST_RESPONSE" ]] && jq . < "$LAST_RESPONSE" >/dev/null 2>&1; then
    jq . < "$LAST_RESPONSE" | sed 's/^/    /'
  else
    sed 's/^/    /' < "$LAST_RESPONSE"
  fi
  echo ""
  print_leftover_records
  echo ""
  echo "${C_RED}Stopping. An assertion failed — this means the HTTP call succeeded but the response body didn't contain what we expected.${C_RESET}"
  exit 1
}

# ----------------------------------------------------------------------------
# Print leftover test records for inspection on failure.
# ----------------------------------------------------------------------------
print_leftover_records() {
  local any=0
  echo "  ${C_YELLOW}Test data left in the database for inspection:${C_RESET}"
  if [[ -n "$ADMIN_SUBSCRIPTION_ID" ]]; then
    echo "    Subscription: $ADMIN_SUBSCRIPTION_ID"
    any=1
  fi
  if [[ -n "$ADMIN_STRATEGY_ID" ]]; then
    echo "    Pricing strategy: $ADMIN_STRATEGY_ID"
    any=1
  fi
  if [[ -n "$ADMIN_PLAN_ID" ]]; then
    echo "    Pricing plan: $ADMIN_PLAN_ID (name: test-plan-$TS)"
    any=1
  fi
  if [[ -n "$ADMIN_SIGNAL_ID" ]]; then
    echo "    Signal:       $ADMIN_SIGNAL_ID (name: $SIGNAL_NAME)"
    any=1
  fi
  if [[ -n "$ADMIN_AGENT_ID" ]]; then
    echo "    Agent:        $ADMIN_AGENT_ID (agentCode: $AGENT_CODE)"
    any=1
  fi
  if [[ -n "$ADMIN_CUSTOMER_ID" ]]; then
    echo "    Customer:     $ADMIN_CUSTOMER_ID (externalId: $CUSTOMER_EXTERNAL_ID)"
    any=1
  fi
  if [[ -n "$SDK_CUSTOMER_ID" ]]; then
    echo "    SDK customer: $SDK_CUSTOMER_ID"
    any=1
  fi
  if [[ $any -eq 0 ]]; then
    echo "    (none — failure happened before any records were created)"
  fi
  echo ""
  echo "  ${C_DIM}To find them in Prisma Studio, search for:${C_RESET}"
  echo "    ${C_DIM}$TS${C_RESET}"
}

# ----------------------------------------------------------------------------
# Cleanup: delete test records in reverse dependency order. Runs via trap.
# Skipped on assertion failure so leftover state can be inspected.
# ----------------------------------------------------------------------------
cleanup() {
  rm -rf "$TMP_DIR"

  if [[ $SKIP_CLEANUP -eq 1 ]]; then
    return 0
  fi

  local any=0
  [[ -n "$SDK_CUSTOMER_ID" ]] && any=1
  [[ -n "$ADMIN_SUBSCRIPTION_ID" ]] && any=1
  [[ -n "$ADMIN_STRATEGY_ID" ]] && any=1
  [[ -n "$ADMIN_PLAN_ID" ]] && any=1
  [[ -n "$ADMIN_SIGNAL_ID" ]] && any=1
  [[ -n "$ADMIN_AGENT_ID" ]] && any=1
  [[ -n "$ADMIN_CUSTOMER_ID" ]] && any=1
  if [[ $any -eq 0 ]]; then
    return 0
  fi

  print_section "Cleanup"

  # Reverse dependency order:
  # subscription → plan → signal → agent → customer
  # (SDK customer is independent of the admin chain.)

  if [[ -n "$SDK_CUSTOMER_ID" ]]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-api-key: $MF_API_SECRET_KEY" \
      "$MF_API_BASE_URL/v1/sdk/customers/$SDK_CUSTOMER_ID" || true
    print_info "  • Deleted SDK customer (alias path)"
  fi

  if [[ -n "$ADMIN_SUBSCRIPTION_ID" ]]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-api-key: $MF_API_SECRET_KEY" \
      "$MF_API_BASE_URL/v1/subscriptions/$ADMIN_SUBSCRIPTION_ID" || true
    print_info "  • Deleted subscription"
  fi

  if [[ -n "$ADMIN_STRATEGY_ID" && -n "$ADMIN_PLAN_ID" ]]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-api-key: $MF_API_SECRET_KEY" \
      "$MF_API_BASE_URL/v1/pricing-plans/$ADMIN_PLAN_ID/pricing-strategies/$ADMIN_STRATEGY_ID" || true
    print_info "  • Deleted pricing strategy"
  fi

  if [[ -n "$ADMIN_PLAN_ID" ]]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-api-key: $MF_API_SECRET_KEY" \
      "$MF_API_BASE_URL/v1/pricing-plans/$ADMIN_PLAN_ID" || true
    print_info "  • Deleted pricing plan"
  fi

  if [[ -n "$ADMIN_SIGNAL_ID" ]]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-api-key: $MF_API_SECRET_KEY" \
      "$MF_API_BASE_URL/v1/signals/$ADMIN_SIGNAL_ID" || true
    print_info "  • Deleted signal"
  fi

  if [[ -n "$ADMIN_AGENT_ID" ]]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-api-key: $MF_API_SECRET_KEY" \
      "$MF_API_BASE_URL/v1/agents/$ADMIN_AGENT_ID" || true
    print_info "  • Deleted agent"
  fi

  if [[ -n "$ADMIN_CUSTOMER_ID" ]]; then
    curl -s -o /dev/null -X DELETE \
      -H "x-api-key: $MF_API_SECRET_KEY" \
      "$MF_API_BASE_URL/v1/customers/$ADMIN_CUSTOMER_ID" || true
    print_info "  • Deleted customer"
  fi
}

trap cleanup EXIT

# ============================================================================
# Pre-flight.
# ============================================================================

: "${MF_API_BASE_URL:=http://localhost:4000}"

check_jq
check_env_vars
confirm_target

print_section "MarginFront API Surface Test"
echo "  Base URL:     $MF_API_BASE_URL"
echo "  Test prefix:  $TS"
echo ""
print_info "  (Secret key loaded from MF_API_SECRET_KEY env var — never displayed)"
if [[ -n "${MF_API_PUBLISHABLE_KEY:-}" ]]; then
  print_info "  (Publishable key loaded from MF_API_PUBLISHABLE_KEY env var — never displayed)"
fi
echo ""

print_section "Pre-flight"
check_api_running
print_info "  • API server is reachable"
print_info "  • Secret key is valid"
derive_org_id
print_info "  • Derived organization ID from /v1/verify"
echo ""

# ============================================================================
# Canonical /v1/<resource> URLs with SECRET key
# ============================================================================

MF_CURRENT_KEY="$MF_API_SECRET_KEY"

print_section "Phase 1: Canonical /v1/<resource> URLs (secret key)"

run_test "Verify API key" GET /v1/verify 200

# --- Customers ---------------------------------------------------------------
run_test "Create customer" \
  POST /v1/customers 201 \
  "$(jq -nc \
    --arg name "Test Customer $TS" \
    --arg extId "$CUSTOMER_EXTERNAL_ID" \
    --arg email "test-$TS@marginfront-test.invalid" \
    '{name: $name, externalId: $extId, email: $email}')"
ADMIN_CUSTOMER_ID="$(last_id id)"

run_test "Read customer back" \
  GET "/v1/customers/$ADMIN_CUSTOMER_ID" 200

run_test "Update customer" \
  PATCH "/v1/customers/$ADMIN_CUSTOMER_ID" 200 \
  '{"phone": "+1-555-0100"}'

# --- Agents ------------------------------------------------------------------
run_test "Create agent" \
  POST /v1/agents 201 \
  "$(jq -nc \
    --arg name "Test Agent $TS" \
    --arg code "$AGENT_CODE" \
    --arg desc "Created by test-api-surface.sh — safe to delete" \
    '{name: $name, agentCode: $code, description: $desc}')"
ADMIN_AGENT_ID="$(last_id id)"

run_test "Read agent back" \
  GET "/v1/agents/$ADMIN_AGENT_ID" 200

run_test "Update agent" \
  PATCH "/v1/agents/$ADMIN_AGENT_ID" 200 \
  '{"description": "Updated by test script"}'

# --- Signals (metrics) -------------------------------------------------------
run_test "Create signal" \
  POST /v1/signals 201 \
  "$(jq -nc \
    --arg name "$SIGNAL_NAME" \
    --arg short "test_signal" \
    --arg agentId "$ADMIN_AGENT_ID" \
    '{name: $name, shortName: $short, agentId: $agentId, type: "usage"}')"
ADMIN_SIGNAL_ID="$(last_id id)"

run_test "Read signal back" \
  GET "/v1/signals/$ADMIN_SIGNAL_ID" 200

run_test "Update signal" \
  PATCH "/v1/signals/$ADMIN_SIGNAL_ID" 200 \
  '{"shortName": "test_signal_v2"}'

# --- Pricing plans -----------------------------------------------------------
run_test "Create pricing plan" \
  POST /v1/pricing-plans 201 \
  "$(jq -nc \
    --arg name "Test Plan $TS" \
    --arg desc "Created by test-api-surface.sh — safe to delete" \
    --arg agentId "$ADMIN_AGENT_ID" \
    '{name: $name, description: $desc, agentId: $agentId}')"
ADMIN_PLAN_ID="$(last_id id)"

run_test "Read pricing plan back" \
  GET "/v1/pricing-plans/$ADMIN_PLAN_ID" 200

run_test "Update pricing plan" \
  PATCH "/v1/pricing-plans/$ADMIN_PLAN_ID" 200 \
  '{"description": "Updated by test script"}'

# --- Pricing strategies ------------------------------------------------------
# Pricing strategies are the actual per-signal rates that live inside a
# pricing plan. Without them, a plan has no real prices. The route is nested
# under the plan: /v1/pricing-plans/:planId/pricing-strategies

run_test "Create pricing strategy (bulk)" \
  POST "/v1/pricing-plans/$ADMIN_PLAN_ID/pricing-strategies" 201 \
  "$(jq -nc \
    --arg name "Test Strategy $TS" \
    --arg agentId "$ADMIN_AGENT_ID" \
    --arg signalId "$ADMIN_SIGNAL_ID" \
    '[{name: $name, agentId: $agentId, signalId: $signalId, chargeType: "usage", pricingModel: "flat", rate: 0.01, active: true}]')"

# Bulk create returns an array or a wrapper, so try several common shapes.
ADMIN_STRATEGY_ID="$(jq -r '
  (if type == "array" then .[0].id
   elif .created then (.created[0].id // .created.data[0].id // empty)
   elif .data then .data[0].id
   elif .results then .results[0].id
   elif .id then .id
   else empty end) // empty
' < "$LAST_RESPONSE")"

if [[ -z "$ADMIN_STRATEGY_ID" ]]; then
  echo "  ${C_RED}Could not extract pricing strategy ID from create response.${C_RESET}"
  echo "  ${C_YELLOW}Response body:${C_RESET}"
  jq . < "$LAST_RESPONSE" 2>/dev/null | sed 's/^/    /' || cat "$LAST_RESPONSE"
  SKIP_CLEANUP=1
  exit 1
fi

run_test "List pricing strategies" \
  GET "/v1/pricing-plans/$ADMIN_PLAN_ID/pricing-strategies" 200
assert_jq "list contains at least one strategy" \
  '(.data // .results // .) | (if type == "array" then length >= 1 else false end)'

run_test "Read pricing strategy by ID" \
  GET "/v1/pricing-plans/$ADMIN_PLAN_ID/pricing-strategies/$ADMIN_STRATEGY_ID" 200

run_test "Update pricing strategy" \
  PATCH "/v1/pricing-plans/$ADMIN_PLAN_ID/pricing-strategies/$ADMIN_STRATEGY_ID" 200 \
  '{"rate": 0.02}'

# --- Subscriptions -----------------------------------------------------------
run_test "Create subscription" \
  POST /v1/subscriptions 201 \
  "$(jq -nc \
    --arg name "Test Sub $TS" \
    --arg planId "$ADMIN_PLAN_ID" \
    --arg agentId "$ADMIN_AGENT_ID" \
    --arg customerId "$ADMIN_CUSTOMER_ID" \
    --arg startDate "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{name: $name, planId: $planId, agentId: $agentId, customerId: $customerId, startDate: $startDate, billingCycle: "monthly", status: "active"}')"
ADMIN_SUBSCRIPTION_ID="$(last_id id)"

run_test "Read subscription back" \
  GET "/v1/subscriptions/$ADMIN_SUBSCRIPTION_ID" 200

run_test "Update subscription" \
  PATCH "/v1/subscriptions/$ADMIN_SUBSCRIPTION_ID" 200 \
  '{"invoiceMemo": "Updated by test script", "changeReason": "Test script update"}'

# --- Usage events + analytics + invoices ------------------------------------
# This is the core value-prop path: event goes in via POST /v1/usage/record,
# lands in signal_events, gets cost-calculated, shows up in analytics.
# We verify each step, not just the HTTP status code.

run_test "Log usage event" \
  POST /v1/usage/record 200 \
  "$(jq -nc \
    --arg custExtId "$CUSTOMER_EXTERNAL_ID" \
    --arg agentCode "$AGENT_CODE" \
    --arg signalName "$SIGNAL_NAME" \
    '{records: [{customerExternalId: $custExtId, agentCode: $agentCode, signalName: $signalName, model: "gpt-4o", modelProvider: "openai", inputTokens: 523, outputTokens: 117}]}')"
assert_jq "event was processed"      '.processed == 1'
assert_jq "event was successful"     '.successful == 1'
assert_jq "zero failures"            '.failed == 0'
assert_jq "results.success non-empty" '.results.success | length >= 1'

# Verify the event actually landed in signal_events via the listing endpoint.
run_test "List events via /v1/events" \
  GET "/v1/events?customerExternalId=$CUSTOMER_EXTERNAL_ID&agentId=$ADMIN_AGENT_ID&limit=10" 200
assert_jq "events listing has our event" '.totalResults >= 1'
assert_jq "first event matches our customer" \
  '.results[0].customerExternalId == "'"$CUSTOMER_EXTERNAL_ID"'"'

# --- Unknown-model events are stored, not dropped ---
# A model string with no service_pricing row still lands in signal_events,
# with usageCost: null and eventProcessed: NEEDS_COST_BACKFILL. The response
# flags it as failed with stored: true so the caller knows not to retry.
UNKNOWN_MODEL_NAME="made-up-model-$TS"

run_test "Log usage event with unknown model (must still store the event)" \
  POST /v1/usage/record 200 \
  "$(jq -nc \
    --arg custExtId "$CUSTOMER_EXTERNAL_ID" \
    --arg agentCode "$AGENT_CODE" \
    --arg signalName "$SIGNAL_NAME" \
    --arg unknown "$UNKNOWN_MODEL_NAME" \
    '{records: [{customerExternalId: $custExtId, agentCode: $agentCode, signalName: $signalName, model: $unknown, modelProvider: "openai", inputTokens: 100, outputTokens: 50}]}')"
assert_jq "event was processed"        '.processed == 1'
assert_jq "marked as failed"           '.failed == 1'
assert_jq "not counted as successful"  '.successful == 0'
assert_jq "failed entry has code NEEDS_COST_BACKFILL" \
  '.results.failed[0].code == "NEEDS_COST_BACKFILL"'
assert_jq "failed entry has stored: true" \
  '.results.failed[0].stored == true'
assert_jq "failed entry has an eventId (proof the row was written)" \
  '.results.failed[0].eventId != null'
assert_jq "error message mentions dashboard mapping" \
  '(.results.failed[0].error | test("Needs attention"))'

# Verify the unknown-cost event actually exists in signal_events (never-drop).
run_test "Unknown-model event visible in /v1/events listing" \
  GET "/v1/events?customerExternalId=$CUSTOMER_EXTERNAL_ID&limit=20" 200
assert_jq "listing contains a NEEDS_COST_BACKFILL event" \
  '[.results[] | select(.eventProcessed == "NEEDS_COST_BACKFILL")] | length >= 1'
assert_jq "the NEEDS_COST_BACKFILL event has null usageCost (never 0)" \
  '[.results[] | select(.eventProcessed == "NEEDS_COST_BACKFILL")][0].usageCost == null'

# --- Needs-cost-backfill queue endpoint ---
run_test "GET /v1/events/needs-cost-backfill returns grouped queue" \
  GET /v1/events/needs-cost-backfill 200
assert_jq "queue contains the unknown model we just sent" \
  "[.groups[] | select(.model == \"$UNKNOWN_MODEL_NAME\")] | length >= 1"
assert_jq "totalEvents is at least 1" \
  '.totalEvents >= 1'

# --- Map unknown model to a known one and backfill costs ---
# The unknown-model event created above has usageCost: null and
# eventProcessed: NEEDS_COST_BACKFILL. Map it to gpt-4o/openai, which the
# successful event above already priced. The endpoint saves an org-scoped
# model mapping and recalculates cost for every matching event.
run_test "POST /v1/events/map-model maps unknown model and backfills" \
  POST /v1/events/map-model 200 \
  "$(jq -nc \
    --arg srcModel "$UNKNOWN_MODEL_NAME" \
    '{sourceModel: $srcModel, sourceProvider: "openai", targetModel: "gpt-4o", targetProvider: "openai"}')"
assert_jq "backfilled at least 1 event" \
  '.backfilled >= 1'
assert_jq "got an org-scoped mapping ID" \
  '.mappingId != null'

# Verify the mapped model is no longer in the backfill queue
run_test "Backfill queue no longer contains the mapped model" \
  GET /v1/events/needs-cost-backfill 200
assert_jq "unknown model gone from queue" \
  "[.groups[] | select(.model == \"$UNKNOWN_MODEL_NAME\")] | length == 0"

ANALYTICS_START="$(date -u -v-30d +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%S.000Z)"
ANALYTICS_END="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

run_test "Read usage analytics" \
  GET "/v1/analytics/usage?startDate=$ANALYTICS_START&endDate=$ANALYTICS_END" 200

run_test "List invoices" \
  GET /v1/invoices 200

# ============================================================================
# Alias paths (still secret key)
# ============================================================================

print_section "Phase 2: Alias paths"

run_test "Alias /v1/org/:orgId/customers list" \
  GET "/v1/org/$MF_ORG_ID_DERIVED/customers" 200

run_test "Alias /v1/sdk/verify" \
  GET /v1/sdk/verify 200

run_test "Alias /v1/sdk/customers list" \
  GET /v1/sdk/customers 200

# Create an SDK customer via the alias path to check SdkController.
run_test "Alias /v1/sdk/customers create" \
  POST /v1/sdk/customers 201 \
  "$(jq -nc \
    --arg name "SDK Alias Customer $TS" \
    --arg extId "sdk-alias-$TS" \
    --arg email "sdk-alias-$TS@marginfront-test.invalid" \
    '{name: $name, externalId: $extId, email: $email}')"
SDK_CUSTOMER_ID="$(last_id id)"

# ============================================================================
# Publishable key permission enforcement
# ============================================================================

if [[ -n "${MF_API_PUBLISHABLE_KEY:-}" ]]; then
  print_section "Phase 3: Publishable key permission enforcement"

  MF_CURRENT_KEY="$MF_API_PUBLISHABLE_KEY"

  run_test "Verify publishable key" GET /v1/verify 200

  # The publishable key has scopes ['read:pricing', 'read:public'], so writes
  # must be rejected. A 201 here means a real security bug.
  run_test "Publishable key POST /v1/customers MUST be rejected" \
    POST /v1/customers "401|403" \
    "$(jq -nc \
      --arg name "Pub Key Test $TS" \
      --arg extId "pub-test-$TS" \
      --arg email "pub-test-$TS@marginfront-test.invalid" \
      '{name: $name, externalId: $extId, email: $email}')"

  # Switch back to secret key for cleanup
  MF_CURRENT_KEY="$MF_API_SECRET_KEY"
else
  print_section "Phase 3: Publishable key tests — SKIPPED"
  print_info "  • MF_API_PUBLISHABLE_KEY is not set. To enable, add it to scripts/.env.local."
fi

# ============================================================================
# Summary
# ============================================================================

print_summary() {
  print_section "Results"
  echo "  ${C_GREEN}Passed:${C_RESET}  $PASS"
  if [[ $FAIL -gt 0 ]]; then
    echo "  ${C_RED}Failed:${C_RESET}  $FAIL"
    echo ""
    echo "  Failed tests:"
    for t in "${FAILED_TESTS[@]}"; do
      echo "    - $t"
    done
    echo ""
    exit 1
  else
    echo "  ${C_DIM}Failed:  0${C_RESET}"
    echo ""
    echo "  ${C_GREEN}All API endpoints are working. Safe to refactor.${C_RESET}"
    echo ""
    # If cleanup is being skipped intentionally, print the leftover record
    # IDs so you can go verify them in the dashboard or Prisma Studio.
    if [[ $SKIP_CLEANUP -eq 1 ]]; then
      print_section "Records left in the database for verification"
      print_leftover_records
      echo ""
      echo "  ${C_YELLOW}Cleanup was skipped (SKIP_CLEANUP=1).${C_RESET}"
      echo "  ${C_DIM}These records stay until you delete them in the dashboard or Prisma Studio.${C_RESET}"
      echo "  ${C_DIM}A run without SKIP_CLEANUP cleans up only the records it creates.${C_RESET}"
      echo ""
    fi
  fi
}

print_summary
