#!/usr/bin/env node
/**
 * deploykit-mcp — the privileged boundary, over stdio.
 *
 * stdout belongs to the MCP transport. Every diagnostic goes to stderr, or it
 * would corrupt the protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SessionStore } from "./sessions.js";
import { AuditLog } from "./audit.js";
import { registerPrivilegedTools } from "./tools/privileged.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerPipelineTools } from "./tools/pipeline.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new SessionStore(cfg.sessionTtlMs);
  const audit = new AuditLog(cfg.auditPath);

  const server = new McpServer(
    { name: "deploykit-mcp", version: "1.2.0" },
    {
      instructions:
        "Privileged boundary for deploykit. Resolve targets with sshcon_resolve to get a session " +
        "handle, then act through domain_exec (allowlisted verbs only). grant_docker_access is the " +
        "single root operation. Credentials never leave this server.",
    },
  );

  registerPrivilegedTools(server, cfg, store, audit);
  registerAnalysisTools(server, audit);
  registerPipelineTools(server, cfg, audit);

  // Drop expired sessions (and their secrets) on a timer, not just on access.
  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[deploykit-mcp] ready — sshcon=${cfg.sshconBinary} audit=${cfg.auditPath} ` +
      `keys=${cfg.sshconKeyAllowlist.join(",")}\n`,
  );

  const shutdown = (): void => {
    clearInterval(sweeper);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`[deploykit-mcp] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
