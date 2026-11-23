# 0.20.0

> Entries from 0.19.2 down describe builds that were published to npm. Don't install
> those builds with `npx`: they send to an address this project doesn't control. Run
> `node ~/.marginfront-ccc/cli.js ...` instead.

Built from source, and you name the server (breaking).

You build this package from this repository, and it isn't published to npm. It
sends to the MarginFront server you name.

**What breaks, and what to do:**

- **You must name your server.** The meter has no built-in address. `init` asks for
  your MarginFront server's API address (including `/v1`), or takes it from
  `--api-url <address>`, and saves it as `MARGINFRONT_API_URL` in
  `~/.marginfront-ccc/.env`. With no address, `init`, `run`, the background meter and
  `done` stop with a message that says what to set. Nothing ever falls back to another
  address.
- **`MARGINFRONT_INGEST_URL` is no longer read.** It took a full endpoint address;
  `MARGINFRONT_API_URL` takes the address up to and including `/v1`. If only the old
  name is set, the meter stops and says so.
- **Run it with `node`, not `npx`.** Build with
  `npx turbo run build --filter=@marginfront/code-cost-clarity` from the repository
  root, then run `node packages/code-cost-clarity/dist/cli.js init`. `init` copies the
  program to `~/.marginfront-ccc/cli.js` on every platform, and every later command is
  `node ~/.marginfront-ccc/cli.js <command>`. Every printed command, and the note
  `init` can add to your assistant's memory file, now uses that spelling. Re-run
  `init` to replace a note written by an older build.
- **Nothing checks for updates.** The update offer in `init` and `status`, the
  background "newer version" line, and the `CCC_DISMISSED_UPDATE_VERSION` setting are
  removed. The meter never contacts the npm registry and never runs
  `npx ...@latest`. To update: pull, rebuild, run `init` again.
- **Any host you choose is allowed, but it must be encrypted.** The address must be
  `https://`, or `http://` to this machine (`localhost`, `127.0.0.1`, `[::1]`). Plain
  `http://` to another machine is refused unless `MARGINFRONT_ALLOW_INSECURE_HTTP=1`
  is set. An address with a username, password, `?query` or `#fragment` is refused.
- **Redirects are refused**, so your API key cannot follow one to another address.

**Fixed:**

- **The settings file now decides where the background meter sends.** The address was
  read when the program loaded, before the settings file was read, so a line in
  `~/.marginfront-ccc/.env` never reached the background meter. It is now read at
  every send.
- **A bad address stops the meter.** It is no longer ignored.
- **A path in front of `/v1` is kept.** The key check and the spend-cap reads kept
  only the host, so a server behind a path prefix got requests at the wrong address.

**Also changed:** the meter prints `Sending usage to <address>.` when it starts. The
links it prints now point at sections of this package's README, and the README
carries those sections. The markers around the blocks `init`
adds to `~/.codex/config.toml`, `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` no
longer contain an `npx` command; blocks written by older builds are still recognised
by `init` and removed by `uninstall`. The package is marked `private` so it
cannot be published by accident.

# 0.19.2

**The note that tells your AI assistant to count finished work now counts only what you
say is finished.** Nothing you set changes. Re-run `init` (stop first) to get the new
note; `uninstall` still takes it back out.

- **Fixed: the assistant recorded its own work as finished.** With the old note, Claude
  Code and Codex read "count the work you finish" as being about themselves and
  recorded their own scripts and answers as finished work. The note now says the
  outcomes belong to the person it is helping, lists the only names to count, and
  tells it never to count its own edits or invent a name.
