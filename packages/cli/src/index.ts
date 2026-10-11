/**
 * tealbrick CLI.
 * - owner mode: person sign-in (device flow), builds drafts; applying needs browser confirmation.
 * - agent mode: agent card sign-in with a one-time pairing code.
 * - bridge: runs the bridge core in relay mode (stdio MCP to the deployed bridge).
 * - connect: prints connection instructions for Claude Desktop, Claude Code and Codex.
 * Owner and agent credentials are separate and never interchangeable.
 */
export const role = 'tealbrick-cli';
