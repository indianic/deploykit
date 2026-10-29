# deploykit — usage & reference

`deploykit` is a **Claude Code plugin** that deploys any project onto IndiaNIC's
self-hosted stack — **GitLab CI + ISPConfig + rootless Docker** — from one slash
command. It is stack-agnostic: one deploy engine plus declarative
`profiles/*.yml`. A privileged **MCP server** (`deploykit-mcp`) owns everything
that touches credentials or root, so the agent drives typed tools and never holds
a secret or a root shell.

- **Repo:** `git@github.com:indianic/deploykit.git`
- **Marketplace:** `indianic-deploy` (source: `indianic/deploykit`)
- **Plugin id:** `deploykit@indianic-deploy`

---

## 1. Install

Install once at **user scope** (available in every project):

```bash
claude plugin marketplace add indianic/deploykit
claude plugin install deploykit@indianic-deploy
```

Then start a **fresh session** — the MCP server loads at session start.
`/mcp` should list **deploykit** with 15 tools.

### Project scope

To scope it to one project, add to that project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "indianic-deploy": { "source": { "source": "github", "repo": "indianic/deploykit" } }
  },
  "enabledPlugins": { "deploykit@indianic-deploy": true }
}
```

### Updating to a new version (IMPORTANT)

`claude plugin marketplace update` alone can leave a **stale bundle**. To reliably
pick up changes, do the full cycle and then start a fresh session:

```bash
claude plugin uninstall deploykit@indianic-deploy
claude plugin marketplace remove indianic-deploy
claude plugin marketplace add indianic/deploykit
claude plugin install deploykit@indianic-deploy
```

---

## 2. Operator config — `~/.deploykit/`

Two optional, operator-owned files, kept **outside** the plugin so a reinstall
can't wipe them. Neither is ever committed.

### `config.json` — optional pin

```json
{ "sshconKeyAllowlist": ["db-host", "web-host", "my-app"] }
```

By default **any sshcon key resolves**. Set `sshconKeyAllowlist` only if your org
wants to restrict which targets can be named (a non-empty list is enforced).

### `targets.json` — hosts NOT in sshcon

```json
{
  "my-app": {
    "host": "10.0.0.5", "port": 22, "user": "web20",
    "password": "…",            // or  "keyPath": "~/.ssh/id_x"
    "appDir": "/var/www/clients/client1/web20/web"
  },
  "box3": { "host": "10.0.0.5", "user": "root", "keyPath": "~/.ssh/id_x", "kind": "root" }
}
```

```bash
chmod 600 ~/.deploykit/targets.json     # it holds credentials
```

The agent references a **name** (`target_resolve({target:"my-app"})`), never
the credentials — so they never enter the conversation or the session transcript.
Use `password` **or** `keyPath`, never both.

---

## 3. Commands

### `/deploykit:bootstrap-deploy` — first-time deploy (8 phases)

```
source=<github_url | local_path | .>   the app to deploy
gitlab=<gitlab_repo_url>               the deploy repo we push to
domain_key=<sshcon_domain>             the ISPConfig web user the app runs as
server_key=<sshcon_root>               the root box (used ONCE, for rootless Docker)
proxy_port=<port>                      host port Apache proxies to the container
[branch=indianic/main]                 deploy branch (default indianic/main)
```

It resolves server facts, detects the stack, loads the matching profile, **stops
to ask you** the env/integration questionnaire (Phase 2), proves the build with a
**local `docker compose up` health gate** (Phase 4b), wires the GitLab CI deploy,
and on success prints only the URL. `proxy_port` may be omitted if sshcon reports
an **Application Port** for the domain — Phase 0 will surface it.

### `/deploykit:redeploy` — fast rebuild/restart/rollback

```
[branch=indianic/main] [--no-build] [--restart-only] [--rollback] [--local]
```

Env-preserving. No upstream sync, no env prompts. `--local` runs only the local
health gate; `--rollback` redeploys the previous commit.

### `/deploykit:sync-upstream` — pull GitHub upstream into the deploy repo

```
[branch=indianic/main] [--dry-run] [--no-deploy]
```

Preserves our server `.env`, then pushes to trigger a redeploy.

### `/deploykit:deploy-direct` — no-git, direct-to-server native deploy

```
source=<github_url | local_path | .>   target_key=<sshcon_or_targets_name>
[proxy_port=<port>] [branch=indianic/main]
```

Delivers code over SSH and runs it natively under pm2 as the domain user — no
GitLab, no CI. A read-only preflight checks the server for required packages and,
if any are missing, prints exactly what to install and stops until you've done it.
The MCP never installs anything or runs as root.

### `/deploykit:retro` — capture what this session learned

```
[--since=<iso8601>] [--dry-run] [--no-propose]
```

Reads the session's audit trail + deploy diff + out-of-band steps, appends
anything the MCP didn't already know to `knowledge/learnings.yml`
(append-only, deduped), and prints a **review-only** patch proposal for deeper
fixes. Never auto-edits the skill or tools; never prints a secret.

---

## 4. Sample commands by scenario

```bash
# GitHub source -> GitLab deploy (the common case)
/deploykit:bootstrap-deploy source=https://github.com/acme/app \
  gitlab=git@gitlab.example.com:GROUP/app-example-com.git \
  domain_key=appuser server_key=web-host proxy_port=50040

