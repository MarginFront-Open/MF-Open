# @marginfront/code-cost-clarity

**See what your team spends on Claude Code and Codex: who spent it, on which model,
and how much.** It lands in your own MarginFront server on its own while your team
codes.

This package is built from source and sends only to the MarginFront server you name.
It has no built-in server address, it is not installed from a package registry, and it
never updates itself.

You're watching your own team's AI spend here. Nobody gets charged, and nobody gets
cut off unless you turn on spend caps.

Your Anthropic and OpenAI keys stay yours. This tool never reads, needs, or transmits
them. The only credential it uses is your MarginFront key, and only to send usage to
the one MarginFront server you set in `MARGINFRONT_API_URL`.

**What it keeps on your disk.** The meter writes a local capture file of what your
coding agents report. Claude Code puts your prompt, the model's reply, and each tool
call's input on those same records, and a tool call's input can be the contents of a
file the agent edited. A shell call goes one further: the command it ran arrives a
second time, in the tool parameters. The meter deletes all of that before the file is
written, so none of it is stored and none of it is sent. One record keeps its tool
parameters: an MCP tool call. They are the only place the name of an MCP tool call
appears, because Claude Code labels every one of them `mcp_tool` and puts the server
and tool it really called in those parameters, so dropping them would turn every MCP
tool on your bill into one unnamed line.

Runs on macOS, Windows, and Linux. Needs Node 18 or newer to run, and Node 22.15 or
newer to run its test suite.

---

## Install

You need three things first:

1. **A running MarginFront server of your own**, and its API address. The address
   includes `/v1`, for example `https://billing.example.com/v1`, or
   `http://localhost:4000/v1` for a server on this machine.
2. **A MarginFront secret key** (`mf_sk_*`). In your MarginFront dashboard, go to
   **Build -> API keys -> "Create key pair"**.
3. **A checkout of the MarginFront source**, with its dependencies installed
   (`npm ci` at the root).

Then, from the root of the checkout, build the meter and run its setup:

```bash
npx turbo run build --filter=@marginfront/code-cost-clarity
node packages/code-cost-clarity/dist/cli.js init
```

(`npx turbo` here runs the build tool already installed in the checkout. It
downloads nothing.)

`init` first asks which MarginFront server this machine sends to. You can also pass it:

```bash
node packages/code-cost-clarity/dist/cli.js init --api-url https://billing.example.com/v1
```

There is no default. If no address is saved and none is given, `init` stops before
it downloads anything or asks for your key. If the address answers but is not a
MarginFront API (the usual cause is a missing `/v1`), `init` stops, does not keep
the address and does not save your key.

