# deploykit MCP — improvement spec (from a self-hosted LobeHub deploy)

> **Status (2026-08-06, branch `deploykit-mcp-hardening`).** Implemented top-down
> with smoke coverage for each (91 → 131 assertions):
> - **A. Auth** — DONE. Key-first-then-password executor; password path no longer
>   sets `BatchMode=yes` (the field bug); root script delivered by scp (no `bash
>   -s` stdin); `ssh_auth_preflight`; `deploy_key_env` (base64 `SERVER_ACCESS`).
> - **B. Hot-reload** — DONE. Allowlist re-read per call + `reload_config`.
> - **C. grant_docker_access** — DONE. Installs Docker CE if absent; tolerates the
>   setuptool uid-remap `systemctl --user` failure (dual-home relocation kept).
> - **D. Host preflight** — DONE. `host_preflight`: CPU v2, RAM/swap, quota, Docker.
> - **E. Build-host selection** — DOCUMENTED (SKILL §5a) + fed by `host_preflight`;
>   the selection/CI orchestration lives in the deploy commands, not the MCP.
> - **F. Profiles** — DONE. `detect_env` deep-scan; `profiles/lobehub.yml` +
>   detection; RustFS `ID→Id` + non-fatal init encoded in the profile.
> - **G. Compose defaults** — `lint_yaml` (colon-trap) DONE; named-volume /
>   internal-only / `!override` rules in `profiles/lobehub.yml` + SKILL §5b.
> - **H. GitLab** — self-hosted `repo` ref (`-R`) on `pipeline_*` DONE; registry
>   pin / auto-unshallow / env-scoping documented in SKILL §5/§6.
>
> New learnings appended to `knowledge/learnings.yml` (source_session:
> lobehub-selfhost-deploy) so future deploys start knowing them.


Real deploy: self-hosted **LobeHub** (Next.js, server-DB mode) → ISPConfig + rootless
Docker on a shared DO box, GitLab CI. It succeeded, but only after ~a dozen
detours the MCP could have prevented. Findings are ordered by impact. Each has:
**symptom → root cause → what the MCP should do** (mapped to existing verbs where
possible). No secrets included.

---

## A. Auth is the #1 gap: `sshpass`-only breaks on real servers

**Symptoms (all hit live):**
- `grant_docker_access` / `domain_exec` returned `Permission denied
  (publickey,password)` for both root and the domain user, even though the
  password from sshcon was correct.
- After the operator changed the root password to strip special chars, the MCP
  *still* failed — but a direct `sshpass` with the exact same password worked
  from a normal foreground shell.
- Root SSH was later hardened to **key-only** (password auth disabled) — the MCP
  (password-based) then could never connect, period.

**Root causes:**
1. **Password with shell metacharacters** (`$ # @`) gets mangled if it's ever
   interpolated into a shell string (e.g. `$Q2w` expands to empty). The original
   root password failed for this reason.
2. **`sshpass` needs a TTY** to inject the password. Anything run detached /
   without a controlling terminal fails auth and falls back to pubkey → denied.
3. **`sshpass` + stdin redirection conflict**: `sshpass -e ssh host 'bash -s' <
   script.sh` — the `< script` steals the channel sshpass uses, so no password is
   sent → `Permission denied (publickey)`.
4. **No SSH-key auth at all.** This org's servers are key-first; the GitLab CI
   already stores a working deploy key (`SERVER_ACCESS`, base64). The MCP ignored
   it and only tried passwords.

**MCP fixes:**
- **Support SSH key auth as the primary method.** Accept a key path/handle;
  optionally reuse the project's GitLab `SERVER_ACCESS` deploy key (base64-decode
  → temp key → `ssh -i`). Try **key first, then password**.
- When using a password, pass it via **`SSHPASS` env (`sshpass -e`)**, never `-p
  "$pw"` in a shell string, and never interpolate it into a command string.
- **Never pipe a script via stdin under sshpass.** `scp` the script up, then
  `ssh host 'bash /tmp/x.sh args'`. (Or use key auth, which has neither problem.)
- Run auth-sensitive steps with a **PTY allocated** (`ssh -tt`) or, better, key
  auth so no PTY is needed (works detached/in background).
- Add a cheap **auth preflight**: `ssh -o PreferredAuthentications=none` to read
  which methods the server offers, and report "key-only / password / both" so the
  caller picks a working method instead of guessing.

## B. Allowlist config doesn't hot-reload

**Symptom:** editing `~/.deploykit/config.json` `sshconKeyAllowlist` had no effect;
`sshcon_resolve` kept rejecting the new keys until the whole MCP was reconnected.

**Fix:** re-read the allowlist (and `DEPLOYKIT_SSHCON_KEYS`) on **each call**, or
expose a `reload_config` verb. Requiring an MCP restart mid-deploy is brutal —
it risks losing the session's context.

## C. `grant_docker_access` is too optimistic about the box

Three real failures it should own:

1. **No Docker + no Docker apt repo.** It assumed `apt-get install
   docker-ce-rootless-extras` works; the box had neither Docker nor the repo, so
   it aborted. → **Install Docker CE if absent** (official repo / get.docker.com),
   then rootless-extras + compose plugin.