# Deploy the CURRENT local folder (no upstream GitHub repo)
cd /path/to/project
/deploykit:bootstrap-deploy source=. \
  gitlab=git@gitlab.example.com:GROUP/app-example-com.git \
  domain_key=appuser server_key=web-host proxy_port=50041

# Operator has NO root — generate a runbook for the server team
#   run bootstrap-deploy WITHOUT server_key; at the root step it calls
#   emit_root_runbook, hands you a script for whoever holds root, and STOPS.
/deploykit:bootstrap-deploy source=https://github.com/acme/app \
  gitlab=git@gitlab.example.com:GROUP/app-example-com.git \
  domain_key=appuser proxy_port=50042

# Fast redeploy after a code change
/deploykit:redeploy

# Roll back to the previous deploy
/deploykit:redeploy --rollback

# Pull the latest upstream and redeploy
/deploykit:sync-upstream

# Capture lessons after a deploy
/deploykit:retro
```

**Stacks:** laravel and nextjs have dedicated profiles; python has a conservative
profile; everything else lands on `_fallback`, which **asks** you for the four
certainties (internal port, health path, build strategy, compose service) rather
than guessing. React / static HTML / PHP / Go / Rust all deploy through the same
command — the profile (or your answers) supplies the stack knowledge.

---

## 5. MCP tools (what the agent calls under the hood)

| Tool | Purpose |
|---|---|
| `sshcon_resolve` | Resolve an sshcon target → session handle + non-secret facts (key-first auth; `deploy_key_env` for key-only hosts) |
| `target_resolve` | Same, for hosts defined in `~/.deploykit/targets.json` (key + password fallback pair; `keyB64`/`keyEnv`) |
| `ssh_auth_preflight` | Report which SSH auth methods a host OFFERS (key-only / password / both), no credential used |
| `reload_config` | Re-read the sshcon key allowlist without a restart |
| `grant_docker_access` | The ONE root op: install rootless Docker (installs Docker CE if absent; handles ISPConfig quirks) |
| `emit_root_runbook` | Generate a root runbook for a server team (executes nothing) |
| `host_preflight` | Read-only capability report: CPU x86-64-v2, RAM/swap, disk quota, Docker |
| `domain_exec` | Run an allowlisted verb as the domain user (fixed argv, no shell) |
| `analyze_repo` | Detect stack (incl. lobehub), Dockerfile/compose (+ podman warning), candidate ports |
| `detect_env` | Deep-scan + classify env keys (never values); flags non-env config models |
| `lint_yaml` | Catch the plain-scalar `": "` colon-trap (and tabs) in generated YAML |
| `pipeline_run` / `pipeline_status` / `pipeline_trace` | Wrap `glab ci …` (`repo` ref for self-hosted) |
| `health_check` | Thin curl wrapper; 2xx **and** 3xx count as healthy |

### Safety invariants (enforced in code)

1. Session handles never carry credentials; secrets reach child procs via
   `SSHPASS` env or `-i` keyfile, never argv.
2. `domain_exec` runs only closed-allowlist verbs with fixed argv and validated
   params — no shell string, ever.
3. `grant_docker_access` is the only root operation: one fixed idempotent script
   via `bash -s`, and it never falls back to root Docker.
4. Secrets never enter git (`.env` is server-side, gitignored, rsync-excluded).
5. Every privileged call is audited to `~/.deploykit/audit.jsonl` (no secrets).

---

## 6. Current features

- One-command bootstrap deploy (GitHub URL **or** local path) with an 8-phase,
  ask-before-writing flow.
- Stack-agnostic engine + profiles (laravel, nextjs, python, `_fallback`).
- Privileged MCP boundary: no-credential session handles, closed verb allowlist,
  a single audited root operation, append-only audit log.
- **Root-optional**: `emit_root_runbook` + read-only preflight verbs for boxes
  where the operator has no root.
- Real sshcon parsing (ANSI column layout, section-scoped credentials).
- Named targets for non-sshcon hosts.
- Local `docker compose` health gate before any deploy; 2xx/3xx health.
- Env classification that recognises **non-env** (settings-JSON) apps.
- Compose-file precedence + podman-only detection.
- ISPConfig hardening: immutable-home, uid→two-usernames, missing session bus.
- GitLab CI: reuse existing variable names, declare the environment scope,
  shallow-push guard, SSL/TLS preflight, `.env` preservation.
- **Memory**: `knowledge/learnings.yml` loaded at every deploy; `/deploykit:retro`
  grows it after each session.

---

## 7. Roadmap — toward a fully autonomous deploy MCP

The goal is an MCP that handles **every** situation end to end. Planned:

- **Server configuration** — verify/repair the ISPConfig vhost, PHP/Node runtime,
  cron/queue workers, firewall and port map as typed, audited operations (today
  these are guided prose, not tools).
- **Git configuration** — dual-remote wiring, deploy-key provisioning, and
  `known_hosts` seeding as first-class verbs (today partly manual).
- **CI/CD file authoring & repair** — generate and *fix* `.gitlab-ci.yml` from the
  detected stack, reconcile it with existing variables/scopes, and self-heal the
  common failures in the §6 fix-map without a human round-trip.
- **Live pipeline monitoring** — a watch loop over `pipeline_status`/`trace` that
  applies the failure→fix map (max N cycles) and reports, instead of one-shot
  calls.
- **Deploy from GitHub code** *(have)* and **from direct/local source** *(have)* —
  extend to private repos, monorepos, and subdirectory apps.
- **"Hello world" bootstrap** — scaffold a minimal working app for an empty
  domain, to prove the pipeline before the real code lands.
- **Every tech stack** — promote recurring stacks (react, static, php, go, rust,
  django/fastapi) to dedicated profiles; auto-generate a Dockerfile when a repo
  ships none.
- **Rollback & migration safety** — track applied DB migrations and make rollback
  aware of data state.
- **Streamable-HTTP MCP** — run the boundary as a shared service, not only stdio,
  so a team shares one audited control plane.
- **Self-driving retro** — let `/deploykit:retro`'s proposals be applied through
  the same review-gated agent loop that produced this plugin.

---

## 8. Troubleshooting

- **`/mcp` doesn't show deploykit** — you're in a session that started before the
  install. Fully quit and start a fresh session. Verify with `claude mcp list`
  (look for `plugin:deploykit:deploykit … ✔ Connected`).
- **A fix isn't taking effect** — do the full reinstall cycle in §1, then a fresh
  session. `marketplace update` alone can leave a stale bundle.
- **`sshcon` prints a real password in your shell** — `sshcon` may be a zsh
  *function* that shadows `PATH`; the MCP is immune (it uses `spawn`), but your
  interactive shell isn't. Don't run `sshcon list …` by hand near secrets.
- **Local health gate fails on "port already allocated"** — another stack owns the
  host port. The engine will ask rather than reassign; free the port or pick
  another `proxy_port`.
- **Audit trail** — every privileged call is one JSON line in
  `~/.deploykit/audit.jsonl` (no secrets). `/deploykit:retro` reads it.
