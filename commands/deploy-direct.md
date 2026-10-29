---
description: Deploy code (git URL or local path) straight onto a live server over SSH — no GitLab, no CI. Read-only preflight reports any missing packages for you to install, then delivers the code and runs it natively under pm2 as the domain user.
argument-hint: "source=<github_url|local_path|.> target_key=<sshcon_or_targets_name> [proxy_port=<port>] [branch=indianic/main]"
allowed-tools: Bash, Read, Edit, Write
---

# deploy-direct — no-git, direct-to-server native deploy

For a project you want on a live server over SSH, with NO GitLab pipeline. The
app runs natively under pm2 as the domain user. This command NEVER installs
packages or runs anything as root — when the server is missing something it tells
you exactly what to install, stops, and continues once you've done it.

Load deploy-engine (SKILL.md): the §0 invariants and §8 learnings apply here too.

Inputs (parse from "$ARGUMENTS"):
  source       = github URL, a local path, or "." (the current working tree)
  target_key   = an sshcon domain key OR a name in ~/.deploykit/targets.json
  proxy_port   = host port Apache/nginx proxies to the app (optional; may come
                 from sshcon's Application Port)
  branch       = for a git source (default indianic/main)

--------------------------------------------------------------------
## PHASE 0 — Resolve the target (read-only)
Load memory: read knowledge/learnings.yml (§8) and run each matching `detect`.
Resolve the target to a session handle — `sshcon_resolve` for an sshcon key, or
`target_resolve` for a targets.json name. NEVER ask for or echo the password/key;
the handle carries only non-secret facts (host/user/app_dir). Record APP_DIR.

## PHASE 1 — Analyse the source (read-only)
- Local path / "." → use the working tree in place; do not clone.
- URL → shallow temp-clone (remember: unshallow before any later push — n/a here).
Run analyze_repo + detect_env against the ACTUAL dir. Determine the stack and load
profiles/<stack>.yml; fall back to _fallback (and ASK the four certainties +
which runtime binary it needs).

## PHASE 2 — PREFLIGHT gate (read-only; the heart of this command)
From the profile's `requires:` list, for each entry:
  - `domain_exec bin.which {bin}` → present? (non-zero exit = missing)
  - if `min` is set and present, `domain_exec bin.version {bin}` and compare the
    major version.
Collect every gap. If ANY are missing or too old, PRINT a table:

    MISSING/OUTDATED on <host> (domain user <user>):
      <bin>   need >= <min>   — <install hint>
      ...

Then STOP with: "Install these on the server, then tell me to continue." Do NOT
attempt to install anything. When I confirm, RE-RUN the checks. Proceed only when
every requirement passes.

## PHASE 3 — STOP. Ask me the env/DB questionnaire
Run the env-classification (§3). Show DERIVED values to confirm; group SECRET
(DB creds, tokens) and INTEGRATION; never print a SECRET back. DB connection
details I give are SECRET → destined for the SERVER .env only. STOP for answers.

## PHASE 4 — Local health gate (invariant #1) — NATIVE, not Docker
deploy-direct runs natively, so the local gate is NOT `docker compose up`. Prove
the app boots by running the SAME start command Phase 6 will use on the server —
the repo's ecosystem file, or the profile/asked start command — LOCALLY, then
curl the health path to confirm it responds. If this machine cannot run the app's
runtime (wrong OS/arch, heavy system deps), say so explicitly and get my
confirmation before shipping — never silently skip the gate.

## PHASE 5 — Deliver
- `rsync.push` the working tree → APP_DIR (excludes .git/.env/*-data are built in).
- Write the server .env from the Phase 3 answers. If APP_DIR/.env already exists,
  back it up to .env.<timestamp>.bak first, add only missing keys, STOP on a
  conflict (never overwrite a value blindly). .env is server-side only.

## PHASE 6 — Run under pm2 (domain user)
The process NAME must be DETERMINISTIC and reused across redeploys: use the `name`
field from the repo's ecosystem file if present, else the domain user (a stable,
unique per-site id). Never invent a fresh name per run — a different name on
redeploy orphans the old process and a retry starts a duplicate on the same port
(EADDRINUSE). This is invariant #6 territory: derive the name once, deterministically.

1. `domain_exec pm2.status` and look for that name:
   - present → this is a REDEPLOY: `pm2.reload {name}` (or `pm2.restart {name}`).
   - absent  → first run: start it (step 2).
2. Start:
   - **Node entrypoint:** `pm2.start.script {script} {name}` — `{script}` is a
     file INSIDE app_dir (`..`/absolute paths are rejected). pm2.start.script is
     Node-only: pm2 auto-detects the Node interpreter and passes no arguments.
   - **Anything needing an interpreter or arguments** (PHP-FPM/Octane,
     gunicorn/uvicorn, a queue worker): the repo MUST ship a pm2
     `ecosystem.config.*` that declares the interpreter/script/args/cwd; then
     `domain_exec pm2.start.ecosystem {ecosystem}`. This is the required path for
     laravel/python — `pm2.start.script` cannot express them. If no ecosystem
     file exists for such a stack, STOP and ask me to add one (invariant #6 —
     never invent a dev-only server like `php artisan serve`).
3. `domain_exec pm2.save` so the list survives a reboot (a pm2 startup unit needs
   root — if boot auto-start is required, tell me to run the `pm2 startup` output
   once; that is my step, not the MCP's).

## PHASE 7 — Verify & return the URL
`health_check https://<domain>` (accepts 2xx AND 3xx; auth gates 30x are healthy).
If TLS is not provisioned yet, health-check over http:// and return `http://<domain>`
with a note — never claim https success without a cert (§6 ssl-not-provisioned).
On success print ONLY the URL.

--------------------------------------------------------------------
## Failure → fix (see SKILL.md §6 for the shared map)
- preflight gap → print the install hint; STOP; never install.
- pm2 not found → it's in the `requires:` list; the preflight should have caught
  it. Re-run preflight.
- app up but 502 → proxy port != the port the app listens on. Reconcile the vhost
  proxy target with the app's PORT; do not reassign silently — ask.
- app crash-loops → `pm2.logs {name} 100`; it's almost always missing env or an
  unrun migration. Check the server .env; run the app's migrate step.
