/**
 * How the dashboard tells people to get the SDK, the MCP server and the Code
 * Cost Clarity meter: built from the MarginFront source, never installed from
 * a public package registry. Every snippet on the page reads from here so the
 * wording cannot drift between surfaces.
 */

import { publicApiBaseUrl } from './operator'

/**
 * Shown in place of the clone address when the operator has not set one. It is
 * deliberately not a URL: a made-up default would be an address someone else
 * could register, and these commands end by asking for a secret key.
 */
export const SOURCE_REPO_PLACEHOLDER = '<your MarginFront source URL>'

/** The folder the clone lands in. Every later command runs from inside it. */
export const SOURCE_FOLDER = 'marginfront'

/**
 * The environment variable the SDK command line, the MCP server and the meter
 * read for the API address. Keep in step with packages/sdk, packages/mcp and
 * packages/code-cost-clarity.
 */
export const API_URL_ENV_VAR = 'MARGINFRONT_API_URL'

export const SDK_WORKSPACE = '@marginfront/sdk'
export const MCP_WORKSPACE = '@marginfront/mcp'
export const CCC_WORKSPACE = '@marginfront/code-cost-clarity'

export const SDK_README_PATH = 'packages/sdk/README.md'
export const MCP_README_PATH = 'packages/mcp/README.md'
export const CCC_README_PATH = 'packages/code-cost-clarity/README.md'

/** Where the MarginFront source lives: NEXT_PUBLIC_SOURCE_REPO_URL, or null
 * when the operator has not set it. There is no built-in address. */
export function sourceRepoUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SOURCE_REPO_URL?.trim()
  return configured ? configured.replace(/\/+$/, '') : null
}

/** The source address for commands and prose: the configured one, or a
 * placeholder nobody can run by accident. */
export function sourceRepoLabel(): string {
  return sourceRepoUrl() ?? SOURCE_REPO_PLACEHOLDER
}

/** Clone the source and build one package (turbo builds what it depends on). */
export function cloneAndBuildCommand(workspace: string): string {
  return `git clone ${sourceRepoLabel()} ${SOURCE_FOLDER} && cd ${SOURCE_FOLDER} && npm ci && npx turbo run build --filter=${workspace}`
}

/** Update an existing clone in place and rebuild one package. */
export function pullAndBuildCommand(workspace: string): string {
  return `cd ${SOURCE_FOLDER} && git pull && npm ci && npx turbo run build --filter=${workspace}`
}

/** Installs the locally built SDK into an app that sits next to the clone. */
export const SDK_LOCAL_INSTALL_COMMAND = `npm install ../${SOURCE_FOLDER}/packages/sdk`

/** The built MCP server, run with node. Absolute path because MCP clients
 * start servers from their own working folder. */
export const MCP_SERVER_ENTRY = `/absolute/path/to/${SOURCE_FOLDER}/packages/mcp/dist/index.js`

/** Runs the freshly built meter from inside the clone. */
export const CCC_SOURCE_INIT_COMMAND =
  'node packages/code-cost-clarity/dist/cli.js init'

export const CCC_SOURCE_CONTROL_INIT_COMMAND = `${CCC_SOURCE_INIT_COMMAND} --control`

/** The sentence that tells someone which server address the meter needs. */
export function cccServerAddressLine(): string {
  return `When it asks for your MarginFront server address, enter ${publicApiBaseUrl()}`
}