`init` then downloads the collector it needs (~360 MB, one time, from the
OpenTelemetry project's GitHub releases, checked against a pinned fingerprint), asks
you to paste that secret key, checks it with your server, and saves both to
`~/.marginfront-ccc/.env`, a file only you can read. Then it shows you every change it
wants to make and asks before making any of them. Answer `n` and nothing outside
`~/.marginfront-ccc` is touched.

`init` also copies the built program to `~/.marginfront-ccc/cli.js`. Every command
after the first one runs that copy, so the checkout can move or be rebuilt without
breaking the meter:

```bash
node ~/.marginfront-ccc/cli.js status
```

On Windows, `~` works in Git Bash and in PowerShell 7.5 or newer. In `cmd.exe` and
older PowerShell, spell the path out: `node "%USERPROFILE%\.marginfront-ccc\cli.js" status`.

When `init` finishes, quit and reopen Claude Code and Codex, and start a fresh
terminal. They read the new settings at launch, so anything already open won't report
a thing until you reopen it.

Then code as usual:

```bash
claude          # or: codex, or the desktop apps
```

Your spend shows up in your MarginFront dashboard under your teammate email.

### The server address

One setting decides where everything goes: `MARGINFRONT_API_URL` in
`~/.marginfront-ccc/.env`. A value exported in your shell wins over the file for
commands you type, and `init` saves it to the file. The background meter reads only
the file.

- It must be `https://`, or `http://` to this machine only (`localhost`, `127.0.0.1`
  or `[::1]`).
- Plain `http://` to another machine is refused, because your key would travel
  unencrypted. If your server is on a private network you trust, set
  `MARGINFRONT_ALLOW_INSECURE_HTTP=1` in the same file to allow it. It is off by
  default.
- A missing or malformed address stops the meter with a message saying what to fix.
  Nothing ever falls back to another address.
- Every request is checked against that one server right before it is sent, and a
  redirect from the server is refused, so your key cannot follow one somewhere else.
- A path in front of `/v1` is kept: `https://example.com/billing/v1` sends to
  `https://example.com/billing/v1/sdk/usage/record`.

Change the line, then `stop` and `start`.

The meter doesn't read `MARGINFRONT_INGEST_URL`. If it is set and `MARGINFRONT_API_URL`
is not, the meter stops and tells you to rename it.

### Updating

Nothing checks for updates and nothing downloads a newer build. To update: pull the
MarginFront repository, run the two commands at the top of this section again, and
`init` replaces the installed copy.

### Platforms

On **macOS and Windows** a background meter does the work, so there's no terminal to
keep open. Windows needs no WSL. The meter starts when you sign in and runs with no
window, so after sign-in nothing appears on your screen and there is nothing to close.
`stop` pauses it and `start` brings it back. Run `status` once after your first sign-in
to see it working. On both macOS and Windows the meter writes what it has to say about
itself to `~/.marginfront-ccc/forwarder.out.log` and `forwarder.err.log`, and `status`
shows you the last lines of each under "Recent output" and "Recent errors".

On **Linux** there's no background meter. Keep
`node ~/.marginfront-ccc/cli.js run` open in a terminal while you work. Usage that
happens while it's closed is lost, not buffered.

Claude Code reports on a five-minute timer, not per message, so give a new setup
five minutes before deciding nothing arrived.

### Windows details

- **The background meter is a Task Scheduler task.** It's named
  `ai.marginfront.ccc`, it runs under your own account at the lowest privilege
  level, and it needs no administrator rights to install. It starts at your
  sign-in, keeps running on battery, and has no time limit. Open Task Scheduler to
  see it.
- **A meter that crashes stays down** until you run `start` or sign in again.
  `status` shows whether it's running.
- **Only the command-line agents are metered.** The Claude and Codex desktop apps
  on Windows don't pick up the settings `init` writes, so run `claude` and `codex`
  from a terminal. On macOS the desktop apps are metered too.
- **Your key file is locked to your Windows account.** `init` rebuilds the access
  list on `%USERPROFILE%\.marginfront-ccc\.env` so only your account can open it.
  If Windows refuses, `init` says so and prints three steps in File Explorer that
  fix it. Your key is saved either way, so don't skip that message. If you'd rather
  keep the key off disk, delete its line from the file and set `MARGINFRONT_API_KEY`
  as an environment variable instead.

### If your coding agent runs inside WSL

Windows itself doesn't need WSL. This is only for people whose Claude Code or Codex
already lives inside a distro. Build and run this in that same distro, because
that's where those agents send telemetry and where the collector's localhost is.

You need a general-purpose distro (`wsl --install -d Ubuntu`). Docker Desktop's
`docker-desktop` distro is an appliance for running Docker, and this tool doesn't work
inside it, even though `wsl -l -v` lists it and makes WSL look ready. There's no
background meter in WSL either, so keep `run` open.

---

## The commands

Each one runs as `node ~/.marginfront-ccc/cli.js <command>` (the first `init` runs from
the source checkout, as above).

| Command                  | What it does                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                   | The one setup command. It checks your pasted key with MarginFront before saving it. Safe to re-run: it never re-asks for a saved key that still works and never clobbers a setting you changed.                                  |
| `status`                 | Are you set up and is it capturing? Key, Meter, Claude Code and Codex lines, then your work item and whether finished-work counting is on. A Queue line appears whenever turns or finished things are parked waiting to send. Recent activity and errors follow. |
| `run`                    | Streams your live spend in this terminal instead of the background meter. Ctrl-C stops it.                                                                                                                                       |
| `start`                  | Resumes the background meter after `stop`. `init` already starts it for you.                                                                                                                                                     |
| `stop`                   | Pauses the meter, both the background one and any foreground `run`, until `start` or your next sign-in. On Windows this can lose the last moments of usage, because the collector there has to be forced down rather than asked. |
| `work ["<name>"]`        | Puts this machine's spend on a piece of work. No name prints the one in effect; `--clear` removes it. Nothing to restart. |
| `done "<name>" [n]`      | Counts something you finished, so ROI in your dashboard's left menu can show what one cost on its Finished work tab. It costs nothing on its own. `--setup` turns finished-work counting on or off. |
| `preview <capture.json>` | Prints the exact record it would send for one captured snapshot. Needs no key, so it's a safe dry run.                                                                                                                           |
| `uninstall`              | Undoes every change `init` made and reclaims the ~360 MB. Keeps your saved key.                                                                                                                                                  |
| `help`, `version`        | What you'd expect.                                                                                                                                                                                                               |

`run` prints a line per turn, so you can watch it land:

```
[14:22:07] recorded developer@example.com · in=3210 out=287 · server=$0.0232 · cc=$0.0236 event=9f0c2a71-...
```

### Options

| Option         | Where            | What it does                                                                                                                                                           |
| -------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--api-url`    | `init`           | Your MarginFront server's API address, including `/v1`. Saved as `MARGINFRONT_API_URL`. Required once, on the first run, unless you answer the question instead. |
| `--control`    | `init`           | Also turn on spend caps. See below.                                                                                                                                    |
| `--no-prompt`  | `init`           | Skip every question, for CI and scripts. It still wires your config, and it prints the same list of changes. Pass `--api-url` (or save `MARGINFRONT_API_URL`) and paste your key into `~/.marginfront-ccc/.env` separately. |
| `--fold-cache` | `run`, `preview` | Round-up mode for a model MarginFront can't price yet. The default is more accurate, so reach for this only when a model has no cache price.                           |
| `--agent`      | `done`           | Which assistant this finished thing rolls up under: `claude-code` or `codex`. Needed only when both are installed and the meter has not seen either working yet. |
| `--clear`      | `work`           | Removes the work item from this machine. |
| `--setup`      | `done`           | Asks the two finished-work questions again, so you can turn counting on or off later. |
| `--purge`      | `uninstall`      | Also delete your saved settings and MarginFront key.                                                                                                                   |
| `CCC_IGNORE_REPOS` | `~/.marginfront-ccc/.env` | A setting, not a flag: the repos this machine never sends spend from, comma-separated `owner/repo`. See below. |

---

## Label this machine's spend with a work item

By default the meter can tell you what this machine spent. It can't tell you which job
the money went to. One line in `~/.marginfront-ccc/.env` fixes that:

```
CCC_WORK_ID=PROJ-123
```

A work item is whatever you bill AI work against: a project, a ticket, a client
engagement. Pick a short name for it, a ticket number or plain words. Every record
this machine sends from then on carries that name, tokens and tool calls, Claude Code
and Codex alike, and MarginFront adds up what each one cost.

One thing to get right: **use the same spelling every time, capital letters
included.** `proj-123` and `PROJ-123` are two different things here, and they add up
as two separate jobs.

This line is about spend. Counting what you *finish* is a separate switch, off until
you turn it on, and the next section covers it.

**There's nothing to restart.** Change the line, save the file, and the meter picks up
the new name on the next usage it sends. No `stop`, no `start`. Blank the line out, or
delete it, and this machine is metered exactly as it was before.

You don't have to open the file at all. These do the same thing:

```bash
node ~/.marginfront-ccc/cli.js work "PROJ-123"    # set it
node ~/.marginfront-ccc/cli.js work               # see what's in effect
node ~/.marginfront-ccc/cli.js work --clear       # remove it
```

`status` reads the line back to you, so you can check it without opening the file.

**`CCC_MATTER_ID` is an older name for this line, and it still works.** A settings
file that uses it reports the same way. Your settings file is kept as it is, so
`CCC_MATTER_ID` stays where you put it. If both lines carry a value, `CCC_WORK_ID` is
the one used.

---

## Keep a repo off the meter

Some repos you will never report on: a customer's checkout you've agreed to keep out
of your own reporting, a personal project on a work laptop. Without this line, the
choices are to meter it anyway or turn the meter off, and turning it off loses the
rest of the machine with it. One line in `~/.marginfront-ccc/.env` names the repos this machine
never sends from:

```
CCC_IGNORE_REPOS=acme-corp/billing,acme-corp/website
```

Write each one as `owner/repo`, spelled the way the repo's remote spells it, separated
by commas. Capital letters make no difference here: `Acme-Corp/Billing` and
`acme-corp/billing` are the same repo to the meter.

A session in a named repo produces nothing at all. No record is built, nothing is
posted, and nothing sits in the outbox waiting to go out later. Every other repo on
this machine keeps being metered exactly as it was.

That covers what you type by hand too. Run `node ~/.marginfront-ccc/cli.js done
"<name>"` inside a named repo and it counts nothing, sends nothing, and tells you
which line stopped it. And if records from that repo were already waiting in the
outbox from an earlier outage, naming the repo drops them instead of sending them.

**A session the meter can't place in a repo is still sent.** That one is deliberate.
The meter comes up empty-handed for plenty of ordinary reasons: a folder outside any
repo, a checkout with no remote, a git that won't answer. Holding all of those back
would quietly stop metering a whole machine, and the first sign you'd get is a spend
number drifting to zero with nothing to explain it. A session is held back only when
the meter can name the repo it matched.

**There's nothing to restart.** Add a repo, save the file, and the next record obeys
the new line. No `stop`, no `start`. Blank the line out and this machine is metered
exactly as it was before.

`status` reads the rule back to you, so you can check it without opening the file. It
also names any entry that isn't `owner/repo`, because an entry like that is ignoring
nothing and looks no different in the file from one that works. It flags an entry that
looks like a pasted web address the same way, like `github.com/acme-corp/billing`,
because that one sits in the list looking right and matches nothing at all.

`init` writes the line blank into a settings file it creates. It never rewrites a
settings file you already have, so on an existing install you add the line yourself.

---

## Count what you finish

Counting spend needs nothing from you and never will. This is the other half: what
your team actually finished, so you can see what one of those cost in AI.

Two commands:

```bash
node ~/.marginfront-ccc/cli.js work "Q3 pricing model"
node ~/.marginfront-ccc/cli.js done "contract summarized"
```

`work` says what you're working on now. `done` says you finished one of the things you
named. Add a number to count several at once: `done "contract summarized" 3`.

On your MarginFront dashboard, open ROI in the left menu (ask whoever owns your
MarginFront account if you don't see it), then the Finished work tab, to see each one
with its AI cost beside it.

**A finished thing costs nothing on its own.** MarginFront prices it at zero, so
recording one can never move your spend number. What shows up beside it is the AI cost
*attributed* to it: what the same developer's AI spent on the same work item across
those dates, split by count across the things they finished on it. The tab says so
itself, and the data behind it (`/api/roi/report`) stamps every number with where it
came from, measured, attributed, or your own estimate, so an attributed cost is never
quoted as a measured one.

### Turning it on

`init` asks once, at the end, and on a machine that is not counting yet the answer
defaults to no:

```
Want to count finished work too, not only spend? (y/N)
```

On a machine that already counts finished work, the question shows your names and
defaults to yes, so pressing Enter on an upgrade keeps it on. Typing `n` still turns it
off.

Say yes and it asks what you finish, a few words each, comma-separated. It saves those
names and adds a short note to your coding assistant's memory file, `~/.claude/CLAUDE.md`
for Claude Code and `~/.codex/AGENTS.md` for Codex, telling it to run the two commands
as it works. `uninstall` takes that note back out, byte for byte.

Changed your mind, either direction:

```bash
node ~/.marginfront-ccc/cli.js done --setup
```

`status` tells you which mode this machine is in.

### What to know before you type it

- **Who it lands under** is the developer the meter already uses:
  `CCC_DEVELOPER_EMAIL` from your settings file. If that line is blank, `done` records
  nothing and tells you to run `init`, rather than putting the count under a name your
  spend never lands under.
- **Which assistant it rolls up under** is the installed one. With both installed it's
  whichever the meter last saw working, and on a machine that has seen neither work
  yet, `done` asks you to say which with `--agent claude-code` or `--agent codex`. On
  a machine with both, each assistant's own note already carries its own flag, so the
  assistant never meets that question.
- **Offline it waits.** It goes into the same outbox your turns use, and the meter
  sends it the next time it's running. On Linux and WSL that means the next time you
  run `node ~/.marginfront-ccc/cli.js run`. `status` shows the queue.
- **Reuse the same name.** The page groups by name and ignores capitals, so
  `Contract summarized` and `contract summarized` are one row on it.

---

## Spend Control

Optional spend caps. By default this only watches. Add `--control` and it can also stop a Claude Code or
Codex tool call when the cap your admin set is reached:

```bash
node ~/.marginfront-ccc/cli.js init --control
```

It installs one small check that Claude Code and Codex run before every tool call.
This gets its own consent question, on its own screen, because it's the one that turns
a meter that watches you into one that can stop you.

**This is a guardrail, not a hard limit.** It stops TOOL CALLS, not tokens, so a
prompt that's already running is already billed. It never sees hosted tools, meaning
work a provider runs on its own servers like a provider-side web search. It can't stop
charges at Anthropic or OpenAI, and it can't do anything about a machine that never
installed it. For a hard ceiling, set a spend limit in your Anthropic Console or
OpenAI account. See
[A hard spend ceiling for Codex at OpenAI](../../docs/openai-hard-ceiling.md).

Codex needs one more step: run `/hooks` once inside codex and trust the MarginFront
cap check. Until you do, Codex spend is metered but its tool calls aren't paused.
`status` tells you where each tool stands.

`uninstall` removes the hooks, the Codex entry, and the script completely.

More of what a cap does and doesn't cover:

- It fails open. A missing, broken or stale cap file never blocks you. The meter
  refreshes the numbers the check reads, and when they are more than an hour old the
  check lets everything through until the meter is sending normally again.
- This machine enforces your organization's cap and the cap set for this machine's
  own developer email. A team cap is not enforced here, because the meter cannot tell
  which team a machine belongs to.
- Only caps in enforce mode that cover all providers are applied.
- Anyone with access to the machine can remove the hook. `status` shows whether it is
  still in place.

---

## What `init` changes

The consent screen points here. This is the whole list, and `uninstall` reverses every
line of it.

1. **`~/.claude/settings.json`** gets these eight settings added to its `"env"` block,
   and nothing else, and only if Claude Code is on the machine (a Codex-only machine
   gets no Claude file and is never asked how it signs in to Claude):

   ```
   CLAUDE_CODE_ENABLE_TELEMETRY=1
   OTEL_METRICS_EXPORTER=otlp
   OTEL_LOGS_EXPORTER=otlp
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
   OTEL_METRIC_EXPORT_INTERVAL=300000
   OTEL_LOGS_EXPORT_INTERVAL=300000
   OTEL_LOG_TOOL_DETAILS=1
   ```

   That switches usage reporting on for EVERY `claude` session on this machine, the
   command line and the desktop app both. One exception, and only if you set it up:
   a repo named in `CCC_IGNORE_REPOS` sends nothing, which is what "Keep a repo off
   the meter" above is about. Your MarginFront key is never written here. It stays in
   `~/.marginfront-ccc/.env`.

2. **`~/.codex/config.toml`** gets one small `[otel]` block, and only if Codex is on
   the machine. If you already have your own `[otel]` settings, `init` leaves the file
   alone and prints the block for you to paste.

3. **A background helper** so the meter runs on its own, set to start when you sign
   in. A LaunchAgent on macOS, a Task Scheduler logon task named `ai.marginfront.ccc`
   on Windows that runs the meter with no window. On Linux and WSL there's nothing to
   install it into, and `init` says so and tells you to use `run` instead.

4. **With `--control` only:** a cap-check script in `~/.marginfront-ccc/control/`, a
   pre-tool-call hook in `~/.claude/settings.json` if Claude Code is here, and a
   matching Codex entry if Codex is here. Claude Code and Codex run that same one
   file, so you can open it and read it.

5. **Only if you say yes to counting finished work:** one short note, fenced between
   two comment lines, in `~/.claude/CLAUDE.md` if Claude Code is here and
   `~/.codex/AGENTS.md` if Codex is here. It tells your assistant to run `work` and
   `done` as it goes, and nothing else in those files is touched. The question is the
   last one `init` asks, it defaults to no until you turn it on, and `--no-prompt` never
   sees it.

If neither Claude Code nor Codex is on the machine, `init` still saves your key and
installs the background helper, touches no coding-agent file, and tells you to run it
again after you install one.

---

## Per-developer attribution is automatic

Each record is filed under a developer email. The meter picks it in this order:

1. `CCC_DEVELOPER_EMAIL` from `~/.marginfront-ccc/.env`, if it is set. It always wins.
2. Otherwise the email your Claude Code or Codex login reports.
3. Otherwise a no-identity placeholder, so the spend still lands, under a name
   that shows nobody claimed it.

This is internal cost visibility only. It does not change anyone's bill.

## Sharing one login across the team

When several people share one Claude or Codex login, every machine reports the same
login email and all the cost collapses onto one person. `init` asks, once per machine,
whose AI spending this computer's is, pre-filled from your git email, and saves the
answer as `CCC_DEVELOPER_EMAIL`. Leave it blank to keep auto-detecting from the login.
To change it later, edit the line and `stop` then `start`, or run `init` again.

## Cache pricing

Anthropic bills "cache writes" (saving your prompt for reuse) at two rates, depending
on how Claude Code signs in:

- `5m`, the 5-minute cache, for API key, Bedrock and Vertex sign-ins: 1.25x the input
  rate.
- `1h`, the 1-hour cache, for Claude subscription sign-ins (Pro, Max, Team): 2x the
  input rate.

`init` detects which one applies, or asks one question, and saves it as
`CCC_CACHE_WRITE_TTL`. Leave it blank if you are unsure: cache writes are then priced
at the 1-hour rate, which can overstate but never understate. A Codex-only machine is
never asked.

`init` skips the question when Claude Code's own setting already answers it:
`FORCE_PROMPT_CACHING_5M` set to `1` or `true` means `5m`, and
`ENABLE_PROMPT_CACHING_1H` means `1h`. It looks in your shell and in the `"env"`
block of `~/.claude/settings.json`, and `FORCE_PROMPT_CACHING_5M` wins when both are
set. Each Claude Code record then carries the answer as `metadata.cacheWriteTtl`, and
your server prices that record's cache writes to match. Change the line to `5m` or
`1h` any time the machine's sign-in changes, then `stop` and `start`.

### How Claude Code tokens are sent

Claude Code reports four kinds of token: fresh input, output, cache read and cache
creation. By default each goes in its own field (`inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`), so your server prices each at its own rate.
Every record also keeps the raw cache counts and Claude Code's own dollar figure in
its metadata (`claudeCodeCostUsd`), so you can check the price against it.

A model id with a context-window suffix, like `claude-opus-4-8[1m]`, is sent as
`claude-opus-4.8` to match the price catalog. The id as reported stays in
`metadata.rawModel`.

### `--fold-cache`

A round-up mode for a model whose price row has no cache rates yet. It adds the
cache tokens into `inputTokens` at the fresh-input rate and sends neither cache
field, so the event gets a cost instead of waiting under **Needs attention**. The
metadata says it was folded (`cacheFoldedIntoInput`).

It isn't exact. A cache read costs less than fresh input, so that part rounds up. A
cache write costs more than fresh input, so that part rounds down. Use it only for a
model with no cache rates. Otherwise the default is the accurate one.

## Also capture Codex

If Codex is on the machine, `init` adds one small `[otel]` block to
`~/.codex/config.toml` so Codex reports to the same local collector. If you already
have your own `[otel]` settings, `init` leaves the file alone and prints the block for
you to paste. Codex spend lands under the same developer email rules as Claude Code,
with its own no-identity placeholder when no email is known.

The block `init` writes, if you need to paste it yourself:

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }
```

`exporter` is a table with the endpoint inside it, and the endpoint ends in
`/v1/logs`. It goes in your user-level `~/.codex/config.toml`.

### How Codex tokens are counted

OpenAI counts tokens differently from Anthropic. In Codex's numbers some counts
sit inside others:

- The cached tokens are part of the input count.
- The cache-write tokens are part of the input count too.
- The reasoning tokens are part of the output count.

So billing the input count and a cache slice together would charge that slice
twice. The meter takes the slices out first:

| MarginFront field  | From Codex                                       |
| ------------------ | ------------------------------------------------ |
| `inputTokens`      | input count, minus cached, minus cache-write     |
| `cacheReadTokens`  | cached count                                     |
| `cacheWriteTokens` | cache-write count, sent only when it's above zero |
| `outputTokens`     | output count, with reasoning already inside it   |

The raw cached, cache-write, reasoning and tool counts are kept in the record's
metadata for checking. They're never billed a second time.

Only recent Codex builds report a cache-write count, and older models report it as
zero. Because a zero is never sent, those setups never trip the missing cache-rate
check. When a model does report cache writes, its price row needs a cache-write rate,
or the event waits under **Needs attention** with no cost.

If a turn's two cache slices add up to more than its own input count, they're cut
down to fit, with the cache-read slice kept first. That record carries
`metadata.cacheSlicesClamped: true`, and its billed cache tokens read lower than the
raw counts beside them.

`--fold-cache` on Codex bills the whole input count at the input rate and sends
neither cache field. The cache-read part rounds up and the cache-write part rounds
down, as above.

Codex records are sent with the agent code `codex`, the signal `codex-turn` and the
provider `openai`. The `codex-auto-review` model is skipped, because it isn't a
billable model.

---

## What leaves your machine

Everything below goes to the one MarginFront server in `MARGINFRONT_API_URL`, and
nowhere else.

**Sent with each record:**

- **The developer's email, in plain text, on purpose.** Per-developer cost needs to
  know who ran the turn. With no email, the record goes under
  `claude-code-no-identity` or `codex-no-identity` instead.
- **The model, the token counts and a session id.** A Claude Code record also
  carries Claude Code's own dollar figure for the turn.
- **The name of each tool call and how many times it ran.** For an MCP tool that's
  the server name and the tool name, and nothing from its arguments.
- **The git repo, branch and commit,** when the session's folder resolves to one
  repo. The repo is `owner/repo` from its `origin` remote, so a checkout with no
  remote sends no repo name. To find the folder, the meter reads folder and file
  names under `~/.claude/projects/` and `~/.codex/sessions/`, and for Codex the first
  line of the session file, which holds the folder. It never reads further.
- **Your work item and the names you give `done`,** when you use them.
- **Your cache-write setting, and whether the cap check is on,** when they're set.

**Never sent:**

- Your prompts, the model's replies and your session transcripts.
- Your code and file contents.
- Tool call arguments, file paths and shell commands. The meter deletes them before
  the local capture file is written (see the top of this README).
- Your Anthropic or OpenAI key. The meter never reads it.

Your MarginFront key goes only in the request header to your server. It's never
written into `~/.claude/settings.json`, `~/.codex/config.toml` or any record.

---

## Troubleshooting

Run `node ~/.marginfront-ccc/cli.js status` first. It shows the key, the meter, the
Claude Code and Codex wiring, any queue, and the last lines of the meter's own logs.

- **"No MARGINFRONT_API_KEY found."** Paste your secret key after
  `MARGINFRONT_API_KEY=` in `~/.marginfront-ccc/.env`, or export it in the shell you
  start `run` from. `preview` works without a key.
- **HTTP 401 or 403.** The key is wrong, revoked, or a publishable key (`mf_pk_*`)
  where a secret key (`mf_sk_*`) is needed. Your usage isn't thrown away: the meter
  parks it in its on-disk queue, checks the key again every five minutes, and sends
  the queue once the key works. Save a new key, then `stop` and `start`, and sending
  resumes straight away.
- **Nothing arrives.** Check that `init` finished, that `status` shows the meter
  running, and that you reopened Claude Code and Codex after `init`. Then give it five
  minutes. If it's still empty, run `init` again to rewrite the collector settings.
- **A record has no cost.** Its model, or its cache rate, isn't in your server's price
  catalog yet. The tokens are stored and the event waits under **Needs attention**
  until you map it. Claude Code's own figure is in `metadata.claudeCodeCostUsd` to
  compare against.
- **Spend shows under `claude-code-no-identity` or `codex-no-identity`.** Your sign-in
  didn't report an email. Set `CCC_DEVELOPER_EMAIL` (see
  [Sharing one login across the team](#sharing-one-login-across-the-team)).
- **Codex spend is missing.** Check that the `[otel]` block is in your user-level
  `~/.codex/config.toml` in the shape shown under
  [Also capture Codex](#also-capture-codex), and that the meter is running.
- **"Collector integrity check FAILED."** The collector that downloaded doesn't match
  its pinned fingerprint, so it was deleted before it ran. The usual cause is a
  network that inspects and rewrites downloads, or a broken transfer. Run `init` again
  on a different network. Don't work around the check.
- **"Refusing to run an unverified collector."** `CCC_OTELCOL_VERSION` points at a
  release the meter has no fingerprint for. Unset it to use the pinned version.
- **A body-shape or validation error from the server.** Run
  `preview <capture.json>` to see the exact record the meter would send, and compare
  it with `/api-docs` on your running API.

---

## Development

```bash
npm run build       # one file: dist/cli.js
npm run typecheck
npm run lint
HOME=$(mktemp -d) npx vitest run
```

Always give the tests a throwaway `HOME`. They refuse to run against a real home that
holds a live install, because some of them call the real uninstall code.

## License

MIT. See `LICENSE`.