2. **"One uid, two usernames" systemd dual-home.** uid 5005 = `web3` (passwd-first
   name, home = immutable web root) *and* `op_webapp` (SSH login, home =
   writable subdir). `dockerd-rootless-setuptool.sh` (run as the login user)
   creates the unit in the login user's home, but the systemd `--user` manager
   reads units from the **passwd-first name's** home → `Unit docker.service not
   found`. Fix that worked: **relocate the unit into the manager's home**
   (clearing/restoring `chattr +i` around it) and **pin dockerd's HOME/XDG_*_HOME
   to the writable home** via a `docker.service.d` override. This case needs to be
   in `grant_docker_access` directly.
3. **It presumes success = daemon started.** The setuptool's own `systemctl
   --user start` fails in the dual-home case; the MCP should treat that as
   expected and finish via the relocation above, not hard-fail.

## D. Add a real host **preflight** verb (biggest prevention win)

Before any build/deploy, gather and surface:
- **CPU microarch level** of the *build host* — `ld.so --help | grep x86-64-v2`.
  LobeHub's `sharp` needs **x86-64-v2**; the GitLab `docker-exec` runner's CPU was
  pre-v2, so builds failed deep into `next build`. The **run host** must also be
  v2 for sharp at runtime. Report per host.
- **Domain-user disk quota.** ISPConfig defaulted to **2 GB**; rootless Docker
  stores images/volumes under the user's home → `disk quota exceeded` mid-pull.
  Detect (`quota -u <user>`), warn, and either raise (`setquota`) or tell the
  operator to set it in the ISPConfig panel (a raw `setquota` may be reverted by
  ISPConfig's quota sync — say so).
- **RAM + swap.** LobeHub build peak ~8 GB; box had ~4.7 GB free. Detect and
  offer to add a swapfile, or route the build elsewhere.
- **Docker present? rootless configured? which SSH auth methods?** (see A).

## E. Build-host selection needs to be capability-driven

The engine assumed "build on the server" OR "build on a docker runner". Reality:
the runner CPU couldn't build, the server RAM was tight, and the operator's
Apple-Silicon Mac needed Rosetta. The MCP should **pick a build host by
capability** and fall back:
1. a runner/host that is **x86-64-v2 + has Docker + enough RAM** → build + push to
   the GitLab Container Registry; server `docker compose pull`.
2. else **build on the server** if it's v2 and has RAM/swap (add swap first).
3. else **build locally** (note: Apple Silicon must use `colima start
   --vz-rosetta`; plain QEMU crashes Node/pnpm with SIGABRT 134) + push.
Detect the "docker-exec" runner is often a **shell executor with host Docker** —
so `image:`/`services: dind` are silently ignored; use host `docker` directly.

## F. Profiles / stack detection gaps (nextjs → lobehub)

- **`detect_env` only scanned the root `.env.example`** (found just
  `OPENAI_API_KEY`) and missed the real server-DB env surface in
  `docker-compose/deploy/.env.example`. → deep-scan compose subdirs for
  `.env*.example`.
- A **lobehub** profile should encode: needs **Postgres + pgvector** (use
  `paradedb/paradedb`, *not* the box's MySQL or a stock ISPConfig Postgres which
  lacks pgvector); **generate a fresh `JWKS_KEY`** (upstream ships a *public
  example* key — insecure to reuse) via `openssl`/node; **KEY_VAULTS_SECRET /
  AUTH_SECRET** = `openssl rand -base64 32`; server-DB mode is chosen at runtime
  by `DATABASE_URL` (no `NEXT_PUBLIC_SERVICE_MODE` build trap in current
  versions); provider keys (`GOOGLE_API_KEY`, etc.).
- **RustFS bucket init**: upstream's `bucket.config.json` uses `"ID"`, which newer
  `minio/mc` rejects (`unknown field ID, expected Id`). Ship a corrected policy
  and make the init step **non-fatal** so a policy hiccup can't wedge the app.

## G. Compose authoring defaults the engine should enforce

- **Named volumes**, not bind mounts under `DEPLOY_PATH` — `DEPLOY_PATH` is the
  **web docroot**; DB files there are web-exposed and get clobbered by rsync
  `--delete`. Named volumes live in rootless Docker storage, survive deploys.
- Datastores **internal-only** (no host ports) on a shared box; publish only the
  app on `127.0.0.1:<proxy_port>`.
- For local health-gating when the proxy port is busy, override with compose
  **`ports: !override`** (compose *merges* port lists otherwise → double-bind
  clash).
- **YAML colon-trap**: a `- ...` script line that is a *plain scalar* breaks on
  `: ` (colon-space), e.g. `echo "WARN: x"`. Bit us twice. Lint generated CI, and
  prefer block scalars / avoid `: ` in inline commands.

## H. GitLab specifics

- **Project can move namespace** mid-flight (server4→server3, id stable). `glab -R
  owner/repo` defaults to **gitlab.com** → 404 on self-hosted. **Resolve by
  numeric project id** (or the full git URL) for all API calls; pin the registry
  to `$CI_REGISTRY_IMAGE` rather than a hardcoded path.
- **Secrets via a file-type CI variable** (`LOBE_ENV`) written to
  `$DEPLOY_PATH/.env` at deploy time is a clean pattern — keep it. The server can
  auth its registry pull with the pipeline's own `CI_REGISTRY_USER/PASSWORD`
  (no separate deploy token).
- **Shallow-push guard** (`--depth 1` upstream fetch → GitLab rejects) — unshallow
  before pushing. Already in the runbook; make the engine do it automatically.
- **Environment scoping**: CI vars scoped to `production` are empty unless the job
  sets `environment: name: production`. (Already documented — keep enforcing.)

## I. What already worked well (keep)

- Health gate accepting **2xx AND 3xx** (LobeHub `/` → 302 `/signin`). Correct.
- `emit_root_runbook` as the root-optional escape hatch.
- The credential boundary itself — routing privileged ops through the MCP is the
  right design; it just has to actually connect (see A).
