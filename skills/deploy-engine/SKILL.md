---
name: deploy-engine
description: Shared knowledge for IndiaNIC's deploykit deployment commands (bootstrap-deploy, sync-upstream, redeploy). Use whenever deploying a project to our self-hosted GitLab + ISPConfig + rootless-Docker stack, parsing sshcon output, classifying env vars, wiring rootless Docker for a domain user, or diagnosing a failed deploy pipeline. Covers the non-negotiable safety invariants, the env-classification algorithm, and the failure->fix map.
---

# Deploy Engine — shared logic for deploykit

The commands (`bootstrap-deploy`, `sync-upstream`, `redeploy`) handle sequencing.
This skill is the SHARED reference they call into. When any deploy command runs,
these rules apply. When in doubt, this file wins over improvisation.

## 0. Non-negotiable invariants
These hold in EVERY phase of EVERY command. Violating one is a stop-the-line bug.

1. **Local-first.** Never deploy code that has not passed a local `docker compose
   up` health check on this machine. Fail on the laptop, not the server.
2. **Domain user runs the app.** All app container operations (build/up/restart/
   logs) run as the DOMAIN user over rootless Docker. Root is used exactly once,
   ever, to install rootless Docker for that user (§4). Never `docker` as root
   for the app.
3. **Secrets never enter git.** `.env` is server-side only, gitignored, and
   excluded from rsync. If a `.env` is ever staged, `git reset` it and warn.
4. **Env/volumes survive deploys.** rsync uses `--exclude .env --exclude '*-data/'`.
   A redeploy or rollback restores CODE only; data and secrets persist.
5. **Return only the URL on success.** Final line of a successful run is exactly
   `https://<domain>` — nothing appended. Exception: if TLS is not yet
   provisioned (§6 ssl-not-provisioned), the final line is `http://<domain>`
   with a one-line note to enable SSL — never claim `https://` without a cert.
6. **Ask, don't guess, on the four certainties.** internal_port, healthcheck_path,
   build_strategy, compose_service must be known (from profile or me), never
   assumed for an unknown stack.

## 1. sshcon contract (how to read our internal tool)
`sshcon list <key>` returns connection facts for a target. Output format is NOT
guaranteed stable, so:
- ALWAYS print the raw output first, then extract fields.
- Extract: HOST, PORT (default 22), USER, AUTH (key path or password), and — for
  a domain key — the DOMAIN DIRECTORY PATH (this becomes `APP_DIR`).
- `sshcon list <domain_key>`  -> the web/domain user (e.g. my-app). App runs here.
- `sshcon list <server_key>`  -> root on the box (e.g. web-host). §4 setup only.
- If any field is ambiguous, show me the raw block and ask which line is which.
  Do NOT hardcode a parser that silently mis-reads a field.

### 1a. Auth is key-first, then password (the #1 field gap)
The MCP tries **SSH key auth first, then password** — many servers are key-only
for root and password-only can never connect. You do not manage credentials; you
choose a working METHOD:
- **`ssh_auth_preflight{ session_id }`** reports which methods a host OFFERS
  (`key-only` / `password-only` / `both`) using NO credential. Run it when a
  connect fails or before guessing.
- For a **key-only** host, reuse the project's GitLab deploy key: resolve with
  **`deploy_key_env`** naming the env var that holds the base64 `SERVER_ACCESS`
  key (e.g. `sshcon_resolve{ key, kind, deploy_key_env: "SERVER_ACCESS" }`). The
  value stays server-side; it is decoded into a temp identity and tried first.
- A `~/.deploykit/targets.json` entry may carry a key AND a password (fallback
  pair), and a `keyB64`/`keyEnv` key source. The MCP never pipes a script over
  `bash -s` stdin under sshpass and never puts a password on argv — you don't
  script SSH by hand, but know this so you can read an auth failure.
- **`reload_config`** re-reads the sshcon key allowlist without a restart
  (sshcon_resolve already hot-reloads it per call).

## 2. Profiles (stack knowledge lives in data, not code)
Load `profiles/<stack>.yml` after stack detection; fall back to `_fallback.yml`.
The profile supplies: internal_port, healthcheck_path(+fallback+grace),
build_strategy, compose_service, secret_gen[], env_classify[] overrides,
integrations{}, volumes[], override hints. The engine NEVER contains per-stack
branching — to support a new stack, add a yml, don't edit commands. Detection
signals: laravel = artisan+composer.json; nextjs = package.json + next dep;
else structural detection -> _fallback.

