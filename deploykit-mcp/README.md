# deploykit-mcp

> **Status: implemented, built, and smoke-tested.** Wired into `plugin.json` as
> the `deploykit` MCP server. Ships as a single bundled `dist/server.js` — no
> `npm install` or build step is needed to *use* it.

## What this is (the privileged boundary)

A stdio (later: Streamable HTTP) MCP server that owns every privileged and
non-deterministic primitive deploykit needs, exposed as **typed tools**. The
agent (Claude Code / Cursor / Copilot) can only call these tools — it never
holds credentials and never runs freeform SSH. The point is to make root a
single fixed, audited operation instead of an open shell.

## Tool surface (10 tools)

| Tool | Privilege | Purpose |
|---|---|---|
| `sshcon_resolve` | reads sshcon | Resolve a target; return a session handle + non-secret facts (never the password/key) |
| `target_resolve` | reads targets.json | Same, for hosts **not** in sshcon: resolve a NAMED target from `~/.deploykit/targets.json` |
| `grant_docker_access` | **ROOT (only)** | The one privileged op: install rootless Docker for a domain user (fixed, idempotent script) |
| `domain_exec` | domain user | Run an **allowlisted verb** (`docker.compose.up`, `rsync.push`, ...) — never a raw command string |
| `analyze_repo` | none (local RO) | Detect stack, Dockerfile/compose, candidate ports |
| `detect_env` | none (local RO) | Return classified env key list (never secret values) |
| `pipeline_run` / `pipeline_status` / `pipeline_trace` | glab | Wrap `glab ci ...` |
| `health_check` | none | Wrap curl against the deployed URL |

## File layout

```
deploykit-mcp/
  package.json
  tsconfig.json
  scripts/smoke.mjs       self-contained security + smoke assertions (mocked)
  src/
    config.ts             config load + the two allowlist gates
    sessions.ts           session store, TTL, no-secret handles
    audit.ts              append-only JSONL logger
    exec.ts               sshcon wrapper + verb->argv enforcer
    tools/privileged.ts   sshcon_resolve, grant_docker_access, domain_exec
    tools/analysis.ts     analyze_repo, detect_env
    tools/pipeline.ts     pipeline_*, health_check
    server.ts             MCP bootstrap + tool registration (stdio)
  dist/server.js          THE SHIPPED ARTIFACT — bundled, committed
```

## Design invariants (enforced in code, not just convention)

- `sshcon_resolve` returns a **handle, not credentials**. Secrets live in a
  private field of the session store; `SessionHandle` has no field that can
  carry credential material. Raw sshcon output is **redacted** before it is
  shown (passwords *and* key paths).
- `domain_exec` accepts only a **verb from a closed allowlist**, each mapped to
  a fixed argv template. Params are regex-validated against a tight charset and
  unknown params are rejected. No shell interpolation of agent input, ever.
- `grant_docker_access` requires a `kind === "root"` session and pipes a single
  hardcoded, idempotent rootless-Docker script to `bash -s`. It cannot run
  anything else as root, and never degrades to root-mode Docker on failure.
- Every privileged call appends one JSON line to `audit.jsonl`, including
  **rejections**. A key-name scrubber strips anything auth-shaped at any depth.
- All child processes go through `spawn(file, argv, { shell: false })`. No
  `exec`, no string commands. The single `bash -lc` is on the *remote* side
  only, required by SKILL.md §6 for rootless Docker's PATH, built from a fixed
  template with validated + shell-quoted elements.

## Operator config — `~/.deploykit/`

Two operator-owned files, deliberately **outside** the plugin so a
`plugin install` cannot wipe them. Neither is ever committed.

### `config.json` (optional)

```json
{ "sshconKeyAllowlist": ["web-host", "db-host"] }
```

`sshconKeyAllowlist` is **empty by default, meaning any sshcon key resolves**.
Pinning key names bought no real safety — the operator's machine already has
every key, and a handle only unlocks an allowlisted verb — so it is opt-in for
orgs that want targets restricted. A non-empty list is enforced.

### `targets.json` (only for hosts not in sshcon)

```json
{
  "learning": {
    "host": "10.0.0.5",
    "port": 22,
    "user": "learning",
    "password": "...",
    "appDir": "/var/www/clients/client1/web19/web"
  },
  "box6": { "host": "10.0.0.5", "user": "root", "keyPath": "~/.ssh/id_x", "kind": "root" }
}
```

```bash
chmod 600 ~/.deploykit/targets.json    # it holds credentials
```

The agent calls `target_resolve({ target: "learning" })` — **a name, never the
credentials**. That is the whole point: credentials passed as tool arguments
would land in the conversation and in the on-disk session transcript, which is
exactly what this server exists to prevent. Set `password` **or** `keyPath`,
never both.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `DEPLOYKIT_SSHCON_BIN` | `sshcon` | Path to sshcon. **Set an absolute path in tests** — see the warning below. |
| `DEPLOYKIT_CONFIG` | `~/.deploykit/config.json` | Operator config |
| `DEPLOYKIT_TARGETS` | `~/.deploykit/targets.json` | Named SSH targets |
| `DEPLOYKIT_SSHCON_KEYS` | *(unset = any key)* | Comma-separated **opt-in** pin of resolvable keys |
| `DEPLOYKIT_AUDIT_PATH` | `./audit.jsonl` | Append-only audit log |
| `DEPLOYKIT_SESSION_TTL_MS` | `900000` | Session lifetime; secrets are dropped on expiry |
| `DEPLOYKIT_EXEC_TIMEOUT_MS` | `600000` | Wall-clock cap per child process |

> **Warning — `sshcon` may be a shell function.** On at least one dev machine
> `sshcon` is a zsh function (an nvm shim) that *shadows `PATH`*. Prepending a
> mock directory to `PATH` therefore does NOT stop a shell from reaching the
> real sshcon and printing live credentials. Always inject a mock by **absolute
> path** via `DEPLOYKIT_SSHCON_BIN`. The server itself is immune (it uses
> `spawn`, which never resolves shell functions) — the hazard is interactive
> shells and test harnesses.

## Develop / build / test

```bash
npm install          # dev only
npm run typecheck    # tsc --noEmit, zero-error gate
npm run build        # typecheck + esbuild bundle -> dist/server.js
npm run smoke        # 51 mocked security + smoke assertions; touches no real infra
```

`dist/server.js` is **committed on purpose**: `plugin.json` points at
`${CLAUDE_PLUGIN_ROOT}/deploykit-mcp/dist/server.js`, and a plugin install is a
git clone with no `npm install`. **Rebuild and commit it whenever `src/`
changes**, or installs will ship stale code.

## SDK version note

Built and verified against `@modelcontextprotocol/sdk` **v1.29.0**
(`McpServer` from `server/mcp.js` + `StdioServerTransport` from
`server/stdio.js`), zod 3.25.76, Node 22. SDK v2 (split
`@modelcontextprotocol/server` / `-client` packages) is in beta for the
2026-07-28 spec; migrate later via `npx @modelcontextprotocol/codemod v1-to-v2`.
