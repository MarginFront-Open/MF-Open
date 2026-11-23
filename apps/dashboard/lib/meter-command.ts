/**
 * WHAT THIS FILE DOES: holds the ONE way the dashboard spells the meter's
 * command line, so a customer who copies it off the page gets a command that
 * runs. The meter is built from source, and `init` copies it to
 * ~/.marginfront-ccc/cli.js, so that copy is what every later command runs.
 *
 * KEEP IN SYNC with CCC_COMMAND_INVOCATION in
 * packages/code-cost-clarity/src/connector.ts. A test reads that file and
 * fails if the two drift, because the meter is what answers to it.
 *
 * Lives in apps/dashboard/lib/ (not src/lib/): the Next build resolves
 * @/lib/* against this directory only.
 */

export const CCC_COMMAND_INVOCATION = 'node ~/.marginfront-ccc/cli.js'