## 3. Env classification algorithm
Goal: split every discovered env key into what we generate, derive, must ask, or
skip — so the Phase 2 questionnaire is minimal and correct.

1. **Discover** the union of keys from: `.env`, `.env.example`, compose
   `environment:`/`env_file:`, and framework config.
2. **Classify** each key. Run the generic pass, then apply the profile's
   `env_classify` regex overrides (profile wins). Classes:
   - `AUTO`   — we generate (e.g. APP_KEY). Use profile `secret_gen`. Respect
                `only_if_absent`: never rotate an existing secret on redeploy.
   - `DERIVED`— computed from server facts: APP_URL=`https://<domain>`,
                PUID/PGID from `id -u`/`id -g` of the domain user, host port =
                `<proxy_port>`, ENV=production.
   - `SECRET` — required, no safe default (DB passwords, tokens). Ask; mask;
                store server-side only. Group via `when:` (e.g. only ask Postgres
                creds if DB_CONNECTION=pgsql).
   - `INTEGRATION` — optional feature (SMTP, Slack, S3, OAuth ...). Default SKIP;
                ask only if I enable the group.
   - `IGNORE` — has a sane default; don't prompt (e.g. LOG_LEVEL).
3. **Next.js build-time trap.** Keys matching `build_time_env_prefix`
   (`^NEXT_PUBLIC_`) are INLINED AT BUILD. Pass them as compose `build.args` AND
   runtime env, or the app ships wrong values silently. Changing one => rebuild.
4. **Present** grouped (Core / datastore / integrations), show DERIVED values for
   confirmation, never print SECRET values back. Then STOP for my answers.

