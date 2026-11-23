/**
 * Copy for the repo-missing helper on the Internal AI Spend breakdown. No
 * React and no `@marginfront/db`: a 'use client' section imports it, the same
 * client-bundle rule install-kit.ts and repo-spend.ts are pinned against.
 */

import { CCC_COMMAND_INVOCATION } from '@/lib/meter-command'
import { CCC_INIT_COMMAND } from './install-kit'

export const REPO_HELP_TOGGLE = "Expected a repo that isn't here?"

export const REPO_HELP_INTRO =
  'The meter stamps a repo when a session starts inside a git checkout that has an origin remote. Hand this to the AI assistant on the machine that should be reporting. It walks through every reason a repo goes missing and tells you what it found.'

export const REPO_HELP_PROMPT_LABEL = 'Prompt for your AI assistant'

export const REPO_HELP_COPY_LABEL = 'Copy'
export const REPO_HELP_COPIED_LABEL = 'Copied'

export const REPO_HELP_AFTER =
  'Sessions already sent stay under No repo recorded. The next session started in the checkout carries the repo.'

export const REPO_HELP_PROMPT = `My team uses the MarginFront meter (Code Cost Clarity, built from the MarginFront source) to record Claude Code and Codex spend, and a repo I work in isn't showing up under By repo on the Internal AI Spend page. Please walk me through why, one check at a time, and tell me what you found after each one. Ask before you change anything.

HOW THE METER PICKS THE REPO: it maps each session to the folder it started in, then asks git three things from that folder: the current commit, the current branch, and the URL of the remote named origin. The repo name is the owner/repo part of that URL. If any of that fails, the session is still sent with no repo and lands under "No repo recorded". Only new sessions pick up a fix; sessions already sent keep what they had.

CHECKS, in order:
1. Which tool. The meter counts Claude Code and Codex from the terminal, and on Mac the Claude desktop app too. On Windows the Claude desktop app isn't counted yet, so its usage never reaches the page, not even the No repo recorded row.
2. Version. The installed meter is a copy at ~/.marginfront-ccc/cli.js (Windows: %USERPROFILE%\\.marginfront-ccc\\cli.js). Run \`node ~/.marginfront-ccc/cli.js version\` (Windows: \`node %USERPROFILE%\\.marginfront-ccc\\cli.js version\`) and read the version it prints. If the file is missing or the command isn't recognized, the meter is older than these checks. Repo stamps need 0.8.2 or newer for Claude Code and 0.16.0 or newer for Codex. If mine is older, get the latest MarginFront source and install again (\`${CCC_INIT_COMMAND}\`, plus \`--control\` if my team uses spend caps; if the marginfront folder already exists, run \`git pull\` inside it instead of cloning). It keeps the settings file I already have.
3. Ignore list. Run \`${CCC_COMMAND_INVOCATION} status\` and read the "Ignoring:" line. If it names my repo, that's the answer: a repo on that list sends nothing at all, so it never appears anywhere on the page. The list is the CCC_IGNORE_REPOS line in the settings file: ~/.marginfront-ccc/.env on Mac and Linux, %USERPROFILE%\\.marginfront-ccc\\.env on Windows. Don't remove a repo from it unless I say so.
4. The folder. I have to start Claude Code or Codex from inside the repo's checkout (any subfolder works). From that folder, run \`git rev-parse --show-toplevel\`. If git says it isn't a repository, that's the reason. If the top level it prints is my home folder itself, the meter drops the stamp on purpose (a home folder that doubles as a git repo would swallow every session on the machine), so the checkout needs a folder of its own.
5. The remote. From the same folder, run \`git remote get-url origin\`. It has to exist and look like a hosted URL: https://github.com/owner/repo, git@github.com:owner/repo.git, or the same shape on another host. No origin, or an origin that points at a folder on this disk instead of a hosted URL, means no repo name. If my remote has a different name, add one called origin that points at the same URL.
6. Git itself. The background meter runs git on its own. On Mac it runs with the system PATH, so git has to be the system one: run \`/usr/bin/git --version\`, and if that fails, install the Xcode command line tools with \`xcode-select --install\`. On Windows, open a new PowerShell window and run \`git --version\`; that means Git for Windows installed with its default PATH choice. If those can't find git, the meter can't either.
7. Codex only. Codex sessions carry a repo since 0.16.0, and only when the session was started from an absolute folder path that still exists. Start Codex from the checkout folder, not from a shortcut that opens somewhere else.
8. Prove it. Start a new session inside the checkout, do one small thing, wait a couple of minutes, then reload the page with the period set to This month (it runs on UTC time). By branch shows the branch the session ran on; a detached HEAD shows no branch.

WHAT I'D LIKE BACK: which check failed, one line each, and what you changed. If every check passes and the repo still isn't there after a new session, tell me to send my admin the "CCC version" line and the output of \`git remote get-url origin\`.`
