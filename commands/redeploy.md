---
description: Fast redeploy of the current deploy branch — rebuild + restart containers, preserve server .env and volumes, health-gate, return URL. No upstream sync, no env prompts.
argument-hint: "[branch=indianic/main] [--no-build] [--restart-only] [--rollback] [--local]"
allowed-tools: Bash, Read
---

# redeploy — rebuild & restart the current branch (env-preserving)

For when the code on <branch> is already correct and you just need it live again:
a local edit you've committed, a container that died, a config tweak. This does
NOT touch upstream and does NOT re-ask env questions. Server .env and volumes are
always preserved.

Inputs (parse from "$ARGUMENTS"):
  branch         = deploy branch                 (default: indianic/main)
  --no-build     = `up -d` WITHOUT --build (use existing image; fastest)
  --restart-only = just `restart` the service, no up/build (fastest possible)
  --rollback     = redeploy the previous commit on this branch (see ROLLBACK)
  --local        = run the local health gate only; do NOT push/deploy

Load profiles/<stack>.yml first (Phase 1b of the engine) for internal_port,
healthcheck_path, healthcheck_grace, compose_service.

--------------------------------------------------------------------
## PHASE 0 — Preconditions
1. `git remote -v` -> confirm origin = our deploy repo. If not, STOP.
2. `git checkout <branch>`; `git status --porcelain`:
   - If dirty: these are UNCOMMITTED changes. A redeploy ships only what's
     committed+pushed. Ask: commit them now, or proceed with last pushed state?
     Do not silently ship or silently drop them.
3. Record CURRENT_SHA = `git rev-parse HEAD` (for rollback), print it.
4. Confirm we're in sync with origin:
   `git fetch origin && git rev-list --left-right --count origin/<branch>...HEAD`
   If local is ahead, we'll push in Phase 3; if behind, warn (someone else pushed).

--------------------------------------------------------------------
## PHASE 1 — Local health gate (skipped only for --restart-only)
Never redeploy an image that won't boot here first.
1. Temp local `.env` (gitignored), minimal-but-sufficient; reuse known values.
2. Build/up per flags:
     default        -> docker compose up -d --build
     --no-build     -> docker compose up -d
     --restart-only -> SKIP local gate entirely (nothing rebuilt)
3. Wait healthcheck_grace, curl 127.0.0.1:<internal_port><healthcheck_path>.
4. Fail -> tail `docker compose logs --tail=80`, report, STOP. Do not push.
5. Pass -> `docker compose down`, delete temp `.env`, print "LOCAL OK".
6. If --local: stop here with the local result. Do not deploy.

--------------------------------------------------------------------
## PHASE 2 — Trigger the deploy
Two ways to reach the server; prefer the pipeline for auditability.

A) PIPELINE (default — goes through GitLab CI, logged, same as normal deploys):
   1. If local is ahead of origin: `git push origin <branch>`.
   2. If nothing to push (image/config only, no new commit), trigger a run so
      the deploy job re-executes on the same SHA:
        `glab ci run -R <origin> --branch <branch>`
   3. Monitor: `glab ci status -R <origin> --branch <branch>`;
      on failure `glab ci trace`. Auto-fix up to 3 known-failure cycles.

B) DIRECT (only if I pass --restart-only, or CI is down and I say so):
   SSH as the DOMAIN user (never root) via sshcon creds, in $APP_DIR, as the
   domain user's rootless docker:
     export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
     cd $APP_DIR
     # pick per flag:
     docker compose up -d --build --remove-orphans     # default
     docker compose up -d --remove-orphans             # --no-build
     docker compose restart <compose_service>          # --restart-only
     docker image prune -f
   This path does NOT create a pipeline record — use sparingly.

--------------------------------------------------------------------
## PHASE 3 — Verify & return URL
1. External health check: curl https://<domain><healthcheck_path> (expect 200/30x).
2. On success: one-line summary (mode used, SHA, pipeline id if any), then on its
   own final line, exactly:
     https://<domain>
3. On failure: identify the layer (Apache 502 = proxy/port; container down =
   compose; 500 = app/env) and show the single most useful log line. Offer
   ROLLBACK. Do not claim success.

--------------------------------------------------------------------
## ROLLBACK (--rollback, or offered on failure)
Redeploy the previous good commit on this branch:
  PREV=$(git rev-parse <branch>~1)
  git checkout <branch>
  git reset --hard "$PREV"
  git push --force-with-lease origin <branch>     # pipeline redeploys PREV
Then re-run Phase 3 verification.
Server .env and volumes are excluded from rsync --delete, so data and secrets
survive the rollback untouched. If the bad state already ran DB migrations,
rollback restores CODE only — flag that to me so I decide on data remediation.