## 4. Rootless Docker (the one-time root step)
The ONLY privileged operation. Idempotent — guard so re-runs are no-ops.
As root (server_key):
- Verify the domain user exists (`id <user>`); abort if not (ISPConfig owns it).
- `apt-get install -y uidmap dbus-user-session docker-ce-rootless-extras`
- `loginctl enable-linger <user>`   (so the user's Docker survives logout)
- As the user, with a live session bus:
  `dockerd-rootless-setuptool.sh install --force`
  `systemctl --user enable --now docker`
  ensure `~/.bashrc` exports `DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock`
- Verify: `docker version --format {{.Server.Version}}` AS the domain user.
If this fails, STOP and show output. NEVER fall back to root Docker — that breaks
invariant #2 and the per-user isolation guarantee.
Ports: rootless can bind >1024. Host `<proxy_port>` and container port are both
high, so Apache->127.0.0.1:<proxy_port>->container works without extra privilege.

### 4a. Real ISPConfig hardening (already baked into `grant_docker_access`)
The one fixed script the MCP runs as root handles three failures live ISPConfig
hosts throw — you do not script these by hand, but know them so you can read a
failure:
- **Immutable home** (`chattr +i` web root): the script detects it, clears it
  only long enough to create the writable `.config`/`.local` subtrees, and
  restores `+i` on every exit path. The home is never left unlocked.
- **One uid, two usernames**: systemd keys off the first passwd entry, so the
  unit is written into the systemd-resolved home and HOME/XDG are pinned there.
- **No user session bus** under `su -`/`sudo -i`: it enables linger, verifies
  `/run/user/<uid>/bus` exists, and drives `systemctl --user` with an explicit
  `XDG_RUNTIME_DIR`+`DBUS_SESSION_BUS_ADDRESS`; if the bus is missing it prints
  exact remediation instead of failing opaquely.

### 4b. Root-optional path (operator has no root session)
On a managed box the operator often has SSH to the DOMAIN user but cannot get
root — their server team can. Do NOT try to work around this and do NOT weaken
invariants #2/#3. Instead:
1. Call `emit_root_runbook{ domain_user, host }`. It runs nothing — it returns a
   copy-pasteable, annotated bash runbook (the same operations as the root
   script) plus a cover note to hand to the server team, ending in one
   `DEPLOYKIT_VERIFY:` line they paste back.
2. Give the runbook to whoever holds root; STOP and wait.
3. When they confirm, PREFLIGHT with the read-only diagnostic verbs before
   resuming — no root needed: `docker.info.rootless` (rootless security options),
   `systemd.user.docker` (is the user unit active), `fs.lsattr.home` (immutable
   flag still set), `subid.subuid`/`subid.subgid` (subordinate id ranges exist).
   Only proceed to deploy once these confirm the setup landed.

`grant_docker_access` now also **installs Docker CE if the box has none** (no
Docker + no apt repo was a hard stop before) and **tolerates the setuptool's own
`systemctl --user` failure** in the uid-remap case, finishing via unit
relocation. Its result surfaces `docker_ce_installed` / `setuptool_nonzero` /
`immutable_home_handled` / `uid_remapped` / `auth_method_used`.

### 4c. Host preflight BEFORE any build (the biggest prevention win)
Run **`host_preflight{ session_id }`** early. It is read-only and reports, per
host, the facts that decide whether it can build/run the app, with warnings:
- **`cpu_x86_64_v2`** — sharp (LobeHub) needs x86-64-v2 at BUILD **and** RUN.
- **`usable_mem_mb`** (avail + swap) vs the ~8 GB build peak — add swap or build
  elsewhere.
- **`disk_quota_hard_mb`** — ISPConfig defaults the domain user to 2 GB; rootless
  images/volumes fill `$HOME` → `disk quota exceeded`. Raise it in the ISPConfig
  panel (a raw `setquota` may be reverted by ISPConfig's quota sync).
- **`docker_present` / `rootless_docker_active`**.
Use `ok_to_build_here` + the warnings to drive build-host selection (§5a).

## 5a. Build-host selection (capability-driven, with fallbacks)
Do NOT assume "build on the server" or "build on the runner". Pick a build host
by CAPABILITY (from `host_preflight` on each candidate) and fall back:
1. A runner/host that is **x86-64-v2 + has Docker + enough RAM** → build and push
   to the GitLab Container Registry; the server does `docker compose pull`.
2. Else **build on the server** if it is v2 and has RAM/swap — **add swap first**.
3. Else **build locally** and push. On **Apple Silicon** the local build MUST use
   `colima start --vz-rosetta`; plain QEMU crashes Node/pnpm with SIGABRT (134).
Gotcha: a GitLab **"docker-exec" runner is often a SHELL executor with host
Docker** — `image:` / `services: dind` are silently IGNORED. Use host `docker`
directly. And the RUN host must also be v2 for sharp at runtime, not just the
builder.

## 5b. Compose authoring defaults the engine enforces
- **Named volumes, never bind mounts under `DEPLOY_PATH`.** `DEPLOY_PATH` is the
  web docroot — data there is web-exposed and clobbered by rsync `--delete`. Named
  volumes live in rootless Docker storage and survive deploys.
- **Datastores are internal-only** on a shared box (no host ports); publish only
  the app on `127.0.0.1:<proxy_port>`.
- For local health-gating when the proxy port is busy, override with compose
  **`ports: !override`** — compose MERGES port lists otherwise → double-bind clash.
- **Lint generated YAML** with `lint_yaml` before committing: a `- echo "WARN: x"`
  plain scalar breaks on the `: ` (colon-space). Prefer block scalars / quote it.

## 5. Deploy mechanics (CI job shape)
rsync working tree -> `$APP_DIR` (exclude .git/.env/*-data). Then, as the domain
user over rootless Docker: `docker compose up -d --build --remove-orphans` (or
`pull` for prebuilt strategy), `docker image prune -f`. Health-gate inside CI
against `https://<domain><healthcheck_path>` (or `http://` until TLS is
provisioned — see §6 ssl-not-provisioned). CI creds come from GitLab project
variables (SSH key, host, user, port, path) — names verified via
`glab variable list`, values never printed.

- **Health gate accepts 2xx AND 3xx.** An auth-gated app answers `/` with a
  30x -> `/login` and is healthy; a bare "2xx only" gate flags it as down. Use
  `health_check` with its default `expect=2xx|3xx` (tighten only if you know the
  path should be 2xx). A 000 is still a failure.
- **Reuse the org's CI variable NAMES.** This stack uses
  `SERVER_ACCESS/SERVER_IP/SERVER_USER/DEPLOY_PATH`, not generic `DEPLOY_*`.
  Read the repo's existing `.gitlab-ci.yml` and `glab variable list` first and
  reuse those names; never invent parallel duplicates.
- **Declare the environment scope.** Project variables are often scoped to an
  environment (e.g. `production`). A job WITHOUT `environment: name: <scope>`
  reads them as EMPTY and fails with a misleading "Host key verification
  failed". Discover the scope from `glab variable list` and set it on the job.
- **Select the compose file explicitly** with `-f`. A repo may ship a
  podman-only `compose.yaml` that `docker compose` prefers by filename;
  `analyze_repo` flags this (`podman_only`, `compose_warning`). Never auto-pick;
  prefer an operator-owned override over editing upstream's file.
- **Target the SELF-HOSTED project explicitly.** `glab -R owner/repo` defaults to
  gitlab.com → 404 on our instance, and a project can move namespace mid-flight
  (server4→server3, id stable). Pass `repo` (full URL or host/group/project) to
  `pipeline_run`/`pipeline_status`/`pipeline_trace` so glab hits the right host;
  a bare owner/repo is rejected. Pin the CI registry to `$CI_REGISTRY_IMAGE`
  (never a hardcoded path); the server authenticates its pull with the pipeline's
  own `CI_REGISTRY_USER`/`CI_REGISTRY_PASSWORD`.
- **Unshallow before push.** A branch from a `--depth 1` upstream fetch is
  rejected (`shallow update not allowed`). `git rev-parse --is-shallow-repository`
  → if true, `git fetch --unshallow` before pushing. Do this automatically.
- **Secrets via a file-type CI variable** (e.g. `LOBE_ENV`) written to
  `$DEPLOY_PATH/.env` at deploy time is the clean pattern — keep it. Values never
  printed.

## 6. Failure -> fix map (pipeline & runtime)
Apply in the auto-fix loop (max 3 cycles), then STOP and show the trace.

- **permission denied / host key** -> known_hosts not seeded or wrong DEPLOY_SSH_KEY
  var. Re-`ssh-keyscan`; re-check the CI variable.
- **`docker: command not found` over SSH** -> rootless not on PATH in a non-login
  shell. Use `ssh ... bash -lc '...'` and export `DOCKER_HOST` first.
- **port already allocated** -> another stack owns `<proxy_port>`. Do NOT reassign
  silently — ask me.
- **502 from Apache** -> container up but proxy port != published port. Reconcile
  override `publish:` with the vhost proxy target.
- **500 / app error** -> almost always missing/mis-set env or an unrun migration.
  Check server `.env` completeness; run the app's migrate step.
- **compose build error** -> read the trace, patch override/Dockerfile, retry.
- **health check 000/timeout** -> grace too short or app crash-looping. Check
  `docker compose logs`; raise `healthcheck_grace` only if it's a slow-boot app.
- **rootless install fails** -> missing uidmap/linger, or no user session bus.
  Re-run §4; do not work around with root.
- **`shallow update not allowed` on push** -> the branch came from a `--depth 1`
  fetch. `git rev-parse --is-shallow-repository`; if true, `git fetch
  --unshallow` before pushing. (learnings.yml: gitlab-shallow-push-reject)
- **CI SERVER_*/DEPLOY_* look empty; "Host key verification failed"** -> the
  variables are environment-scoped and the job has no `environment: name:`.
  Add the scope discovered from `glab variable list`. (gitlab-vars-environment-scoped)
- **`docker compose` picks the wrong file / fails on `userns_mode`/`:U`** -> a
  podman-only `compose.yaml` won by filename. Select with `-f`; use an
  operator-owned override. (podman-compose-precedence)
- **health check red but app is fine** -> auth gate returns 30x. Accept 3xx
  (§5). (auth-gate-3xx-healthy)
- **HTTPS health fails with a cert name mismatch** -> no `:443` vhost / no
  Let's Encrypt cert yet; 443 serves another vhost's cert. Enable SSL +
  Let's Encrypt in ISPConfig (DNS must resolve to the box first); until then
  health-check over HTTP and never claim `https://` success. (ssl-not-provisioned)
- **`detect_env` finds almost nothing; setting env has no effect** -> the app
  reads a settings JSON file at runtime, not `.env` (`config_model` is non-env).
  Configure via that JSON on the server (gitignored, in the data volume);
  don't rely on `.env` classification. (json-configured-app)
- **about to overwrite an existing `APP_DIR/.env`** -> a prior scaffold wrote
  it. Back it up to `.env.<ts>.bak`, add only missing keys, STOP on a
  conflict. (preserve-existing-server-env)
- **preflight reports a missing package** -> the server lacks a required binary.
  deploy-direct prints the install hint and STOPS; the operator installs it, then
  we re-check. The MCP never installs. (deploy-direct §9)
- **native app not on boot after reboot** -> `pm2 save` persists the list but boot
  start needs a pm2 startup unit (root). Report the `pm2 startup` command for the
  operator to run once; do not run it as root from the MCP.
- **`Permission denied (publickey,password)` with a correct password** -> key-only
  host, or the password path was mis-run. The MCP is key-first-then-password now;
  run `ssh_auth_preflight` to see offered methods, and for a key-only root host
  resolve with `deploy_key_env` (the base64 `SERVER_ACCESS` key). (auth-key-first)
- **`next build` fails deep (sharp) / SIGILL on the runner** -> build host is
  pre-x86-64-v2. `host_preflight.cpu_x86_64_v2`; build on a v2 host and push, or
  build locally on Apple Silicon with `colima --vz-rosetta`. (cpu-not-v2)
- **`disk quota exceeded` mid-pull** -> ISPConfig 2 GB default; rootless images
  live under `$HOME`. `host_preflight.disk_quota_hard_mb`; raise it in the
  ISPConfig panel (raw `setquota` may be reverted by ISPConfig). (ispconfig-quota)
- **build OOM / killed** -> peak ~8 GB; box RAM tight. `host_preflight.usable_
  mem_mb`; add a swapfile before building, or build elsewhere. (build-ram-peak)
- **CI `image:`/`services: dind` ignored** -> the "docker-exec" runner is a SHELL
  executor with host Docker. Use host `docker` directly. (docker-exec-shell-runner)
- **`apt-get install docker-ce-rootless-extras` 404s** -> no Docker + no Docker
  apt repo. `grant_docker_access` now installs Docker CE (get.docker.com) first.
  (no-docker-no-repo)
- **RustFS: `unknown field ID, expected Id`** -> upstream `bucket.config.json`
  uses `"ID"`; newer `minio/mc` wants `"Id"`. Ship the fix and keep bucket init
  NON-FATAL so a policy hiccup can't wedge the app. (rustfs-id-case)
- **`glab` 404 on a self-hosted project** -> `-R owner/repo` defaulted to
  gitlab.com. Pass a full URL / host/group/project as `repo`. (gitlab-selfhosted-ref)

## 7. Rollback contract
`git reset --hard <good_sha>` + `git push --force-with-lease` redeploys prior
CODE. Server `.env` and volumes are untouched (excluded from rsync --delete).
Caveat: a code rollback does NOT reverse DB migrations already applied — restore
code, then flag the migration state to me for a data decision. Never imply data
rolled back when it didn't.

## 8. Learned edge cases (memory across deploys)
At the START of every deploy (Phase 0/1), load `knowledge/learnings.yml`. It is
the append-only memory of problems earlier deploys already solved — so a new
project starts knowing them instead of rediscovering them the hard way.

For each entry whose `applies_when` matches THIS target (stack, host type such as
ISPConfig, config model, how the source was fetched, etc.):
- run its `detect` — a cheap check — during Phase 0/1;
- if it fires, PRE-APPLY the `fix` (when the fix is safe and idempotent) or
  PRE-WARN me with the `fix` text (when it needs a decision). Either way, say
  which learning matched, so the reasoning is visible.

Do not silently skip a matched entry, and do not treat a learning as a substitute
for the invariants in §0 — a learning informs, it never overrides. New lessons
are added by `/deploykit:retro` after a session; the data lives in the yml, this
section only says when to consult it.

## 9. Direct-to-server mode (deploy-direct — no git, no CI)
When the operator has SSH (and DB) details for a live server and no pipeline, use
`deploy-direct`: deliver code over SSH and run it natively under pm2 as the domain
user. Same §0 invariants. Two rules specific to this mode:
- **The MCP never provisions.** Preflight is READ-ONLY: from the profile's
  `requires:` list, check each binary with `bin.which`/`bin.version`. On any gap,
  PRINT the missing package + its install hint and STOP — the operator installs
  it manually and says continue; then re-check. Never install anything.
- **The app runs as the domain user under pm2** via fixed-argv verbs
  (`pm2.start.ecosystem`/`pm2.start.script`/`restart`/`reload`/`logs`/`status`/
  `save`). `pm2.start.script` is **Node-only** (a file inside app_dir, no
  interpreter/args); PHP-FPM/Octane and gunicorn/uvicorn need a repo
  `ecosystem.config.*` started via `pm2.start.ecosystem` — if a non-Node stack
  ships none, STOP and ask (never invent a dev server). The process **name is
  deterministic and reused** across redeploys (ecosystem `name`, else the domain
  user); check `pm2.status` first to choose start vs reload/restart, or a redeploy
  orphans the old process and duplicates it on the same port. A pm2 startup unit
  (boot persistence) needs root — the operator's step, reported not run.
- The local health gate (invariant #1) is NATIVE here, not `docker compose up`:
  run the same start command locally and curl the health path before shipping.
DB details are SECRET → server `.env` only. Health gate and TLS behaviour are the
same as §5.