- The note now shows the count form, `done "<name>" 3`, for several at once.
- The note tells the assistant the two commands need the network, so a sandboxed shell
  (Codex's default) asks for approval up front instead of failing first and sometimes
  skipping the work step without a word.

# 0.19.1

**A meter that fell far behind now catches up instead of stalling.** Nothing you set
changes, and records look the way they did in 0.19.0.

- **Fixed: a large backlog of unsent usage no longer freezes sending.** It affects you
  if the meter was stopped for weeks and then started again, or if it is catching up
  after you replaced a key that had stopped working. Before, the meter tried to read
  the whole backlog in one go, and past a certain size that read failed every second,
  so nothing went out, including new usage. Now it sends the backlog a piece at a
  time, oldest first, and new usage goes out as soon as it catches up. Each piece is
  sent once.
- The log says one line when a catch-up starts, with the size of the backlog, so a
  long catch-up doesn't look like a stuck meter.
- **Fixed: re-running `init` to upgrade no longer switches off finished-work counting
  when you press Enter.** If it is on, the question now shows what you count and Enter
  keeps it, and typing `n` still turns it off.

# 0.19.0

**One line keeps a named repo off the meter, and every other repo on that machine
keeps being metered.** Nothing you already set changes. Spend records look the way
they did in 0.18.0, with one exception: if your home directory is itself a git
checkout, records for work outside every other repo no longer carry a repo, branch or
commit. The dotfiles fix below says why.

- `CCC_IGNORE_REPOS=` in your settings file names the repos this machine never sends
  spend from, comma-separated `owner/repo`, for example
  `CCC_IGNORE_REPOS=acme-corp/billing,acme-corp/website`. A session in one of them
  produces nothing at all: no record is built, nothing is posted, and nothing waits in
  the outbox to go out later. Capital letters make no difference, and a trailing
  `.git` is fine, so pasting the tail of a remote URL works.
- **What you type by hand obeys the same line.**
  `node ~/.marginfront-ccc/cli.js done "<name>"` inside a named repo counts
  nothing, sends nothing, and tells you which line stopped it.
- **Records already waiting in the outbox are dropped, not sent.** If a repo's records
  were parked during an outage and you name that repo afterwards, they're discarded on
  the next attempt. Naming a repo right after you notice something you didn't want
  sent works the way it reads.
- **A session the meter can't place in a repo is still sent.** That one is deliberate.
  The meter comes up empty-handed for plenty of ordinary reasons, and holding all of
  those back would quietly stop metering a whole machine, with a spend number drifting
  to zero as the only sign. A session is held back only when the meter can name the
  repo it matched.
- There's nothing to restart. Add a repo, save the file, and the next record obeys the
  new line, the same way `CCC_WORK_ID` already does.
- `status` reads the rule back to you and names any entry that isn't `owner/repo`, so
  an entry that's ignoring nothing doesn't sit in the file looking like one that works.
  It says capitals make no difference, because it reads the names back lowercased, and
  it flags an entry that looks like a pasted web address (`github.com/acme-corp/billing`)
  for the same reason: that one looks right in the list and matches nothing.
- `preview` now reads your git repo the way the running meter does, which it never did
  before, so what it prints is what would be sent. When it refuses a capture it says
  which repo it refused, so a preview that comes back empty isn't mistaken for a
  broken capture.
- **Fixed: a home directory that is itself a git repo no longer swallows the machine.**
  It affects you if you keep your dotfiles as a git checkout in your home directory.
  Before, every session on that machine was attributed to the dotfiles repo, wherever
  the work actually happened, so naming that repo on the line above would have kept
  the entire machine off the meter. Now a session whose only enclosing repository is
  the home directory carries no repo, branch or commit at all. That's the right
  answer because it's the one a folder outside every repo already got, and those
  records are still sent, carrying no repo instead of the wrong one.
- The settings file `init` writes carries the new line, blank, with an example and the
  fail-open promise beside it. `init` never rewrites a settings file you already have,
  so on an existing install you add the line yourself.
- Nothing else about metering changed. With the line blank, a machine sends records
  identical to the ones 0.18.0 sent, field for field. The one machine that differs is
  the dotfiles one above.

# 0.18.0

**The meter can now count what your AI finishes, not only what it spends.** Two new
commands, one optional question, and the setting that puts your spend on a job reads
in plain English. Nothing you already set stops working, and nothing here changes
what a spend record looks like.

- `CCC_WORK_ID=` in your settings file is the new name for the line that tags this
  machine's spend. `CCC_MATTER_ID=` was the name v0.17.0 shipped and still works, so a
  machine you set up then keeps reporting exactly as it does today. If both lines
  carry a value, `CCC_WORK_ID` is the one used; a blank `CCC_WORK_ID=` line never
  overrides a value you left on the older line.
- `status`, `init` and `preview` say "work item" where they used to say "matter".
  `status` names whichever key your own file uses, so it never points you at a line you haven't
  got.
- The settings file `init` writes explains the line with an everyday example, and
  documents both key names.
- On Windows, `status` now prints the real path to your settings file instead of a
  tilde path Windows doesn't use. Every other row of `status` already did.
- On Windows, `status` can now read Codex's trust state, and the update offer can
  now run the update. npm installs `codex` and `npx` as `.cmd` files, and Windows
  wouldn't start them from a bare name, so the Codex row read CAN'T TELL on a
  machine with a perfectly good Codex and "Update now?" printed a command for you to
  type by hand. Both find those files now. Nothing changes on macOS or Linux.
- Also on Windows: when Codex stops answering, `status` now shuts down every process
  it started, not only the one Windows hands back. Before this, a wedged Codex was
  left running and each later `status` left another one behind.
- **New: count what you finish, not only what you spend.** `done "contract summarized"`
  records one finished thing, `done "contract summarized" 3` records three, and your ROI
  page lists each name with the AI cost attributed to it. A finished thing is priced
  at zero, so recording one can never move your spend number.
- **New: `work` sets the work item from the command line.** `work "Q3 pricing model"`
  sets it, `work` on its own prints the one in effect, and `work --clear` removes it.
  There's still nothing to restart, and `--clear` clears the older `CCC_MATTER_ID`
  line too, so clearing really clears.
- Finished-work counting is off until you turn it on. `init` asks one question at the
  end and it defaults to no; `--no-prompt` never sees it. Say yes and it asks what you
  finish, then adds a short note to your assistant's memory file (`~/.claude/CLAUDE.md`
  for Claude Code, `~/.codex/AGENTS.md` for Codex) so it records them as it works.
  `uninstall` takes that note back out byte for byte, and `done --setup` asks both
  questions again whenever you change your mind. `status` says which mode you're in.
- `done` refuses rather than guesses. With no developer email it records nothing and
  says how to fix it. With both assistants installed and neither seen working yet, it
  asks you to name one with `--agent`, and on a machine with both, each assistant's
  own note already carries its own flag so it never has to ask. Offline it goes into the same outbox your turns
  use, and the meter sends it the next time it's running. On Linux and WSL that means
  the next time you run `node ~/.marginfront-ccc/cli.js run`.
- Nothing about spend counting changed. A machine with neither line set, and nobody
  running `done`, sends records identical to the ones v0.16.0 sent, field for field.

# Earlier versions

Versions before 0.18.0 were published to npm, and their notes aren't kept here.
Don't install those builds: they send your API key and usage to an address this
project doesn't control. See
[docs/packages.md](../../docs/packages.md#dont-install-them-from-npm).
