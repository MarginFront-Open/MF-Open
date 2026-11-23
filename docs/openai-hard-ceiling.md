# A hard spend ceiling for Codex at OpenAI

The Code Cost Clarity meter records what your team spends on Codex and, with
`init --control`, can pause Codex tool calls on machines where it's installed.
That's a guardrail, not a wall. The stops nobody at your company can get past
are the ones OpenAI runs on its own servers. This page explains the
difference, and why you want both.

**OpenAI's stops fail closed: OpenAI's server refuses the request. The meter's
cap fails open: if it can't check, work carries on.**

- [Fail closed and fail open](#fail-closed-and-fail-open)
- [Setting the ceiling at OpenAI](#setting-the-ceiling-at-openai)
- [Using both](#using-both)

## Fail closed and fail open

Two kinds of limit, and the difference is the point of this page.

**Fail closed is a locked door.** The stop lives on OpenAI's servers. When the
number is reached, OpenAI refuses the request. Nobody at your company can get
past it, because the thing saying no isn't on their laptop.

**Fail open is a seatbelt.** The meter's cap runs on the developer's own
machine. When the cap is reached it pauses Claude Code and Codex tool calls.
It stops tool calls, not tokens, so a prompt that's already running is already
billed, and Codex is only paused once someone runs `/hooks` inside Codex and
trusts the cap check. If the cap file is missing, broken or more than an hour
old, the check lets everything through, and anyone with access to the machine
can remove the hook. A broken guardrail should never stop a developer's day,
so it doesn't. The details are in
[packages/code-cost-clarity](../packages/code-cost-clarity/README.md#spend-control).

You want both, for different jobs:

- **Fail closed** for the number you'd have to explain to your board: one
  ceiling at OpenAI, set once, that nothing gets past.
- **Fail open** for the day to day: spend per developer, a daily, weekly or
  monthly cap, and a pause that stops a runaway session long before it
  becomes the board's problem. See
  [features.md](features.md#internal-ai-spend-and-the-code-cost-clarity-meter).

Set the OpenAI ceiling high enough that reaching it is a real emergency, and
run your everyday budget with the meter's caps underneath it.

## Setting the ceiling at OpenAI

Where the ceiling lives depends on how your company pays for Codex: an OpenAI
API key billed to your organization, or ChatGPT seats in a workspace. Ask
whoever pays the OpenAI bill, then look up spend limits for that billing mode
in OpenAI's own documentation. OpenAI changes these controls, so its current
pages are the only source to trust.

A team can be in more than one billing mode at once, with some developers on
API keys and some on ChatGPT seats. A ceiling in one mode does nothing for the
others, so check each one.

When you find the setting, make sure it's a limit that stops traffic and not
an alert. An alert sends a notification and work carries on.

## Using both

The two controls do different jobs, and neither replaces the other.

|                           | A spend limit at OpenAI   | The meter's cap                                      |
| ------------------------- | ------------------------- | ---------------------------------------------------- |
| Where it runs             | OpenAI's servers          | The developer's machine                              |
| When it breaks            | Stays shut (fails closed) | Lets work through (fails open)                       |
| Can a developer remove it | No                        | Yes                                                  |
| What it stops             | Requests to OpenAI        | Claude Code and Codex tool calls                     |
| Covers                    | OpenAI spend              | Claude Code and Codex on machines that run the meter |
| Good for                  | The emergency ceiling     | The everyday budget and the per-developer view       |

Set the ceiling at OpenAI for the number that would really hurt. Run the
everyday budget with the meter's caps: set them under **Internal AI Spend**,
then **Caps**, or from code with `POST /control/caps`, the SDK's
`spendControls.create()` or the MCP tool `create_spend_cap`. Your OpenAI
charges are still yours either way.
