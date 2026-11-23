'use client'

/**
 * WHAT THIS FILE DOES: The Getting Started page. Four setup paths organized
 * by how you want to integrate (Guided walkthrough, AI Assistant (MCP), Node
 * SDK, REST API), each broken into numbered collapsible step rows that all
 * end at the same place: your first usage event visible in the Raw Events
 * view. A fifth "Pricing examples" tab holds reference material and is
 * reachable from a secondary button, not the path strip.
 *
 * The tab strip asks "how do you want to integrate?", the hero leads with
 * the outcome (first event in under 5 minutes), and the shared "What you
 * need" / revenue-setup sections render once below the tabs. The API
 * auto-creates customer/agent/signal on the first event, so no path needs
 * entity-creation steps first.
 *
 * CONNECTS TO: SetupMethodModal.tsx (pushes ?method= deep links here; the tab
 * ids are that contract, never rename them), src/lib/storage.ts (saved-path
 * persistence), /build?tab=keys (key minting),
 * /developer-zone/sdk-simulator, and /metrics-events/raw-events (the step
 * rows link out to these).
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Sparkles,
  Zap,
  Copy,
  Check,
  BookOpen,
  Rocket,
  Cpu,
  Code2,
  Globe,
  ClipboardEdit,
  CircleDot,
  CircleCheck,
  ExternalLink,
  Lightbulb,
  Clock,
  ChevronDown,
  Users,
  Terminal,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useAuth } from '@/hooks/use-auth'
import { storage } from '@/lib/storage'
import { CCC_INIT_COMMAND } from '@/features/internal-ai-spend/install-kit'
import { docsLink, publicApiBaseUrl } from '@/config/operator'
import {
  API_URL_ENV_VAR,
  CCC_README_PATH,
  MCP_README_PATH,
  MCP_SERVER_ENTRY,
  MCP_WORKSPACE,
  SDK_LOCAL_INSTALL_COMMAND,
  SDK_README_PATH,
  SDK_WORKSPACE,
  cccServerAddressLine,
  cloneAndBuildCommand,
  sourceRepoLabel,
} from '@/config/source-install'
import { Page } from '@/components/layouts/page'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// ============================================
// WHERE THE SNIPPETS POINT
// ============================================
// Every address below comes from this copy's own configuration: the API base
// URL the dashboard talks to, and the operator's docs site when one is set.
// With no docs site, the prompts send readers to the package READMEs in the
// MarginFront source instead.

const API_BASE = publicApiBaseUrl()

const DOCS = {
  mcp: docsLink('/mcp/setup'),
  sdk: docsLink('/sdk/tracking-events'),
  api: docsLink('/api-reference/usage-events'),
  quickstart: docsLink('/api-reference/quickstart'),
  ccc: docsLink('/tools/code-cost-clarity'),
  concepts: docsLink('/concepts'),
  signalNaming: docsLink('/concepts#choosing-your-signal-name-and-quantity'),
}

function inSource(readmePath: string): string {
  return `${readmePath} in the MarginFront source (${sourceRepoLabel()})`
}

function readFirst(link: string | null, readmePath: string): string {
  return link
    ? `Read the docs first so you use the current, complete contract: start with ${link} and read the pages relevant to this integration so you miss nothing.`
    : `Read the docs first so you use the current, complete contract: they are in ${inSource(readmePath)}.`
}

function fullGuide(link: string | null, readmePath: string): string {
  return `Full guide: ${link ?? inSource(readmePath)}`
}

const MCP_CONFIG_EXAMPLE = `{
  "mcpServers": {
    "marginfront": {
      "command": "node",
      "args": ["${MCP_SERVER_ENTRY}"],
      "env": {
        "MF_API_SECRET_KEY": "mf_sk_your_key_here",
        "${API_URL_ENV_VAR}": "${API_BASE}"
      }
    }
  }
}`

// ============================================
// AI ASSISTANT PROMPTS
// ============================================
// One per code tab, surfaced in the "Using an AI assistant?" block. The
// endpoint, header, and payload shapes below were verified against the
// api-nest source, so an assistant following them hits
// the real API contract. These are customer-facing strings: edit with care,
// and keep the success surface in sync with the "See it land" step rows.

const MCP_AI_PROMPT = `Set up the MarginFront MCP server (the @marginfront/mcp package, usage-based billing for AI agents). Help me do two things: first fire one test usage event to prove it works, then add permanent usage tracking to my codebase.

${readFirst(DOCS.mcp, MCP_README_PATH)}

Connect the server (skip if it is already connected in my MCP client):
1. Build the MCP server from the MarginFront source: ${cloneAndBuildCommand(MCP_WORKSPACE)}
2. Add the server to my MCP client's config, with the real absolute path to the built file. Where that config lives depends on my client; ${MCP_README_PATH} in the source covers each one:

{
  "mcpServers": {
    "marginfront": {
      "command": "node",
      "args": ["${MCP_SERVER_ENTRY}"],
      "env": {
        "MF_API_SECRET_KEY": "\${MF_API_SECRET_KEY}",
        "${API_URL_ENV_VAR}": "${API_BASE}"
      }
    }
  }
}

3. My API key starts with mf_sk_ (MarginFront dashboard, Build page, API keys tab). I will set it as the MF_API_SECRET_KEY environment variable and reference it in the config as shown above. Do not ask me to paste the raw key into this chat, and never write it into a committed file.
4. Tell me to restart or reload my MCP client so the tools appear.

Phase 1, prove it works. Call record_usage with exactly these arguments: customerExternalId "test-customer-001", agentCode "test-agent", signalName "messages", model "gpt-4o", modelProvider "openai", inputTokens 523, outputTokens 117. Use only those fields. MarginFront auto-creates the customer, agent, and signal on the first event, so it is fine if they do not exist yet. If it errors, show me the exact error text; do not guess new fields.
Phase 1 is done when record_usage returns success. The tool result confirms MarginFront recorded the event.

Phase 2, make it permanent. This is the real goal. MCP runs in this chat and is great for ad-hoc analytics and backfills, but it is NOT what runs in my production app. To instrument my product, use the MarginFront SDK or the REST API, whichever fits my stack: find the exact place where my agent finishes the unit of work my customer pays for (the billable outcome behind the signal), and record one event there. One outcome is one event, whether it used a single service or several (sent as a services[] array). See ${DOCS.sdk ?? inSource(SDK_README_PATH)}. The API address is ${API_BASE}. Send it non-blocking so billing never delays my app, and read the API key from an environment variable (MARGINFRONT_API_KEY). Tell me which file and function you chose and why, and show me the diff before you apply it.

Use only fields documented in the docs above. For one outcome backed by several providers (say a report that called an LLM and a maps API), record ONE event with the documented services: [] array, not several events. If anything returns a 401, stop: my key is wrong or expired, so tell me to check it. Do not invent fields to work around an error.`

const SDK_AI_PROMPT = `Help me add MarginFront (usage-based billing for AI agents) to my Node.js or TypeScript app: first fire one test event, then wire it into my real code.

${readFirst(DOCS.sdk, SDK_README_PATH)}

1. Build the SDK from the MarginFront source, next to my app's folder: ${cloneAndBuildCommand(SDK_WORKSPACE)}
   Then, from my app's folder, install the built copy: ${SDK_LOCAL_INSTALL_COMMAND}
2. My API key starts with mf_sk_ (MarginFront dashboard, Build page, API keys tab). I will set it as the MARGINFRONT_API_KEY environment variable; your code reads process.env.MARGINFRONT_API_KEY. Do not ask me to paste the raw key into this chat, and never hardcode it into committed code.

Phase 1, prove it works. Create a throwaway script (save as track.ts, run with npx tsx track.ts) with exactly this shape, no extra options:

import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: process.env.MARGINFRONT_API_KEY,
  baseUrl: "${API_BASE}",
  fireAndForget: false, // surface real errors during this test
});

const result = await client.usage.record({
  customerExternalId: "test-customer-001",
  agentCode: "test-agent",
  signalName: "messages",
  model: "gpt-4o",
  modelProvider: "openai",
  inputTokens: 523,
  outputTokens: 117,
});
console.log(result);

MarginFront auto-creates the customer, agent, and signal on the first event. If anything fails, show me the exact error; do not guess new fields. A 401 means the key is wrong or expired, so stop and tell me to check it.
Phase 1 is done when the record() call resolves and the returned result confirms success. The response shape is in ${DOCS.sdk ?? inSource(SDK_README_PATH)}.

Phase 2, make it permanent. This is the real goal. Find the exact place in my codebase where my agent finishes the unit of work my customer pays for (the billable outcome behind the signal), and add one client.usage.record() call there. Use fireAndForget: true in production so billing never blocks my app, and read the key from the environment. Tell me which file and function you chose and why, and show me the diff before applying.

Use only fields documented in the docs above. For one outcome backed by several providers, record ONE event with the documented services: [] array, not several. For a non-LLM unit of work, swap the two token fields for quantity. Do not invent, rename, or add fields.`

const API_AI_PROMPT = `Help me record MarginFront usage events (usage-based billing for AI agents) over raw HTTP: first one test event, then wire it into my app.

${readFirst(DOCS.api, SDK_README_PATH)}

Phase 1, prove it works.
Endpoint: POST ${API_BASE}/usage/record
Headers: x-api-key: YOUR_API_KEY and Content-Type: application/json
Body, use exactly these fields:

{
  "records": [
    {
      "customerExternalId": "test-customer-001",
      "agentCode": "test-agent",
      "signalName": "messages",
      "model": "gpt-4o",
      "modelProvider": "openai",
      "inputTokens": 523,
      "outputTokens": 117
    }
  ]
}

My API key starts with mf_sk_ (MarginFront dashboard, Build page, API keys tab). I will set it as an environment variable; read it from the environment. Do not ask me to paste the raw key into this chat, and never hardcode it into a committable file. MarginFront auto-creates the customer, agent, and signal on the first event. If the request fails, show me the exact HTTP status and response body; do not guess new fields. A 401 means the key is wrong or expired, so stop and tell me to check it.
Phase 1 is done when the response is HTTP 200 with "successful": 1. That response confirms MarginFront recorded the event; see ${DOCS.api ?? inSource(SDK_README_PATH)}.

Phase 2, make it permanent. This is the real goal. Find the exact place in my codebase where my agent finishes the unit of work my customer pays for (the billable outcome behind the signal), and add the POST there, reading the key from the environment, in a way that never blocks the user-facing path (send it async or after you return the response). Tell me which file and function you chose and why, and show me the diff before applying.

Required fields: customerExternalId, agentCode, signalName, plus model and modelProvider (and inputTokens/outputTokens) for an LLM unit, or quantity for a non-LLM unit. For one outcome backed by several providers, send ONE record with the documented services: [] array, not several records. Use only fields documented in the docs above; do not invent, rename, or add fields.`

// ============================================
// DEV-TEAM BRIEFS
// ============================================
// The other half of the audience toggle: a plain-English brief a founder hands
// to their engineers instead of pasting the AI prompt. Same integration, told
// as "what to build and where it goes in your code." Customer-facing strings:
// edit with care, keep in sync with the *_AI_PROMPT above.

const SDK_DEV_BRIEF = `Brief for your engineers: add MarginFront usage tracking to your app.

What it is: MarginFront meters usage-based billing. You send one event when your app finishes a billable task, and MarginFront prices it.

Where it goes: put the usage.record() call where your app finishes one billable task and records what it used, the moment the work is done and you know what it took. That point is your signalName: one finished task is one billable unit. If the task used several paid services, send them together as services[] on that one call, so one task is one event with its cost lines. If your app has no single "task finished" moment and records each step, put a call at each step instead: more, smaller events, but nothing slips.

What to send:
- customerExternalId: your own stable ID for the user the usage belongs to. Spend breaks down per user.
- signalName: a short, fixed name for the task, like "messages" or "reports". You group cost by this, and it is what the customer sees on their invoice.
- services[]: when one task used several paid providers, send one line per provider on the single event. That gives you a per-line cost breakdown.

${fullGuide(DOCS.sdk, SDK_README_PATH)}`

const API_DEV_BRIEF = `Brief for your engineers: record MarginFront usage events over HTTP.

What it is: MarginFront meters usage-based billing. You POST one event when your app finishes a billable task, and MarginFront prices it. Works from any language.

Where it goes: send the POST where your app finishes one billable task and records what it used, the moment the work is done and you know what it took. That point is your signalName: one finished task is one billable unit. If the task used several paid services, send them together as services[] on that one record, so one task is one event with its cost lines. If your app has no single "task finished" moment and records each step, POST at each step instead: more, smaller events, but nothing slips.

What to send:
- customerExternalId: your own stable ID for the user the usage belongs to. Spend breaks down per user.
- signalName: a short, fixed name for the task, like "messages" or "reports". You group cost by this, and it is what the customer sees on their invoice.
- services[]: when one task used several paid providers, send one line per provider on the single record. That gives you a per-line cost breakdown.

Send it to ${API_BASE}/usage/record.

${fullGuide(DOCS.api, SDK_README_PATH)}`

const MCP_DEV_BRIEF = `Brief for your engineers: MCP is for your AI assistant, not your production app.

What it is: the MCP server lets an AI tool (Claude Desktop, Claude Code, Cursor, or VS Code) fire test events and run one-off analytics from a chat. Good for proving the setup. It is not what should run in your product. Connect it by building packages/mcp from the MarginFront source and adding it to your MCP client config (see the MCP tab, or ${DOCS.mcp ?? inSource(MCP_README_PATH)}).

To meter your product for real, use the SDK or REST path: add one usage call where your app finishes one billable task and records what it used. That point is your signalName: one finished task is one billable unit. If the task used several paid services, send them together as services[] on that one call, so one task is one event with its cost lines.

What to send:
- customerExternalId: your own stable ID for the user the usage belongs to. Spend breaks down per user.
- signalName: a short, fixed name for the task. You group cost by this, and it is what the customer sees on their invoice.
- services[]: when one task used several paid providers, send one line per provider on the single event. That gives you a per-line cost breakdown.

${fullGuide(DOCS.mcp, MCP_README_PATH)}`

const CCC_AI_PROMPT = `Help me set up MarginFront Code Cost Clarity to track what my Claude Code and Codex usage costs.

${readFirst(DOCS.ccc, CCC_README_PATH)}

1. Run: ${CCC_INIT_COMMAND}
   It downloads the MarginFront source and builds the meter on this computer. It needs git and Node.js 20 or newer.
2. Follow the prompts. ${cccServerAddressLine()}. It installs a local collector that reads my coding agents' usage and reports the cost to MarginFront. It does not change any of my product code.
3. Tell me what it changed on my machine and how to confirm data is flowing.

This is internal cost visibility for my own team's AI spend. It isn't for billing my customers. If it asks for anything that looks like it would bill customers, stop and tell me, because that's the wrong tool.`

const CCC_DEV_BRIEF = `Brief for your team: track what your own Claude Code and Codex usage costs.

What it is: Code Cost Clarity is internal cost tracking, not customer billing. It watches what your AI coding agents cost you, and it does not touch your product code.

Setup, per machine where your team runs coding agents (needs git and Node.js 20 or newer): run ${CCC_INIT_COMMAND} and follow the prompts. ${cccServerAddressLine()}. It installs a local collector that reports your coding-agent spend to MarginFront.

What you get: your Claude Code and Codex spend in the dashboard, broken down by developer and model.

${fullGuide(DOCS.ccc, CCC_README_PATH)}`

// ============================================
// SHARED HELPERS
// ============================================

const CodeBlock = ({
  label,
  code,
  displayCode,
  copyId,
  copiedId,
  onCopy,
}: {
  label: string
  code: string
  displayCode?: React.ReactNode
  copyId: string
  copiedId: string | null
  onCopy: (text: string, key: string) => void
}) => (
  <div className='overflow-hidden rounded-xl border border-border/60 bg-zinc-950'>
    <div className='flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-4 py-2'>
      <div className='flex items-center gap-2'>
        <div className='flex gap-1.5'>
          <div className='h-3 w-3 rounded-full bg-red-500/80' />
          <div className='h-3 w-3 rounded-full bg-yellow-500/80' />
          <div className='h-3 w-3 rounded-full bg-green-500/80' />
        </div>
        <span className='ml-2 text-xs text-zinc-400'>{label}</span>
      </div>
      <button
        className='flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700'
        onClick={() => onCopy(code, copyId)}
      >
        {copiedId === copyId ? (
          <Check className='h-3.5 w-3.5 text-green-400' />
        ) : (
          <Copy className='h-3.5 w-3.5' />
        )}
        {copiedId === copyId ? 'Copied!' : 'Copy'}
      </button>
    </div>
    <pre className='max-h-80 overflow-x-auto p-4 font-mono text-sm text-zinc-100'>
      <code>{displayCode || code}</code>
    </pre>
  </div>
)

// Restates the selected path in words under the tab strip, so selection is
// never signaled by color alone (WCAG 1.4.1). aria-live lets screen-reader
// users hear path changes without re-scanning the tab list.
const PathBanner = ({ tab }: { tab: string }) => {
  const config = TAB_CONFIG.find((t) => t.id === tab)
  return (
    <div
      role='status'
      aria-live='polite'
      className='mt-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5'
    >
      <p className='text-sm font-medium text-foreground'>
        {config
          ? config.banner
          : 'Reference only. This tab will not change the path you picked above.'}
      </p>
    </div>
  )
}

// One collapsible setup step. Independent Collapsibles (not an accordion) on
// purpose: the user needs step 1 (their API key) to stay visible while doing
// step 3. Optional rows drop the number and show an "Optional" pill instead.
const StepRow = ({
  step,
  title,
  minutes,
  optional = false,
  defaultOpen = false,
  children,
}: {
  step?: number
  title: string
  minutes?: string
  optional?: boolean
  defaultOpen?: boolean
  children: React.ReactNode
}) => (
  <Collapsible
    defaultOpen={defaultOpen}
    className='rounded-xl border border-border/60 bg-background'
  >
    <CollapsibleTrigger className='flex w-full items-center gap-3 px-4 py-3 text-left [&[data-state=open]>svg:last-child]:rotate-180'>
      {step !== undefined && (
        <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary'>
          {step}
        </span>
      )}
      <span className='flex-1 text-sm font-medium text-foreground'>
        {title}
      </span>
      {optional && (
        <Badge variant='outline' className='font-medium text-muted-foreground'>
          Optional
        </Badge>
      )}
      {minutes && (
        <Badge variant='secondary' className='gap-1 font-medium'>
          <Clock className='h-3 w-3' aria-hidden='true' />
          {minutes}
        </Badge>
      )}
      <ChevronDown
        className='h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200'
        aria-hidden='true'
      />
    </CollapsibleTrigger>
    <CollapsibleContent className='px-4 pb-4 pt-1'>
      {children}
    </CollapsibleContent>
  </Collapsible>
)

// The short-circuit for AI-assisted users: one copy button hands their
// assistant the entire tab's setup as a verified prompt. Sits ABOVE the step
// rows so those users never have to read them. Deliberately NOT a CodeBlock:
// this is plain English you paste into an AI chat, not code you run, so it
// gets a light on-brand surface instead of terminal chrome.
const AiPromptBlock = ({
  prompt,
  copyId,
  copiedId,
  onCopy,
  minutes,
}: {
  prompt: string
  copyId: string
  copiedId: string | null
  onCopy: (text: string, key: string) => void
  minutes?: string
}) => (
  <div className='space-y-2'>
    <div className='flex items-center justify-between gap-3'>
      <p className='text-sm font-medium text-foreground'>
        Hand this to your AI coding tool (Claude Code, Cursor, or GitHub
        Copilot). It does this whole path for you.
      </p>
      {minutes && (
        <Badge variant='secondary' className='shrink-0 gap-1 font-medium'>
          <Clock className='h-3 w-3' aria-hidden='true' />
          {minutes}
        </Badge>
      )}
    </div>
    <div className='rounded-xl border border-primary/30 bg-primary/[0.05] shadow-sm'>
      <div className='flex items-center justify-between border-b border-primary/10 px-4 py-2'>
        <div className='flex items-center gap-2'>
          <Sparkles className='h-3.5 w-3.5 text-primary' aria-hidden='true' />
          <span className='text-xs font-medium text-primary'>
            Prompt for your AI assistant
          </span>
        </div>
        <button
          className='flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20'
          onClick={() => onCopy(prompt, copyId)}
        >
          {copiedId === copyId ? (
            <Check className='h-3.5 w-3.5 text-emerald-500' />
          ) : (
            <Copy className='h-3.5 w-3.5' />
          )}
          {copiedId === copyId ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className='max-h-96 overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90'>
        {prompt}
      </pre>
    </div>
  </div>
)

// Mirror of AiPromptBlock for the human handoff: same copy mechanics and <pre>
// block, but a neutral slate surface so the "hand this to your team" brief is
// visually distinct from the "hand this to your AI" prompt. No minutes badge:
// a brief is read, not clocked against a stopwatch.
const DevBriefBlock = ({
  brief,
  copyId,
  copiedId,
  onCopy,
}: {
  brief: string
  copyId: string
  copiedId: string | null
  onCopy: (text: string, key: string) => void
}) => (
  <div className='space-y-2'>
    <div className='flex items-center justify-between gap-3'>
      <p className='text-sm font-medium text-foreground'>
        Hand this to your engineers. It says what to build and where it goes in
        your code.
      </p>
    </div>
    <div className='rounded-xl border border-border/60 bg-muted/40 shadow-sm'>
      <div className='flex items-center justify-between border-b border-border/60 px-4 py-2'>
        <div className='flex items-center gap-2'>
          <Users
            className='h-3.5 w-3.5 text-foreground/70'
            aria-hidden='true'
          />
          <span className='text-xs font-medium text-foreground/80'>
            Brief for your dev team
          </span>
        </div>
        <button
          className='flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/70'
          onClick={() => onCopy(brief, copyId)}
        >
          {copiedId === copyId ? (
            <Check className='h-3.5 w-3.5 text-emerald-500' />
          ) : (
            <Copy className='h-3.5 w-3.5' />
          )}
          {copiedId === copyId ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className='max-h-96 overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90'>
        {brief}
      </pre>
    </div>
  </div>
)

// The prompt area toggles between two audiences: a paste-into-your-coding-agent
// prompt, and a plain-English brief a founder can hand to their engineers. Same
// integration, two ways to hand it off. Local state only; each tab owns its own.
const DualAudiencePrompt = ({
  aiPrompt,
  devBrief,
  copyIdBase,
  copiedId,
  onCopy,
  minutes,
}: {
  aiPrompt: string
  devBrief: string
  copyIdBase: string
  copiedId: string | null
  onCopy: (text: string, key: string) => void
  minutes?: string
}) => {
  const [audience, setAudience] = useState<'ai' | 'team'>('ai')
  return (
    <div className='space-y-3'>
      <div
        role='tablist'
        aria-label='Who is setting this up'
        className='inline-flex rounded-lg border border-border/60 bg-muted/50 p-0.5 text-xs font-medium'
      >
        <button
          role='tab'
          aria-selected={audience === 'ai'}
          onClick={() => setAudience('ai')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors ${
            audience === 'ai'
              ? 'bg-primary/10 text-primary shadow-sm ring-1 ring-primary/40'
              : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          <Sparkles className='h-3.5 w-3.5' aria-hidden='true' />
          For your AI
        </button>
        <button
          role='tab'
          aria-selected={audience === 'team'}
          onClick={() => setAudience('team')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors ${
            audience === 'team'
              ? 'bg-primary/10 text-primary shadow-sm ring-1 ring-primary/40'
              : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          <Users className='h-3.5 w-3.5' aria-hidden='true' />
          For your team
        </button>
      </div>

      {audience === 'ai' ? (
        <AiPromptBlock
          prompt={aiPrompt}
          copyId={`${copyIdBase}-ai`}
          copiedId={copiedId}
          onCopy={onCopy}
          minutes={minutes}
        />
      ) : (
        <DevBriefBlock
          brief={devBrief}
          copyId={`${copyIdBase}-team`}
          copiedId={copiedId}
          onCopy={onCopy}
        />
      )}
    </div>
  )
}

// ============================================
// SHARED SECTION COMPONENTS
// ============================================

const WhatYouNeed = () => (
  <div className='space-y-4 rounded-xl border border-border/60 bg-muted/30 p-5'>
    <p className='text-sm font-medium text-foreground'>
      What you need in MarginFront
    </p>

    <div className='space-y-2'>
      <p className='text-xs font-medium uppercase tracking-wide text-muted-foreground'>
        Always required (cost tracking)
      </p>
      <div className='flex flex-col gap-1.5'>
        {['Customer', 'Agent', 'Signal'].map((item) => (
          <div key={item} className='flex items-center gap-2'>
            <CircleCheck className='h-4 w-4 text-emerald-500' />
            <span className='text-sm text-foreground'>{item}</span>
          </div>
        ))}
      </div>
    </div>

    <div className='space-y-2'>
      <p className='text-xs font-medium uppercase tracking-wide text-muted-foreground'>
        Add when you need revenue tracking and invoicing
      </p>
      <div className='flex flex-col gap-1.5'>
        {['Pricing Plan', 'Subscription'].map((item) => (
          <div key={item} className='flex items-center gap-2'>
            <CircleDot className='h-4 w-4 text-muted-foreground' />
            <span className='text-sm text-foreground'>{item}</span>
          </div>
        ))}
      </div>
    </div>

    <p className='text-xs text-muted-foreground'>
      Cost tracking works as soon as you log your first event. Revenue and
      invoicing require a pricing plan and subscription. You can add those
      whenever you are ready. No need to set them up now.
    </p>
  </div>
)

const RevenueSetup = () => (
  <Card className='overflow-hidden rounded-xl border border-amber-500/30 shadow-sm'>
    <CardHeader className='border-b border-amber-500/20 bg-amber-500/5'>
      <CardTitle className='text-base'>Ready for revenue tracking?</CardTitle>
      <CardDescription>
        Add a pricing plan and subscription to see what you charge your
        customers, not just what things cost you
      </CardDescription>
    </CardHeader>
    <CardContent className='space-y-4 pt-6'>
      {DOCS.concepts ? (
        <a
          href={DOCS.concepts}
          target='_blank'
          rel='noopener noreferrer'
          className='inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-2 hover:underline'
        >
          Learn how pricing and subscriptions work
          <ExternalLink className='h-3.5 w-3.5' />
        </a>
      ) : (
        <p className='text-sm text-muted-foreground'>
          Open{' '}
          <a
            href='/build'
            className='font-medium text-primary underline-offset-2 hover:underline'
          >
            Build
          </a>
          , pick an agent, and add a pricing plan. Then give a customer a
          subscription to that plan.
        </p>
      )}
    </CardContent>
  </Card>
)

const DocsButton = ({
  href,
  children,
}: {
  href: string | null
  children: React.ReactNode
}) =>
  href ? (
    <a
      href={href}
      target='_blank'
      rel='noopener noreferrer'
      className='flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90'
    >
      {children}
      <ExternalLink className='h-3.5 w-3.5' />
    </a>
  ) : null

const WhatYouGet = () => (
  <div className='space-y-3'>
    <p className='text-sm font-medium text-foreground'>What you get</p>
    <div className='grid gap-4 sm:grid-cols-3'>
      <div className='rounded-xl border border-border/60 bg-muted/30 p-4'>
        <p className='text-sm font-medium text-foreground'>Per-model costs</p>
        <p className='mt-1 text-xs text-muted-foreground'>
          See which models cost the most and compare across providers
        </p>
      </div>
      <div className='rounded-xl border border-border/60 bg-muted/30 p-4'>
        <p className='text-sm font-medium text-foreground'>
          Per-customer breakdown
        </p>
        <p className='mt-1 text-xs text-muted-foreground'>
          Know exactly what each customer costs you to serve
        </p>
      </div>
      <div className='rounded-xl border border-border/60 bg-muted/30 p-4'>
        <p className='text-sm font-medium text-foreground'>
          Per-agent analytics
        </p>
        <p className='mt-1 text-xs text-muted-foreground'>
          Track costs and usage across each product or service you run
        </p>
      </div>
    </div>
    <p className='text-xs text-muted-foreground'>
      Add a pricing plan and subscription to also see revenue and margin per
      customer.
    </p>
  </div>
)

// ============================================
// TAB CONTENT COMPONENTS
// ============================================

const McpTab = ({
  copiedId,
  onCopy,
}: {
  copiedId: string | null
  onCopy: (text: string, key: string) => void
}) => (
  <div className='space-y-6'>
    <Card className='overflow-hidden rounded-xl border border-border/60 shadow-sm'>
      <CardHeader className='border-b border-border/60 bg-gradient-to-r from-muted/50 via-muted/30 to-muted/50'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/20 bg-gradient-to-br from-violet-500/10 to-purple-500/5'>
              <Cpu className='h-5 w-5 text-violet-500' />
            </div>
            <div>
              <CardTitle>MCP Server</CardTitle>
              <CardDescription>
                Talk to MarginFront in plain English. Your AI assistant fires a
                test event, then writes the SDK or REST integration into your
                codebase.
              </CardDescription>
            </div>
          </div>
          <DocsButton href={DOCS.mcp}>Full MCP Documentation</DocsButton>
        </div>
      </CardHeader>
      <CardContent className='space-y-6 pt-6'>
        {/* The one-line what / who / outcome header */}
        <p className='text-sm font-medium text-foreground'>
          Paste one config block and your AI tool (Claude Desktop, Claude Code,
          Cursor, or VS Code) does the rest. For anyone who already works inside
          an AI tool; you&apos;ll finish with your assistant recording billable
          events on command.
        </p>
        <p className='text-sm text-muted-foreground'>
          MCP (Model Context Protocol) connects AI tools like Claude Desktop,
          Claude Code, Cursor, or VS Code directly to MarginFront. Once set up,
          your AI assistant can track events, query costs, and manage customers
          on your behalf.
        </p>

        <DualAudiencePrompt
          aiPrompt={MCP_AI_PROMPT}
          devBrief={MCP_DEV_BRIEF}
          copyIdBase='mcp-prompt'
          copiedId={copiedId}
          onCopy={onCopy}
          minutes='~5 min'
        />

        <StepRow
          step={1}
          title='Get your API key'
          minutes='~1.5 min'
          defaultOpen
        >
          <p className='mb-3 text-sm text-muted-foreground'>
            You need a secret key (starts with{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              mf_sk_
            </code>
            ) so the MCP server can authenticate with MarginFront. If you
            already have one, skip to Step 2.
          </p>
          <Button
            onClick={() => (window.location.href = '/build?tab=keys')}
            className='bg-primary shadow-lg shadow-primary/20 hover:bg-primary/90'
          >
            <Zap className='mr-2 h-4 w-4' />
            Generate API Key
          </Button>
        </StepRow>

        <StepRow
          step={2}
          title='Add the MCP config to your AI tool'
          minutes='~1 min'
        >
          <p className='mb-3 text-sm text-muted-foreground'>
            First build the MCP server from the MarginFront source (needs git
            and Node.js 20 or newer):
          </p>
          <CodeBlock
            label='terminal'
            code={cloneAndBuildCommand(MCP_WORKSPACE)}
            copyId='mcp-build'
            copiedId={copiedId}
            onCopy={onCopy}
          />
          <p className='mb-3 mt-4 text-sm text-muted-foreground'>
            Then point your AI tool at the built file. Replace the path below
            with the real absolute path to it. Each tool has a slightly
            different config file. Pick whichever tool you use.
          </p>

          {/* Claude Code */}
          <p className='mb-2 text-sm font-medium text-foreground'>
            Claude Code
          </p>
          <p className='mb-3 text-sm text-muted-foreground'>
            Add this to{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              .mcp.json
            </code>{' '}
            in your project root:
          </p>
          <CodeBlock
            label='.mcp.json'
            code={MCP_CONFIG_EXAMPLE}
            copyId='mcp-claude-code'
            copiedId={copiedId}
            onCopy={onCopy}
          />

          <p className='mt-4 text-sm text-muted-foreground'>
            Using Claude Desktop, Cursor, or VS Code? The config is almost
            identical.{' '}
            {DOCS.mcp ? (
              <>
                <a
                  href={DOCS.mcp}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='font-medium text-primary underline underline-offset-2 hover:text-primary/80'
                >
                  see setup for all clients
                </a>
                .
              </>
            ) : (
              <>
                <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                  {MCP_README_PATH}
                </code>{' '}
                in the MarginFront source covers every client.
              </>
            )}
          </p>
        </StepRow>

        <StepRow step={3} title='Fire a test event' minutes='~2 min'>
          <div className='space-y-3'>
            <p className='text-sm text-muted-foreground'>
              Restart your AI tool so it picks up the new server, then type:{' '}
              <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                &quot;Verify my MarginFront connection&quot;
              </code>
              . It should respond with your organization name and confirm the
              API key is valid. Then fire your first event:
            </p>
            <div className='rounded-lg border border-border/60 bg-muted/30 px-4 py-3'>
              <code className='font-mono text-sm text-foreground'>
                Record a usage event for customer acme-001 on the cs-bot agent
              </code>
            </div>
            <p className='text-xs text-muted-foreground'>
              That customer and agent don&apos;t need to exist yet. MarginFront
              creates them automatically on the first event.
            </p>

            {/* More example prompts */}
            <div className='space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4'>
              <p className='text-sm font-medium text-emerald-700 dark:text-emerald-400'>
                More prompts to try once connected
              </p>
              <ul className='space-y-1 text-sm text-muted-foreground'>
                <li>
                  &bull;{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    Show me my MarginFront customers
                  </code>
                </li>
                <li>
                  &bull;{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    What events were logged today?
                  </code>
                </li>
                <li>
                  &bull;{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    How much did customer acme-001 cost this month?
                  </code>
                </li>
              </ul>
            </div>
          </div>
        </StepRow>

        <StepRow step={4} title='See it land' minutes='~30 sec'>
          <p className='mb-3 text-sm text-muted-foreground'>
            Your event shows in the Raw Events view the moment it lands, even
            while cost enrichment is still running. That row is your proof the
            pipe works end to end.
          </p>
          <Button
            variant='outline'
            size='sm'
            onClick={() =>
              (window.location.href = '/metrics-events/raw-events')
            }
          >
            Open Raw Events
          </Button>
        </StepRow>

        <p className='text-sm text-muted-foreground'>
          Make it permanent: phase 2 of the prompt above wires usage tracking
          into your codebase.
        </p>

        <WhatYouGet />
      </CardContent>
    </Card>
  </div>
)

const SdkTab = ({
  copiedId,
  onCopy,
}: {
  copiedId: string | null
  onCopy: (text: string, key: string) => void
}) => (
  <div className='space-y-6'>
    {/* Installation & Usage */}
    <Card className='overflow-hidden rounded-xl border border-border/60 shadow-sm'>
      <CardHeader className='border-b border-border/60 bg-gradient-to-r from-muted/50 via-muted/30 to-muted/50'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex h-10 w-10 items-center justify-center rounded-xl border border-primary/10 bg-gradient-to-br from-primary/10 to-primary/5'>
              <Code2 className='h-5 w-5 text-primary' />
            </div>
            <div>
              <CardTitle>Installation &amp; Usage</CardTitle>
            </div>
          </div>
          <DocsButton href={DOCS.sdk}>Full SDK Documentation</DocsButton>
        </div>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        {/* The one-line what / who / outcome header */}
        <p className='text-sm font-medium text-foreground'>
          Build the SDK from source and call usage.record(). For adding billing
          inside an existing Node.js or TypeScript app; you&apos;ll finish with
          your app reporting usage automatically.
        </p>

        {/* The naming rule, surfaced before any code gets written. The full
            explainer lives on the Pricing examples tab. */}
        <div className='rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5'>
          <p className='text-xs text-muted-foreground'>
            The{' '}
            <code className='rounded bg-muted px-1 font-mono text-[11px]'>
              signalName
            </code>{' '}
            you choose is what your customer sees on their invoice, so pick it
            deliberately.
          </p>
        </div>

        <DualAudiencePrompt
          aiPrompt={SDK_AI_PROMPT}
          devBrief={SDK_DEV_BRIEF}
          copyIdBase='sdk-prompt'
          copiedId={copiedId}
          onCopy={onCopy}
          minutes='~3 min'
        />

        <StepRow
          step={1}
          title='Get your API key'
          minutes='~1.5 min'
          defaultOpen
        >
          <p className='mb-4 text-sm text-muted-foreground'>
            Generate a secret key from your dashboard. It starts with{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              mf_sk_
            </code>
            . Keep it server-side only.
          </p>
          <Button
            onClick={() => (window.location.href = '/build?tab=keys')}
            className='bg-primary shadow-lg shadow-primary/20 hover:bg-primary/90'
          >
            <Zap className='mr-2 h-4 w-4' />
            Generate API Key
          </Button>
        </StepRow>

        <StepRow step={2} title='Install the SDK' minutes='~3 min'>
          <p className='mb-3 text-sm text-muted-foreground'>
            Build the SDK from the MarginFront source, in the folder that holds
            your app&apos;s folder (needs git and Node.js 20 or newer):
          </p>
          <CodeBlock
            label='terminal'
            code={cloneAndBuildCommand(SDK_WORKSPACE)}
            copyId='sdk-build'
            copiedId={copiedId}
            onCopy={onCopy}
          />
          <p className='my-3 text-sm text-muted-foreground'>
            Then, from your app&apos;s folder, install the copy you just built:
          </p>
          <CodeBlock
            label='terminal'
            code={SDK_LOCAL_INSTALL_COMMAND}
            displayCode={
              <>
                <span className='text-green-400'>$</span>{' '}
                {SDK_LOCAL_INSTALL_COMMAND}
              </>
            }
            copyId='sdk-install'
            copiedId={copiedId}
            onCopy={onCopy}
          />
          <p className='mt-3 text-sm text-muted-foreground'>
            No project to drop this into? Save the next step&apos;s snippet as{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              track.ts
            </code>{' '}
            and run it with{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              npx tsx track.ts
            </code>
            . No build config needed.
          </p>
        </StepRow>

        <StepRow step={3} title='Fire a test event' minutes='~2 min'>
          <div className='space-y-4'>
            <CodeBlock
              label='index.ts'
              code={`import { MarginFrontClient } from '@marginfront/sdk';

const mf = new MarginFrontClient({
  apiKey: process.env.MARGINFRONT_API_KEY,
  baseUrl: '${API_BASE}',
});

await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'cs-bot',
  signalName: 'messages',
  model: 'gpt-4o',
  modelProvider: 'openai',
  inputTokens: 523,
  outputTokens: 117,
});`}
              copyId='sdk-track'
              copiedId={copiedId}
              onCopy={onCopy}
            />
            <p className='text-sm text-muted-foreground'>
              For things that are not LLM calls (SMS, audio minutes, image
              renders), use{' '}
              <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                quantity
              </code>{' '}
              instead of tokens.
            </p>
            <CodeBlock
              label='index.ts'
              code={`await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'cs-bot',
  signalName: 'sms-sent',
  model: 'twilio-sms',
  modelProvider: 'twilio',
  quantity: 1,
});`}
              copyId='sdk-nonllm'
              copiedId={copiedId}
              onCopy={onCopy}
            />

            {/* Multi-service pointer. Send users to the Pricing examples tab
                when one outcome combines multiple services in a single event. */}
            <div className='rounded-xl border border-violet-500/20 bg-violet-500/5 p-4'>
              <p className='text-sm text-violet-700 dark:text-violet-400'>
                <span className='font-medium'>
                  Track multiple services in one event:
                </span>{' '}
                pass a{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  services
                </code>{' '}
                array to record the cost of every service that powered an
                outcome (search lookup, LLM call, email send, all on one
                report). See the{' '}
                <span className='font-medium'>Pricing examples</span> tab.
              </p>
            </div>
          </div>
        </StepRow>

        <StepRow step={4} title='See it land' minutes='~30 sec'>
          <div className='space-y-3'>
            <p className='text-sm text-muted-foreground'>
              Your event shows in the Raw Events view the moment it lands, even
              while cost enrichment is still running. That row is your proof the
              pipe works end to end.
            </p>
            <Button
              variant='outline'
              size='sm'
              onClick={() =>
                (window.location.href = '/metrics-events/raw-events')
              }
            >
              Open Raw Events
            </Button>

            {/* Fire-and-forget callout lives here because it answers "why
                didn't I see an error?" when an event doesn't land. */}
            <div className='rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4'>
              <p className='text-sm text-emerald-700 dark:text-emerald-400'>
                <span className='font-medium'>Fire-and-forget mode:</span> The
                SDK defaults to fire-and-forget. It sends the event in the
                background and does not block your code. If the request fails,
                it retries automatically. Your users never wait on MarginFront.
              </p>
            </div>
          </div>
        </StepRow>

        <p className='text-sm text-muted-foreground'>
          Make it permanent: phase 2 of the prompt above wires usage tracking
          into your codebase.
        </p>
      </CardContent>
    </Card>
  </div>
)

const ApiTab = ({
  copiedId,
  onCopy,
}: {
  copiedId: string | null
  onCopy: (text: string, key: string) => void
}) => (
  <div className='space-y-6'>
    <Card className='overflow-hidden rounded-xl border border-border/60 shadow-sm'>
      <CardHeader className='border-b border-border/60 bg-gradient-to-r from-muted/50 via-muted/30 to-muted/50'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-green-500/5'>
              <Globe className='h-5 w-5 text-emerald-500' />
            </div>
            <div>
              <CardTitle>REST API</CardTitle>
              <CardDescription>
                Use standard HTTP requests from any language
              </CardDescription>
            </div>
          </div>
          <DocsButton href={DOCS.api}>Full API Reference</DocsButton>
        </div>
      </CardHeader>
      <CardContent className='space-y-6 pt-6'>
        {/* The one-line what / who / outcome header */}
        <p className='text-sm font-medium text-foreground'>
          One HTTP POST, full control. For integrating from any language or
          stack without our SDK; you&apos;ll finish with a working request you
          own end to end.
        </p>

        {/* The naming rule, surfaced before any code gets written. The full
            explainer lives on the Pricing examples tab. */}
        <div className='rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5'>
          <p className='text-xs text-muted-foreground'>
            The{' '}
            <code className='rounded bg-muted px-1 font-mono text-[11px]'>
              signalName
            </code>{' '}
            you choose is what your customer sees on their invoice, so pick it
            deliberately.
          </p>
        </div>

        <DualAudiencePrompt
          aiPrompt={API_AI_PROMPT}
          devBrief={API_DEV_BRIEF}
          copyIdBase='api-prompt'
          copiedId={copiedId}
          onCopy={onCopy}
          minutes='~2 min'
        />

        <StepRow
          step={1}
          title='Get your API key'
          minutes='~1.5 min'
          defaultOpen
        >
          <p className='mb-4 text-sm text-muted-foreground'>
            Generate a secret key from your dashboard. It starts with{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              mf_sk_
            </code>
            . Pass it in the{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              x-api-key
            </code>{' '}
            header on every request.
          </p>
          <Button
            onClick={() => (window.location.href = '/build?tab=keys')}
            className='bg-primary shadow-lg shadow-primary/20 hover:bg-primary/90'
          >
            <Zap className='mr-2 h-4 w-4' />
            Generate API Key
          </Button>
        </StepRow>

        <StepRow step={2} title='Verify your key' minutes='~1 min'>
          <p className='mb-3 text-sm text-muted-foreground'>
            Make sure your key is valid before sending events.
          </p>
          <CodeBlock
            label='terminal'
            code={`curl -X GET ${API_BASE}/verify \\
  -H "x-api-key: mf_sk_your_key_here"`}
            displayCode={
              <>
                <span className='text-green-400'>$</span>
                {` curl -X GET ${API_BASE}/verify \\
  -H "x-api-key: mf_sk_your_key_here"`}
              </>
            }
            copyId='api-verify'
            copiedId={copiedId}
            onCopy={onCopy}
          />
          <p className='mt-3 text-xs text-muted-foreground'>
            On Windows PowerShell, type{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              curl.exe
            </code>{' '}
            instead of{' '}
            <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
              curl
            </code>
            , and end each continued line with a backtick instead of a
            backslash. Step 3 has the rest of the Windows notes.
          </p>
        </StepRow>

        <StepRow step={3} title='Fire a test event' minutes='~1 min'>
          <div className='space-y-4'>
            <p className='text-sm text-muted-foreground'>
              Send a POST with the event payload. All five required fields must
              be present.
            </p>
            <CodeBlock
              label='terminal'
              code={`curl -X POST ${API_BASE}/usage/record \\
  -H "x-api-key: mf_sk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "records": [
      {
        "customerExternalId": "acme-001",
        "agentCode": "cs-bot",
        "signalName": "messages",
        "model": "gpt-4o",
        "modelProvider": "openai",
        "inputTokens": 523,
        "outputTokens": 117
      }
    ]
  }'`}
              copyId='api-track'
              copiedId={copiedId}
              onCopy={onCopy}
            />

            {/* The traps below turn a valid key into a 401, so they belong
                next to the first POST rather than only in the docs. */}
            <div className='space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4'>
              <p className='text-sm font-medium text-amber-700 dark:text-amber-400'>
                Windows PowerShell
              </p>
              <p className='text-sm text-muted-foreground'>
                The command above is written for Bash. Copy it into PowerShell
                as-is and it fails. Three things change:
              </p>
              <ul className='ml-4 list-disc space-y-1.5 text-sm text-muted-foreground'>
                <li>
                  Run{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    curl.exe
                  </code>
                  . In Windows PowerShell,{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    curl
                  </code>{' '}
                  is an alias for a different command and fails with a parameter
                  error. End each continued line with a backtick, not a
                  backslash.
                </li>
                <li>
                  Reading the key from an environment variable? Write{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    $env:MF_API_SECRET_KEY
                  </code>
                  . Plain{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    $MF_API_SECRET_KEY
                  </code>{' '}
                  expands to an empty string, so the request goes out with no
                  key and the API answers 401. That reads like a bad key when
                  the key is fine.
                </li>
                <li>
                  Send the JSON body on standard input. Put the payload in a
                  here-string and pipe it:{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    {"$body | curl.exe -X POST <url> ... -d '@-'"}
                  </code>
                  . Passing{' '}
                  <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                    -d $body
                  </code>{' '}
                  strips the quotes out of your JSON on Windows PowerShell 5.1
                  and on PowerShell 7.0 through 7.2, and the API rejects it.
                </li>
              </ul>
              {DOCS.quickstart ? (
                <p className='flex items-center gap-2 text-sm text-muted-foreground'>
                  <ExternalLink className='h-4 w-4 shrink-0' />
                  <span>
                    Full Bash and PowerShell pairs for every call:{' '}
                    <a
                      href={DOCS.quickstart}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='font-medium text-primary hover:underline'
                    >
                      Quickstart
                    </a>
                  </span>
                </p>
              ) : null}
            </div>

            <p className='text-sm text-muted-foreground'>
              Same request using Python&apos;s{' '}
              <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                requests
              </code>{' '}
              library:
            </p>
            <CodeBlock
              label='track_event.py'
              code={`import requests

api_key = "mf_sk_your_key_here"
url = "${API_BASE}/usage/record"

response = requests.post(url, json={
    "records": [
        {
            "customerExternalId": "acme-001",
            "agentCode": "cs-bot",
            "signalName": "messages",
            "model": "gpt-4o",
            "modelProvider": "openai",
            "inputTokens": 523,
            "outputTokens": 117,
        }
    ]
}, headers={
    "x-api-key": api_key,
    "Content-Type": "application/json",
})

print(response.json())`}
              copyId='api-python'
              copiedId={copiedId}
              onCopy={onCopy}
            />

            {/* Multi-service pointer. Send users to the Pricing examples tab
                when one outcome combines multiple services in a single event. */}
            <div className='rounded-xl border border-violet-500/20 bg-violet-500/5 p-4'>
              <p className='text-sm text-violet-700 dark:text-violet-400'>
                <span className='font-medium'>
                  Track multiple services in one event:
                </span>{' '}
                pass a{' '}
                <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                  services
                </code>{' '}
                array on the request body to record per-service cost lines under
                one parent event. See the{' '}
                <span className='font-medium'>Pricing examples</span> tab for
                the JSON shape.
              </p>
            </div>
          </div>
        </StepRow>

        <StepRow step={4} title='See it land' minutes='~30 sec'>
          <div className='space-y-3'>
            <p className='text-sm text-muted-foreground'>
              Your event shows in the Raw Events view the moment it lands, even
              while cost enrichment is still running. That row is your proof the
              pipe works end to end.
            </p>
            <Button
              variant='outline'
              size='sm'
              onClick={() =>
                (window.location.href = '/metrics-events/raw-events')
              }
            >
              Open Raw Events
            </Button>

            {/* Response callout lives here because it describes what a
                landed event looks like, including the "Needs attention" case. */}
            <div className='space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4'>
              <p className='text-sm font-medium text-emerald-700 dark:text-emerald-400'>
                Response format
              </p>
              <p className='text-sm text-muted-foreground'>
                A successful response returns{' '}
                <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
                  200 OK
                </code>{' '}
                with a summary of accepted and rejected records. If a record has
                a field MarginFront does not recognize (e.g. unknown model), it
                still accepts the event but flags it as{' '}
                <span className='font-medium text-foreground'>
                  &quot;Needs attention&quot;
                </span>{' '}
                in your dashboard so you can fix the mapping later.
              </p>
            </div>
          </div>
        </StepRow>

        <p className='text-sm text-muted-foreground'>
          Make it permanent: phase 2 of the prompt above wires usage tracking
          into your codebase.
        </p>
      </CardContent>
    </Card>
  </div>
)

const CccTab = ({
  copiedId,
  onCopy,
}: {
  copiedId: string | null
  onCopy: (text: string, key: string) => void
}) => (
  <div className='space-y-6'>
    <Card className='overflow-hidden rounded-xl border border-border/60 shadow-sm'>
      <CardHeader className='border-b border-border/60 bg-gradient-to-r from-muted/50 via-muted/30 to-muted/50'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-orange-500/5'>
              <Terminal className='h-5 w-5 text-amber-500' />
            </div>
            <div>
              <CardTitle>AI spend (Code Cost Clarity)</CardTitle>
            </div>
          </div>
          <DocsButton href={DOCS.ccc}>Full documentation</DocsButton>
        </div>
      </CardHeader>
      <CardContent className='space-y-4 pt-6'>
        {/* The "this is not billing" guardrail. code-cost-clarity is internal
            cost tracking, so it is kept visually and verbally separate from the
            customer-billing paths and nobody wires it into an invoice flow by
            mistake. */}
        <div className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4'>
          <p className='text-sm text-amber-700 dark:text-amber-400'>
            This is internal cost tracking, not billing. Code Cost Clarity shows
            what your own AI coding agents (Claude Code, Codex) cost your team.
            It does not touch customer invoices or revenue. To bill your
            customers for usage, use the SDK or REST tab instead.
          </p>
        </div>

        {/* The one-line what / who / outcome header (matches the other tabs) */}
        <p className='text-sm font-medium text-foreground'>
          See what your team&apos;s Claude Code and Codex usage costs, broken
          down by developer and model. Run one command on each machine and your
          spend shows up in the dashboard.
        </p>

        <DualAudiencePrompt
          aiPrompt={CCC_AI_PROMPT}
          devBrief={CCC_DEV_BRIEF}
          copyIdBase='ccc-prompt'
          copiedId={copiedId}
          onCopy={onCopy}
        />

        <StepRow step={1} title='Run the installer' defaultOpen>
          <CodeBlock
            label='terminal'
            code={CCC_INIT_COMMAND}
            displayCode={
              <>
                <span className='text-green-400'>$</span> {CCC_INIT_COMMAND}
              </>
            }
            copyId='ccc-init'
            copiedId={copiedId}
            onCopy={onCopy}
          />
          <p className='mt-3 text-sm text-muted-foreground'>
            It downloads the MarginFront source and builds the meter on this
            computer, so it needs git and Node.js 20 or newer. Then follow the
            prompts. {cccServerAddressLine()}. It sets up a local collector that
            reports your coding-agent spend to MarginFront. No changes to your
            product code.
          </p>
        </StepRow>

        <StepRow step={2} title='See your spend'>
          <p className='mb-3 text-sm text-muted-foreground'>
            Your coding-agent spend shows up in the dashboard, split by
            developer and model.
          </p>
          <Button
            variant='outline'
            size='sm'
            onClick={() => (window.location.href = '/')}
          >
            Open dashboard
          </Button>
        </StepRow>
      </CardContent>
    </Card>
  </div>
)

// The backend auto-creates customer/agent/signal on the first event, so the
// required path is key → simulator → see it land. The entity-creation
// steps stay reachable inside the two optional rows below.
const ManualTab = () => (
  <div className='space-y-6'>
    <Card className='overflow-hidden rounded-xl border border-border/60 shadow-sm'>
      <CardHeader className='border-b border-border/60 bg-gradient-to-r from-muted/50 via-muted/30 to-muted/50'>
        <div className='flex items-center gap-3'>
          <div className='flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-yellow-500/5'>
            <ClipboardEdit className='h-5 w-5 text-amber-500' />
          </div>
          <div>
            <CardTitle>Guided Walkthrough</CardTitle>
            <CardDescription>
              Record your first usage event from the dashboard, no code needed
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-6 pt-6'>
        <p className='text-sm text-muted-foreground'>
          Three steps in the dashboard and your first usage event shows up in
          Raw Events. MarginFront creates the customer, agent, and signal for
          you from that first event, so you can skip straight to firing one.
        </p>

        <StepRow
          step={1}
          title='Get your API key'
          minutes='~1.5 min'
          defaultOpen
        >
          <p className='mb-3 text-sm text-muted-foreground'>
            You need an API key to send events, whether from code, the CLI, or
            the SDK Simulator.
          </p>
          <Button
            variant='outline'
            size='sm'
            onClick={() => (window.location.href = '/build?tab=keys')}
          >
            Go to API Keys
          </Button>
        </StepRow>

        <StepRow
          step={2}
          title='Fire a test event in the SDK Simulator'
          minutes='~2 min'
        >
          <p className='mb-3 text-sm text-muted-foreground'>
            The SDK Simulator fires a real test event from the dashboard without
            writing code. Type any customer, agent, and signal names you like
            (acme-001, cs-bot, messages work fine) and hit send. MarginFront
            creates them automatically on the first event, so there&apos;s
            nothing to set up beforehand.
          </p>
          <Button
            variant='outline'
            size='sm'
            onClick={() =>
              (window.location.href = '/developer-zone/sdk-simulator')
            }
          >
            Go to SDK Simulator
          </Button>
        </StepRow>

        <StepRow step={3} title='See it land' minutes='~30 sec'>
          <p className='mb-3 text-sm text-muted-foreground'>
            Your event shows in the Raw Events view the moment it lands, even
            while cost enrichment is still running. That row is your proof the
            pipe works end to end.
          </p>
          <Button
            variant='outline'
            size='sm'
            onClick={() =>
              (window.location.href = '/metrics-events/raw-events')
            }
          >
            Open Raw Events
          </Button>
        </StepRow>

        <StepRow step={4} title='Send it from your own app'>
          <p className='text-sm text-muted-foreground'>
            Ready to put this in your product? Switch to the SDK, REST API, or
            AI Assistant path above to add tracking to your codebase.
          </p>
        </StepRow>

        <StepRow title='Want to name things yourself first?' optional>
          <div className='space-y-5'>
            <p className='text-sm text-muted-foreground'>
              Auto-created records use exactly the names you type in the
              simulator. If you&apos;d rather set up your customers, agents, and
              signals by hand before firing anything, do it here.
            </p>

            <div className='space-y-2'>
              <p className='text-sm font-medium text-foreground'>
                Add a Customer
              </p>
              <p className='text-sm text-muted-foreground'>
                Customers are the people or companies using your AI product. Add
                at least one so you can attach usage events to them.
              </p>
              <Button
                variant='outline'
                size='sm'
                onClick={() => (window.location.href = '/customers')}
              >
                Go to Customers
              </Button>
            </div>

            <div className='space-y-2'>
              <p className='text-sm font-medium text-foreground'>
                Create an Agent
              </p>
              <p className='text-sm text-muted-foreground'>
                An Agent represents the AI product or service you want to track.
                Go to the Agents page and fill out the name, code, and
                description.
              </p>
              <Button
                variant='outline'
                size='sm'
                onClick={() => (window.location.href = '/build')}
              >
                Go to Agents
              </Button>
            </div>

            <div className='space-y-2'>
              <p className='text-sm font-medium text-foreground'>
                Define a Signal (Metric)
              </p>
              <p className='text-sm text-muted-foreground'>
                A Signal is the thing you are counting. For example: messages,
                API calls, minutes of audio processed. Go to Metrics and create
                one.
              </p>
              <Button
                variant='outline'
                size='sm'
                onClick={() => (window.location.href = '/metrics-events')}
              >
                Go to Metrics
              </Button>
            </div>
          </div>
        </StepRow>

        <StepRow title='Add revenue tracking' optional>
          <div className='space-y-5'>
            <p className='text-sm text-muted-foreground'>
              Cost tracking works from your first event. Add these two when you
              want MarginFront to also calculate what you charge.
            </p>

            <div className='space-y-2'>
              <p className='text-sm font-medium text-foreground'>
                Set up a Pricing Plan
              </p>
              <p className='text-sm text-muted-foreground'>
                Pricing plans are set on each agent. Open or create an agent,
                then add a plan on its Pricing Plans tab.
              </p>
              <Button
                variant='outline'
                size='sm'
                onClick={() => (window.location.href = '/build')}
              >
                Go to Agents
              </Button>
            </div>

            <div className='space-y-2'>
              <p className='text-sm font-medium text-foreground'>
                Create a Subscription
              </p>
              <p className='text-sm text-muted-foreground'>
                A subscription connects a customer to a pricing plan. Without
                one, MarginFront tracks costs but cannot calculate revenue.
              </p>
              <Button
                variant='outline'
                size='sm'
                onClick={() => (window.location.href = '/subscriptions')}
              >
                Go to Subscriptions
              </Button>
            </div>
          </div>
        </StepRow>

        {/* Done callout. The "what next" bridge lives in step 4 above, so
            this only confirms success; it does not repeat the next step. */}
        <div className='rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4'>
          <p className='text-sm font-medium text-emerald-700 dark:text-emerald-400'>
            Done. Once your test event shows in Raw Events, you have a working
            end-to-end setup.
          </p>
        </div>
      </CardContent>
    </Card>
  </div>
)

const ExamplesTab = ({
  copiedId,
  onCopy,
}: {
  copiedId: string | null
  onCopy: (text: string, key: string) => void
}) => {
  const sameCallReports = `// Same Claude call, billed as: 1 report
// The customer sees: "1 report x $50.00 = $50.00" on their invoice
await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'research-agent',
  signalName: 'reports_generated', // billing unit = reports
  model: 'claude-sonnet-4-20250514',
  modelProvider: 'anthropic',
  inputTokens: 8700,
  outputTokens: 15000,
  quantity: 1, // one report finished
})`

  const sameCallPages = `// Same Claude call, billed as: 50 pages
// The customer sees: "50 pages x $2.00 = $100.00" on their invoice
await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'research-agent',
  signalName: 'report_pages', // billing unit = pages
  model: 'claude-sonnet-4-20250514',
  modelProvider: 'anthropic',
  inputTokens: 8700,
  outputTokens: 15000,
  quantity: 50, // the report is 50 pages long
})`

  const sameCallTokens = `// Same Claude call, billed as: tokens used
// The customer sees: "23,700 tokens x $0.01/1K = $0.237" on their invoice
await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'research-agent',
  signalName: 'tokens_used', // billing unit = tokens
  model: 'claude-sonnet-4-20250514',
  modelProvider: 'anthropic',
  inputTokens: 8700,
  outputTokens: 15000,
  quantity: 23700, // total tokens used
})`

  // Non-LLM examples: no tokens, only the billable quantity. The signal
  // name IS the billing unit (minutes, calls, etc), so there's no
  // "pick your granularity" dance like the Claude examples above.
  const twilioVoiceCall = `// Twilio outbound voice call, 10 minutes long
// The customer sees: "10 min x $0.02 = $0.20" on their invoice
await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'support-agent',
  signalName: 'voice_minutes', // billing unit = minutes
  model: 'voice-outbound-us',
  modelProvider: 'twilio',
  quantity: 10, // minutes of call time
})`

  const mapsGeocodeCall = `// Google Maps geocoding, 150 addresses looked up
// The customer sees: "150 calls x $0.005 = $0.75" on their invoice
await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'routing-agent',
  signalName: 'geocode_calls', // billing unit = calls
  model: 'geocoding-api',
  modelProvider: 'google-maps',
  quantity: 150, // addresses looked up in this batch
})`

  // Multi-service example. One outcome (a prospect report) uses three
  // underlying services. Record as ONE event with a services[] array.
  // MarginFront stores per-service cost lines under the parent and bills
  // the customer per-signal.
  const multiServiceCall = `// Cold-outreach prospect report, ONE event, three services
// The customer sees: "1 prospect_report x $5.00 = $5.00" on their invoice
// MarginFront tracks per-service cost under the hood for margin reporting
await mf.usage.record({
  customerExternalId: 'acme-001',
  agentCode: 'outreach-agent',
  signalName: 'prospect_reports', // billing unit = reports
  quantity: 1, // one report finished
  services: [
    {
      model: 'exa-search',
      modelProvider: 'exa',
      quantity: 12, // 12 web-search calls
    },
    {
      model: 'claude-opus-4-20250514',
      modelProvider: 'anthropic',
      inputTokens: 4200,
      outputTokens: 1800,
    },
    {
      model: 'sendgrid-email',
      modelProvider: 'sendgrid',
      quantity: 3, // 3 emails sent
    },
  ],
})`

  return (
    <div className='space-y-6'>
      <Card className='overflow-hidden rounded-xl border border-border/60 shadow-sm'>
        <CardHeader className='border-b border-border/60 bg-gradient-to-r from-muted/50 via-muted/30 to-muted/50'>
          <div className='flex items-center gap-3'>
            <div className='flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/20 bg-gradient-to-br from-violet-500/10 to-indigo-500/5'>
              <Lightbulb className='h-5 w-5 text-violet-500' />
            </div>
            <div>
              <CardTitle>
                The signal name you pick is what your customer sees on their
                invoice
              </CardTitle>
              <CardDescription>LLM and non-LLM examples.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className='space-y-6 pt-6'>
          <p className='text-sm text-muted-foreground'>
            Before you write integration code, you have one decision to make:{' '}
            <span className='font-medium text-foreground'>
              what unit do you want your customer to see on their invoice?
            </span>{' '}
            That answer becomes your signal name. Everything else falls out of
            it.
          </p>

          {/* The four rules */}
          <div className='space-y-3 rounded-xl border border-border/60 bg-muted/30 p-5'>
            <p className='text-sm font-medium text-foreground'>
              The four rules
            </p>
            <ol className='space-y-2 text-sm text-muted-foreground'>
              <li>
                <span className='font-medium text-foreground'>
                  1. Fire one event per business outcome.
                </span>{' '}
                A finished report is one event. A completed call is one event.
                Never loop one event per page, per minute, or per token.
                That&apos;s what{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  quantity
                </code>{' '}
                is for.
              </li>
              <li>
                <span className='font-medium text-foreground'>
                  2. The signal name IS the billing unit.
                </span>{' '}
                Bill per page → name it{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  pages
                </code>
                . Bill per report → name it{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  reports
                </code>
                . Whatever word your customer reads on their invoice is what you
                type into{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  signalName
                </code>
                .
              </li>
              <li>
                <span className='font-medium text-foreground'>
                  3.{' '}
                  <code className='rounded bg-muted px-1 font-mono text-xs'>
                    quantity
                  </code>{' '}
                  counts that billing unit for this one event.
                </span>{' '}
                A 50-page report fired as{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  pages
                </code>{' '}
                has{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  quantity: 50
                </code>
                . The same report fired as{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  reports
                </code>{' '}
                has{' '}
                <code className='rounded bg-muted px-1 font-mono text-xs'>
                  quantity: 1
                </code>
                .
              </li>
              <li>
                <span className='font-medium text-foreground'>
                  4. Cost and revenue are decoupled.
                </span>{' '}
                MarginFront calculates cost automatically from model + provider
                + tokens. Revenue is quantity × your pricing-plan rate. The gap
                is your margin.
              </li>
            </ol>
          </div>

          {/* The 3-row comparison */}
          <div className='space-y-3'>
            <p className='text-sm font-medium text-foreground'>
              Same Claude call (a 50-page market research report), billed three
              different ways
            </p>
            <div className='overflow-hidden rounded-xl border border-border/60'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='border-b border-border/60 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground'>
                    <th className='px-4 py-2 text-left font-medium'>
                      signalName
                    </th>
                    <th className='px-4 py-2 text-left font-medium'>
                      quantity
                    </th>
                    <th className='px-4 py-2 text-left font-medium'>Rate</th>
                    <th className='px-4 py-2 text-left font-medium'>
                      Invoice line
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className='border-b border-border/60'>
                    <td className='px-4 py-3 font-mono text-xs'>
                      reports_generated
                    </td>
                    <td className='px-4 py-3 font-mono text-xs'>1</td>
                    <td className='px-4 py-3 text-muted-foreground'>
                      $50.00 / report
                    </td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      1 report × $50.00 = $50.00
                    </td>
                  </tr>
                  <tr className='border-b border-border/60'>
                    <td className='px-4 py-3 font-mono text-xs'>
                      report_pages
                    </td>
                    <td className='px-4 py-3 font-mono text-xs'>50</td>
                    <td className='px-4 py-3 text-muted-foreground'>
                      $2.00 / page
                    </td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      50 pages × $2.00 = $100.00
                    </td>
                  </tr>
                  <tr>
                    <td className='px-4 py-3 font-mono text-xs'>tokens_used</td>
                    <td className='px-4 py-3 font-mono text-xs'>23,700</td>
                    <td className='px-4 py-3 text-muted-foreground'>
                      $0.01 / 1K tokens
                    </td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      23,700 tokens × $0.01/1K = $0.237
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className='text-xs text-muted-foreground'>
              Same Claude call. Same underlying token cost. Three completely
              different invoices. The choice of signal name is the whole
              contract between &quot;the agent did work&quot; and &quot;the
              customer gets billed for it.&quot;
            </p>
          </div>

          {/* The three code blocks */}
          <div className='space-y-4'>
            <p className='text-sm font-medium text-foreground'>
              Here&apos;s that same call, written three ways in code
            </p>

            <CodeBlock
              label='Option 1: bill per report'
              code={sameCallReports}
              copyId='examples-reports'
              copiedId={copiedId}
              onCopy={onCopy}
            />

            <CodeBlock
              label='Option 2: bill per page'
              code={sameCallPages}
              copyId='examples-pages'
              copiedId={copiedId}
              onCopy={onCopy}
            />

            <CodeBlock
              label='Option 3: bill per token'
              code={sameCallTokens}
              copyId='examples-tokens'
              copiedId={copiedId}
              onCopy={onCopy}
            />
          </div>

          {/* Non-LLM examples: after the 3-way Claude comparison, show
              that non-LLM services skip the "pick your granularity"
              question entirely. The signal name IS the billing unit,
              full stop. Two concrete rows + two code blocks mirror the
              LLM section's shape so the visual rhythm stays consistent. */}
          <div className='space-y-3 pt-4'>
            <h3 className='text-lg font-semibold text-foreground'>
              For non-LLM services, the signal name <em>is</em> the billing unit
            </h3>
            <p className='text-sm text-muted-foreground'>
              <code className='rounded bg-muted px-1 font-mono text-[11px]'>
                quantity
              </code>{' '}
              is a required field here. Unlike LLM calls where input and output
              tokens drive the math, for non-LLM services{' '}
              <code className='rounded bg-muted px-1 font-mono text-[11px]'>
                quantity
              </code>{' '}
              is the billable count itself, so it has to be present on every
              event.
            </p>
            <div className='overflow-hidden rounded-xl border border-border/60'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='border-b border-border/60 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground'>
                    <th className='px-4 py-2 text-left font-medium'>
                      signalName
                    </th>
                    <th className='px-4 py-2 text-left font-medium'>
                      quantity
                    </th>
                    <th className='px-4 py-2 text-left font-medium'>Rate</th>
                    <th className='px-4 py-2 text-left font-medium'>
                      Invoice line
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className='border-b border-border/60'>
                    <td className='px-4 py-3 font-mono text-xs'>
                      voice_minutes
                    </td>
                    <td className='px-4 py-3 font-mono text-xs'>10</td>
                    <td className='px-4 py-3 text-muted-foreground'>
                      $0.02 / minute
                    </td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      10 min × $0.02 = $0.20
                    </td>
                  </tr>
                  <tr>
                    <td className='px-4 py-3 font-mono text-xs'>
                      geocode_calls
                    </td>
                    <td className='px-4 py-3 font-mono text-xs'>150</td>
                    <td className='px-4 py-3 text-muted-foreground'>
                      $0.005 / call
                    </td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      150 × $0.005 = $0.75
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className='text-xs text-muted-foreground'>
              No tokens. Just the quantity of the billable unit. Same{' '}
              <code className='rounded bg-muted px-1 font-mono text-[11px]'>
                mf.usage.record()
              </code>{' '}
              call, different shape.
            </p>
          </div>

          <div className='space-y-4'>
            <p className='text-sm font-medium text-foreground'>
              Here are the same two services, written in code
            </p>

            <CodeBlock
              label='Twilio Voice: bill per minute'
              code={twilioVoiceCall}
              copyId='examples-voice'
              copiedId={copiedId}
              onCopy={onCopy}
            />

            <CodeBlock
              label='Google Maps: bill per call'
              code={mapsGeocodeCall}
              copyId='examples-maps'
              copiedId={copiedId}
              onCopy={onCopy}
            />
          </div>

          {/* Multi-service section. Real agents often combine LLM and
              non-LLM services to produce one outcome. The services[]
              array lets you record per-service cost lines under one
              parent event, billed once. */}
          <div className='space-y-3 pt-4'>
            <h3 className='text-lg font-semibold text-foreground'>
              One outcome can carry multiple service costs
            </h3>
            <p className='text-sm text-muted-foreground'>
              A real agent often calls several services to produce one outcome.
              A cold-outreach report might use a search API, an LLM, and an
              email sender. All three contribute cost to the same business
              event. Pass a{' '}
              <code className='rounded bg-muted px-1 font-mono text-[11px]'>
                services
              </code>{' '}
              array to record them as ONE event, with per-service cost lines
              under the parent.
            </p>
            <div className='overflow-hidden rounded-xl border border-border/60'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='border-b border-border/60 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground'>
                    <th className='px-4 py-2 text-left font-medium'>
                      What it does
                    </th>
                    <th className='px-4 py-2 text-left font-medium'>Service</th>
                    <th className='px-4 py-2 text-left font-medium'>
                      Cost contribution
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className='border-b border-border/60'>
                    <td className='px-4 py-3 text-muted-foreground'>
                      Search the web
                    </td>
                    <td className='px-4 py-3 font-mono text-xs'>exa-search</td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      per call
                    </td>
                  </tr>
                  <tr className='border-b border-border/60'>
                    <td className='px-4 py-3 text-muted-foreground'>
                      Generate the report
                    </td>
                    <td className='px-4 py-3 font-mono text-xs'>
                      claude-opus-4-20250514
                    </td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      per token
                    </td>
                  </tr>
                  <tr>
                    <td className='px-4 py-3 text-muted-foreground'>
                      Send the email
                    </td>
                    <td className='px-4 py-3 font-mono text-xs'>
                      sendgrid-email
                    </td>
                    <td className='px-4 py-3 font-medium text-foreground'>
                      per send
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <CodeBlock
              label='Outreach report: ONE event, three services'
              code={multiServiceCall}
              copyId='examples-multi-service'
              copiedId={copiedId}
              onCopy={onCopy}
            />
            <p className='text-xs text-muted-foreground'>
              The customer sees one line on their invoice (
              <code className='rounded bg-muted px-1 font-mono text-[11px]'>
                prospect_reports
              </code>
              ). MarginFront tracks per-service cost under the hood for accurate
              margin reporting. Cost rolls up to the parent event automatically.
            </p>
          </div>

          {/* The guardrail callout */}
          <div className='space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4'>
            <p className='text-sm font-medium text-amber-700 dark:text-amber-400'>
              One event per outcome. Not one per page, not one per minute.
            </p>
            <p className='text-sm text-muted-foreground'>
              This is the single easiest thing to get wrong. If your agent
              produces a 50-page report, fire ONE event with{' '}
              <code className='rounded bg-muted px-1 font-mono text-xs'>
                quantity: 50
              </code>
              , not 50 events with{' '}
              <code className='rounded bg-muted px-1 font-mono text-xs'>
                quantity: 1
              </code>
              . Looping would multiply the invoice, flood your analytics, and
              burn API calls for no reason. The{' '}
              <code className='rounded bg-muted px-1 font-mono text-xs'>
                quantity
              </code>{' '}
              field exists so you don&apos;t have to loop.
            </p>
          </div>

          {DOCS.signalNaming ? (
            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
              <ExternalLink className='h-4 w-4' />
              <span>
                Full walkthrough in the docs:{' '}
                <a
                  href={DOCS.signalNaming}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='font-medium text-primary hover:underline'
                >
                  Choosing your signal name and quantity
                </a>
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

// ============================================
// TAB CONFIG
// ============================================

// The four setup paths, organized by how you want to integrate. The ids are
// the ?method= deep-link contract with SetupMethodModal; never rename them.
// `code` renders as the second line inside each trigger; `banner` is the
// PathBanner sentence.
const TAB_CONFIG = [
  {
    id: 'manual',
    label: 'Guided walkthrough',
    icon: ClipboardEdit,
    code: 'Dashboard',
    banner:
      "You're set up to record your first event from the dashboard. No code required.",
  },
  {
    id: 'mcp',
    label: 'AI Assistant (MCP)',
    icon: Cpu,
    code: 'Claude, Cursor, VS Code',
    banner:
      "You're on the AI Assistant path. Your assistant fires a test event, then writes your integration.",
  },
  {
    id: 'sdk',
    label: 'SDK',
    icon: Code2,
    code: 'Node.js',
    banner:
      "You're on the Node SDK path. Install one package and call usage.record().",
  },
  {
    id: 'api',
    label: 'REST API',
    icon: Globe,
    code: 'Any language',
    banner: "You're on the REST API path. One POST records an event.",
  },
  {
    id: 'ccc',
    label: 'AI spend',
    icon: Terminal,
    code: 'Claude Code, Codex',
    banner:
      "You're on the internal cost-tracking path. This watches what your own coding agents cost you. It is not customer billing.",
  },
] as const

// Reference material, not a setup path. Rendered as a secondary button on
// the caption row (not a trigger on the path strip), but still a live tab
// value so ?method=examples deep links and the in-tab cross-pointers keep
// working. Selecting it never overwrites the saved path.
const EXAMPLES_TAB = {
  id: 'examples',
  label: 'Pricing examples',
  icon: Lightbulb,
} as const

// Only real paths persist (never 'examples'). Key is per-org so switching
// orgs in the same browser doesn't leak one org's pick into another.
const PATH_IDS: string[] = TAB_CONFIG.map((t) => t.id)
const GS_PATH_KEY_PREFIX = 'mf_gs_path_'

// ============================================
// MAIN PAGE
// ============================================

export default function GettingStartedPage() {
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const { getOrgId } = useAuth()
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const methodParam = searchParams.get('method')
  const validMethods: string[] = [...PATH_IDS, EXAMPLES_TAB.id]
  // No-signal default is 'manual': the zero-prerequisite path ("Try it first").
  // In practice most arrivals carry ?method= or a saved path.
  const initialTab =
    methodParam && validMethods.includes(methodParam) ? methodParam : 'manual'

  const [tabOverride, setTabOverride] = useState<string | null>(null)

  const activeTab = tabOverride ?? initialTab

  const orgId = getOrgId()

  // Restore the saved path once the session loads. Precedence: URL param →
  // saved path → 'manual'. The session hydrates async (orgId is null on first
  // render), so this keys on orgId instead of running once on mount; the
  // functional update makes sure we never clobber a tab the user already
  // clicked while the session was still loading.
  useEffect(() => {
    if (methodParam || !orgId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: synchronous localStorage read after orgId hydrates (same idiom as DashboardClientLayout's setup-modal cache); fires at most once per orgId change
    setTabOverride((current) => {
      if (current) return current
      const saved = storage.getItem(`${GS_PATH_KEY_PREFIX}${orgId}`)
      return saved && PATH_IDS.includes(saved) ? saved : current
    })
  }, [methodParam, orgId])

  const handleTabChange = (value: string) => {
    setTabOverride(value)
    if (PATH_IDS.includes(value)) {
      // Remember the chosen path for next visit (per browser, per org).
      // 'examples' is reference material and deliberately never saved.
      if (orgId) {
        storage.setItem(`${GS_PATH_KEY_PREFIX}${orgId}`, value)
      }
    }
  }

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    toast({
      title: 'Copied to clipboard',
      description: 'Ready to paste',
    })
    setCopiedId(key)
    setTimeout(() => setCopiedId(null), 2000)
  }

  return (
    <Page
      title='Getting Started'
      headerProps={{
        // Breadcrumb reads "Home > Getting Started". No "Developer Zone"
        // crumb: /developer-zone has no index page.
        breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Getting Started' }],
      }}
    >
      <div className='flex flex-col gap-6'>
        {/* Hero Header */}
        <div className='relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary to-primary/90 p-6 md:p-8'>
          <div className='absolute inset-0 overflow-hidden'>
            <div className='absolute -right-24 -top-24 h-96 w-96 rounded-full bg-secondary/20 blur-3xl' />
            <div className='absolute -bottom-32 -left-32 h-80 w-80 rounded-full bg-secondary/10 blur-3xl' />
            <div
              className='absolute inset-0 opacity-[0.03]'
              style={{
                backgroundImage:
                  'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
                backgroundSize: '32px 32px',
              }}
            />
          </div>

          <div className='relative z-10'>
            <div className='mb-4 flex items-center gap-4'>
              <div className='flex h-14 w-14 items-center justify-center rounded-2xl border border-white/20 bg-white/10 shadow-lg backdrop-blur-sm'>
                <Rocket className='h-7 w-7 text-white' />
              </div>
              <div>
                <h2 className='text-2xl font-bold text-white'>
                  Record your first usage event in under 5 minutes
                </h2>
              </div>
            </div>

            <p className='max-w-2xl text-white/80'>
              Connect your app and record your first usage event. Pick the path
              that fits how you build.
            </p>

            <div className='mt-6 flex flex-wrap gap-6'>
              <div className='flex items-center gap-2 text-white/70'>
                <Zap className='h-4 w-4 text-secondary' />
                <span className='text-sm'>First event in under 5 minutes</span>
              </div>
              <div className='flex items-center gap-2 text-white/70'>
                <BookOpen className='h-4 w-4 text-secondary' />
                <span className='text-sm'>
                  Customers, agents and signals auto-create on first event
                </span>
              </div>
              <div className='flex items-center gap-2 text-white/70'>
                <Sparkles className='h-4 w-4 text-secondary' />
                <span className='text-sm'>
                  Events appear the moment they land
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* One-time vocabulary primer: "signal" is used on every tab below,
            so define it once here where every reader passes through. */}
        <p className='text-sm text-muted-foreground'>
          New to MarginFront? A signal is the billable action your customer
          takes (an API call, a report generated). You record each one as an
          event.
        </p>

        {/* Tabbed Content */}
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          {/* Caption row: names the choice in words. */}
          <p className='mb-2 text-sm text-muted-foreground'>
            Pick how you want to integrate
          </p>
          {/* The path strip: each trigger is one way to integrate. The active
              trigger is the only green one (soft primary fill + ring); inactive
              triggers stay neutral grey (explicit zinc, because this theme's
              muted-foreground is teal-tinted and would read as "selected").
              Selection still reads as fill + banner text + ARIA, never color
              alone. justify-start + overflow-x-auto lets the strip scroll on
              phones instead of clipping the last tabs. The Pricing examples
              reference sits right after the strip behind a thin divider: it is
              a plain button (not a TabsTrigger) so the path row only holds
              real setup paths; it still drives the same controlled tab value,
              so the ?method=examples deep link and TabsContent keep
              working. */}
          <div className='flex items-center gap-2 overflow-x-auto'>
            <TabsList
              aria-label='Integration paths'
              className='h-auto max-w-full justify-start gap-1 overflow-x-auto bg-muted/50 p-1'
            >
              {TAB_CONFIG.map((tab) => {
                const Icon = tab.icon
                return (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className='flex shrink-0 flex-col items-center gap-0.5 px-4 py-2 text-sm text-zinc-500 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-primary/40 dark:text-zinc-400'
                  >
                    <span className='flex items-center gap-1.5'>
                      <Icon className='h-4 w-4' aria-hidden='true' />
                      {tab.label}
                      {tab.id === 'manual' && (
                        <span className='rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground'>
                          Try it first
                        </span>
                      )}
                    </span>
                    <span className='text-[11px] font-normal opacity-70'>
                      {tab.code}
                    </span>
                  </TabsTrigger>
                )
              })}
            </TabsList>
            <div aria-hidden='true' className='h-6 w-px shrink-0 bg-border' />
            <Button
              variant='ghost'
              size='sm'
              className='shrink-0 gap-1.5 text-muted-foreground'
              onClick={() => handleTabChange(EXAMPLES_TAB.id)}
            >
              <Lightbulb className='h-4 w-4' aria-hidden='true' />
              {EXAMPLES_TAB.label}
            </Button>
          </div>

          <PathBanner tab={activeTab} />

          <TabsContent value='mcp'>
            <McpTab copiedId={copiedId} onCopy={handleCopy} />
          </TabsContent>

          <TabsContent value='sdk'>
            <SdkTab copiedId={copiedId} onCopy={handleCopy} />
          </TabsContent>

          <TabsContent value='api'>
            <ApiTab copiedId={copiedId} onCopy={handleCopy} />
          </TabsContent>

          <TabsContent value='ccc'>
            <CccTab copiedId={copiedId} onCopy={handleCopy} />
          </TabsContent>

          <TabsContent value='manual'>
            <ManualTab />
          </TabsContent>

          <TabsContent value='examples'>
            <ExamplesTab copiedId={copiedId} onCopy={handleCopy} />
          </TabsContent>
        </Tabs>

        {/* Shared across every setup path, so it renders once below the tabs
            instead of inside each tab body. Hidden on the Pricing examples
            reference because it is not a setup path, and on the coding-agent
            spend tab because that path is internal cost tracking, not
            customer signals/revenue. */}
        {PATH_IDS.includes(activeTab) && activeTab !== 'ccc' && (
          <div className='mt-2 space-y-6'>
            <WhatYouNeed />
            {activeTab !== 'manual' && <RevenueSetup />}
          </div>
        )}
      </div>
    </Page>
  )
}
