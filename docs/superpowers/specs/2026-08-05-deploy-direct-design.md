# deploy-direct — design

Status: approved (brainstorm), pending implementation plan.
Date: 2026-08-05.

## Problem

`bootstrap-deploy` deploys *code → GitLab CI → deploy server*. Some users have no
git pipeline: they hold SSH (and DB) details for a **live server** and want to
deploy straight onto it. They may also be missing packages on that server.

`deploy-direct` adds that second mode: **code (git or local) → straight onto a
live server over SSH, no GitLab, no CI** — running the app natively (no Docker)
under a process manager.

## Non-negotiable stance (why this is safe)

The MCP adds **zero new privileged surface**. Two rules make that true:

1. **The MCP never provisions.** It does not install packages, create databases,
   or configure nginx/firewall/SSL as root. When the server is missing something,
   it **checks (read-only), prints the exact commands to run, and STOPS**. The
   operator installs manually and says continue; the MCP re-checks and proceeds.
2. **The app runs as the domain user**, started through fixed-argv verbs — the
   app's own start command, like a container's CMD, never a root operation.

All existing invariants hold unchanged: no credential in a session handle or
argv; `domain_exec` runs only closed-allowlist verbs with validated params; every
privileged/exec call is audited; secrets never enter git.

## Phases (the command flow)

`/deploykit:deploy-direct`

```
Inputs: source=<github_url|local_path|.>  target_key=<sshcon or targets.json name>
        [server_key=<root, OPTIONAL — only for read-only checks that need it>]
        [proxy_port=<port>]  [branch=...]

0. Resolve target   sshcon_resolve OR target_resolve -> session handle (no creds in chat).
1. Analyze source   analyze_repo + detect_env against the real working dir (local) or a
                    temp clone (url). Determine stack + its `requires:` list.
2. PREFLIGHT gate   For each entry in the stack's profile `requires:` list, run a read-only
                    check on the server (bin.which / bin.version). Compare to min versions.
                    If anything is missing/too old: PRINT a table of what's missing + the
                    exact install commands, then STOP. The operator installs manually and
                    says continue; re-run the checks; proceed only when all pass.
3. STOP + ask       The env/DB questionnaire (same as bootstrap Phase 2). DB details the
                    operator provides are classified SECRET and destined for the server .env.
4. Local health     Prove the app runs locally first (invariant #1 — never deploy unproven
                    code). Unchanged from the existing local gate.
5. Deliver          rsync working tree -> appDir over SSH (exclude .git/.env/*-data). Write
                    the server .env from the answers (back up an existing one first).
6. Run              Start/restart the app AS THE DOMAIN USER via pm2 (fixed-argv verbs),
                    then health_check (2xx/3xx).
7. Return the URL   (http:// until TLS is provisioned — the §6 ssl caveat applies).
```

## New components

### 2.1 `requires:` block in profiles (data, not code)

Each `profiles/<stack>.yml` gains a `requires:` list declaring what the stack
needs to run natively. Example shape:

```yaml
requires:
  - bin: node        # binary to look for on PATH
    min: "18"        # optional minimum major version
    install: "your OS package for Node 18+ (nvm / nodesource)"   # human hint, printed on gap
  - bin: pm2
    install: "npm i -g pm2"
```

The preflight's source of truth is this list. Adding a stack's requirements =
editing a yml, never the engine. Binary names are trusted (from the profile) and
still charset-validated before they reach a verb.

### 2.2 Read-only preflight verbs (domain user, fixed argv)

- `bin.which`   -> `command -v {bin}`            ({bin} charset-validated)
- `bin.version` -> `{bin} --version`             ({bin} charset-validated)

These ride the existing `domain_exec` machinery. They are read-only; a missing
binary is a non-zero exit the engine interprets, not an error that halts the tool.
(Port-free and other environment checks reuse the existing diagnostic verbs.)

### 2.3 Native run verbs (domain user, fixed argv)

- `pm2.start`   -> prefers the repo's `ecosystem.config.*` (`pm2 start ecosystem.config.cjs`
                   with cwd=appDir); else a profile/asked start command (invariant #6).
- `pm2.restart` -> `pm2 restart {name}`
- `pm2.reload`  -> `pm2 reload {name}`   (zero-downtime where supported)
- `pm2.logs`    -> `pm2 logs {name} --lines {n} --nostream`   (read-only)
- `pm2.status`  -> `pm2 jlist`                                 (read-only)

`{name}` and `{n}` are regex-validated; the start command, when it must be
supplied, comes from the profile or an explicit ask, never invented by the agent.
Process manager is **pm2** for v1 (the org already uses it); `systemd --user` is a
future option (needs the linger/bus setup rootless Docker also needs).

## Reused unchanged

- SSH credentials: `sshcon_resolve` / `target_resolve` — no credential in the chat.
- DB details: provided by the operator, classified `SECRET` by `detect_env`,
  written to the **server `.env` only** (gitignored, never echoed).
- Local health gate; `health_check` (2xx/3xx); audit log; the whole no-secrets
  boundary; `.env` backup-before-overwrite; SSL/TLS interim-HTTP behavior.

## Explicitly NOT in scope

- Installing packages, creating databases, configuring nginx/firewall/SSL as root.
  These are reported as preflight gaps with commands; the operator does them.
- `systemd --user` process management (pm2 only for v1).
- Day-2 ops verbs beyond start/restart (redeploy/rollback/logs-tail as a native
  `redeploy` path is a follow-up, mirroring the Docker redeploy).

## Testing (all mocked, no real infra — extends scripts/smoke.mjs)

- preflight: with a mock ssh reporting a present binary -> passes; a missing/old
  one -> the engine surfaces the gap + install hint and does NOT proceed.
- `bin.which`/`bin.version` build the expected argv; reject a bad `{bin}`.
- `pm2.*` verbs build the expected argv; `pm2.logs`/`pm2.status` are read-only;
  reject bad `{name}`/`{n}`.
- profile `requires:` lists parse and every `bin` is charset-safe.
- no new secret path: a resolved target still yields a no-secret handle; audit
  lines for the new verbs carry no secret.
- invariants regression: tool/verb count updated; existing assertions stay green.

## Open follow-ups (noted, not v1)

- `systemd --user` as an alternative process manager.
- A native `redeploy`/`rollback` path (release dirs).
- Auto-generate a start command / Dockerfile when neither a profile nor an
  ecosystem file supplies one.
