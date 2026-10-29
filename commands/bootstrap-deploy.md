---
description: Clone a GitHub project (or wire up a local working tree) into our GitLab+ISPConfig+rootless-Docker deploy pipeline, ask for env/integrations, deploy via compose, return the live URL.
argument-hint: source=<github_url|local_path|.> gitlab=<gitlab_url> domain_key=<sshcon_domain> server_key=<sshcon_root> proxy_port=<port> [branch=indianic/main]
allowed-tools: Bash, Read, Edit, Write
---

# Bootstrap-Deploy — universal one-shot setup

You are setting up a project (from a GitHub URL, or an already-local working
tree) into IndiaNIC's self-hosted pipeline.
Work through the PHASES **in order**. Do **not** skip the STOP in Phase 2.
Be terminal-driven: run real commands, read real output, never assume.
Available internal tools on this machine: `glab`, `sshcon`, `git`, `docker`, `rsync`.

## Inputs (parse from "$ARGUMENTS", apply defaults)
- source      = GitHub source repo URL, OR a local path / `.`   (required)
- gitlab      = target GitLab repo URL            (required)
- domain_key  = sshcon key for the DOMAIN user    (e.g. my-app)
- server_key  = sshcon key for ROOT on the box    (e.g. web-host)
- proxy_port  = host port Apache already proxies   (e.g. 50034)
- branch      = our working branch (default: indianic/main)

If any required input is missing, ask for it and stop.
> `source` may be a GitHub (or any) URL to clone, or a local path / `.` to use
> the CURRENT working tree as-is. See Phase 1 step 0 and Phase 3 for how the
> two cases diverge — everything from Phase 4 onward is identical either way.

--------------------------------------------------------------------
## PHASE 0 — Resolve server facts (read-only)
Run these and capture the values; echo a clean summary table at the end.

0. Load memory (deploy-engine §8): read `knowledge/learnings.yml`. For each entry
   whose `applies_when` matches this target (stack, ISPConfig host, config model,
   how the source was fetched), run its `detect` during Phase 0/1 and pre-apply
   or pre-warn with its `fix` — saying which learning matched. A learning informs;
   it never overrides the §0 invariants.

1. Domain SSH + path:
   `sshcon list <domain_key>`
   Parse: HOST, PORT(default 22), USER, and either KEY path or PASSWORD, and
   the DOMAIN DIRECTORY PATH. Store as DOM_HOST / DOM_USER / DOM_SSH / APP_DIR.
   > sshcon output format varies — print the raw output first, then extract.
   > If a field is ambiguous, show me the raw block and ask which line is which.

2. Root access (for one-time docker enablement only):
   `sshcon list <server_key>`  → ROOT_HOST / ROOT_USER / ROOT_SSH

3. Confirm the Apache proxy already targets 127.0.0.1:<proxy_port>:
   ssh as ROOT and grep the vhost:
   `grep -R "127.0.0.1:<proxy_port>" /etc/apache2/sites-* 2>/dev/null || true`
   If missing, WARN (don't fix — user said it's already done) and continue.

4. SSL/TLS preflight (a freshly provisioned ISPConfig domain often has NO :443
   vhost and NO Let's Encrypt cert yet — 443 then serves some OTHER vhost's
   cert, a silent name mismatch. The health gate downstream assumes HTTPS;
   don't let that assumption fail unnoticed):
   a. Check for a :443 block: `grep -R ":443" /etc/apache2/sites-*/<domain>* 2>/dev/null || true` (as ROOT)
   b. Check for a matching cert:
      `openssl s_client -servername <domain> -connect <domain>:443 </dev/null 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null`
      and/or `ls /etc/letsencrypt/live/<domain> 2>/dev/null`
   c. If either is missing, OR the cert's CN/SAN does not include <domain>
      (classic symptom: 443 answers with an unrelated vhost's cert): set
      `TLS_READY=false` and tell me to enable "SSL" + "Let's Encrypt SSL" for
      this site in ISPConfig (DNS must already resolve <domain> to this box
      for the http-01 challenge to pass). Do NOT hard-fail here — continue
      bootstrapping; downstream health checks (Phase 7/8) fall back to
      HTTP-through-Apache until the cert exists. NEVER report an HTTPS
      success while `TLS_READY=false`.
   d. If both present and matching: set `TLS_READY=true`.

Print summary:
| Fact | Value |
| DOMAIN (user@host:port) | ... |
| APP_DIR | ... |
| Proxy | 127.0.0.1:<proxy_port> |
| Root host | ... |
| TLS_READY | true / false |

--------------------------------------------------------------------
## PHASE 1 — Analyse the source (read-only)
0. Determine source type and set `SRC_DIR` — everything below (and Phase 1b's
   analyse/detect) must run against `$SRC_DIR`, never a stale temp clone:
   - `source` looks like a URL (`https://`, `git@`, `ssh://` ...) -> REMOTE.
     Continue to step 1.
   - `source` is `.` or an existing local filesystem path -> LOCAL. Resolve
     it to an absolute path and set `SRC_DIR=<that path>` — the CURRENT
     working tree IS the source. Skip step 1 entirely (no clone, no temp
     dir); run steps 2-6 directly against `$SRC_DIR`. Carry `SRC_DIR` and
     `LOCAL=true` forward into Phase 3 — there is no `upstream` remote to
     fetch in that phase.
1. [REMOTE only] `TMP=$(mktemp -d); git clone --depth 1 <source> "$TMP/src"; SRC_DIR="$TMP/src"`
2. Detect stack (check in this order, record what matches) — inspect `$SRC_DIR`:
   - PHP/Laravel: composer.json + artisan
   - Node/Next: package.json (+ next dep) / Vite
   - Python: requirements.txt / pyproject.toml
   - Go / Rust / Ruby / etc.
3. Detect container strategy:
   - Has `docker-compose.yml`?  -> primary path
   - Has `Dockerfile` only?     -> we'll wrap it in a minimal compose
   - Neither?                   -> STOP and tell me; this pipeline is docker-first
4. Detect the container's internal PORT:
   grep EXPOSE in Dockerfile and `ports:`/known defaults in compose.
5. Collect required ENV: union of keys from `.env`, `.env.example`,
   compose `environment:`/`env_file:`, and framework config.
   For each key classify as one of:
     AUTO      - we generate (e.g. APP_KEY)
     DERIVED   - from server facts (APP_URL, PUID/PGID, host port)
     SECRET    - required, must be supplied (DB passwords, tokens)
     INTEGRATION - optional feature (SMTP, Slack, S3, OAuth ...)
6. Do NOT print secrets; print the CLASSIFIED KEY LIST only.

--------------------------------------------------------------------
## PHASE 1b — Load stack profile (makes this engine stack-agnostic)
> Runs right after Phase 1 detection. Turns "what stack is this" into data.
1. Map the detected stack to `profiles/<stack>.yml` (laravel, nextjs, node,
   python ...). If none matches, load `profiles/_fallback.yml`.
2. Read these fields from the profile and use them everywhere below:
     internal_port      - container's listen port (overrides EXPOSE guess)
     healthcheck_path   - path that returns 200 when healthy (e.g. /up, /)
     build_strategy     - compose-build | prebuilt-image | wrap-dockerfile
     compose_service    - primary service name to target
     secret_gen[]       - { key, cmd }  e.g. { APP_KEY, "base64:$(openssl rand -base64 32)" }
     env_classify[]     - regex->class overrides for Phase 1 classification
     healthcheck_grace  - seconds to wait before first health poll
3. Profile is DATA only. Adding a new stack = new yml, never touch this engine.

--------------------------------------------------------------------
## PHASE 2 — STOP. Ask me before writing anything
Present a single consolidated questionnaire. Group by:
  A) Core (auto/derived — show the values you WILL use, ask me to confirm)
  B) Datastore choice — sqlite (default) vs external Postgres (I self-host PG)
  C) Optional integrations — list each detected one; default = SKIP
For each SECRET/INTEGRATION I choose to enable, ask for the value.
Then WAIT for my reply. Do not proceed to Phase 3 until I answer.

--------------------------------------------------------------------
## PHASE 3 — Local repo wiring (dual-remote, or in-place for a local source)
Work in the CURRENT repo directory (the blank GitLab checkout) — UNLESS Phase 1
set `LOCAL=true`, in which case `$SRC_DIR` (the working tree given as
`source`) IS the repo you work in; there is no separate GitLab checkout to
merge into.
1. Move the analysed source in cleanly:
   - REMOTE (`source` was a URL):
     - `git remote add upstream <source>`
     - `git fetch upstream --depth 1`
     - `git checkout -b <branch> upstream/HEAD`   (source tree, our branch)
     - Ensure `origin` points to <gitlab>:
       `git remote set-url origin <gitlab>` (add if absent)
     - `git fetch origin` and PRESERVE any existing `.gitlab-ci.yml` from
       origin's default branch by copying it aside as `.gitlab-ci.yml.orig`
       (we rewrite CI in Phase 5; keep theirs for reference).
   - LOCAL (`source` was `.` or a local path) — treat the working tree AS the
     source; SKIP the upstream clone entirely, there is no upstream:
     - `cd "$SRC_DIR"`
     - If it is NOT already a git repo (`git rev-parse --is-inside-work-tree`
       fails): `git init`, then `git add -A && git commit -m "Initial
       commit"` to create the first commit on the working branch, then
       `git checkout -b <branch>` (rename if that's already the branch you're on).
     - If it IS already a git repo: use it in place — `git checkout -b
       <branch>` from its current HEAD (or switch to `<branch>` if it
       already exists).
     - Either way there is no `upstream` remote. Still set `origin` to the
       GitLab deploy target, same as the REMOTE case: `git remote add origin
       <gitlab>` (or `git remote set-url origin <gitlab>` if `origin`
       already points elsewhere) — Phase 7 pushes here identically either way.
     - `git fetch origin` and PRESERVE any existing `.gitlab-ci.yml` from
       origin's default branch as `.gitlab-ci.yml.orig`, same as REMOTE.
2. Add `.env` and `*-data/` volume dirs to `.gitignore` (never commit secrets).
3. Do NOT push yet.

--------------------------------------------------------------------
## PHASE 4 — Compose + env for OUR environment (local files)
1. If source has docker-compose.yml, create an OVERRIDE we own:
   `docker-compose.override.yml` that:
     - publishes `127.0.0.1:<proxy_port>:<internal_port>`  (bind localhost only)
     - sets `env_file: .env`
     - sets PUID/PGID to the DOMAIN user's uid/gid (fetch via ssh `id -u`/`id -g`)
     - names volumes under APP_DIR (e.g. ./databasement-data:/data)
     - restart: unless-stopped
   If only a Dockerfile exists, generate a minimal docker-compose.yml doing
   the same (build: . ; the single service).
2. Build the `.env` CONTENT in memory from Phase 2 answers:
     - AUTO: generate now (e.g. Laravel APP_KEY = `base64:$(openssl rand -base64 32)`)
     - DERIVED: APP_URL=https://<domain>, host port, PUID/PGID
     - SECRET/INTEGRATION: the values I gave (skipped ones omitted)
   Keep this content ONLY to write server-side in Phase 6. Do not commit it.
3. Commit the tree + override + our CI (added in Phase 5) on <branch>.

--------------------------------------------------------------------
## PHASE 4b — LOCAL up & verify (hard gate — never deploy unproven code)
Prove it runs on THIS machine before touching the server.
1. Write `.env` locally (temporary, gitignored) from the Phase 2 answers.
2. `docker compose up -d --build`
3. Wait `healthcheck_grace`s, then:
   `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:<internal_port><healthcheck_path>`
4. If not 2xx/3xx: tail `docker compose logs --tail=80`, diagnose, fix, retry
   (max 3 attempts). Common: missing env, migration step, wrong port.
5. On success: `docker compose down`, delete the local `.env`. Keep the proven
   `.env` CONTENT in memory for the server (Phase 6). Print "LOCAL OK".
> Do NOT proceed to Phase 5 until LOCAL OK.

--------------------------------------------------------------------
## PHASE 5 — Rewrite CI for docker deploy (reuse existing GitLab variables)
1. Discover the REAL variable names before inventing anything:
   - Read `.gitlab-ci.yml.orig` (saved in Phase 3), if present — an existing
     deploy job there already names the server-connection vars this org uses.
   - `glab variable list -R <gitlab>`   (names + environment SCOPE column
     only — never print values). This org has used names like
     `SERVER_ACCESS` / `SERVER_IP` / `SERVER_USER` / `DEPLOY_PATH` before —
     do NOT assume generic `DEPLOY_*` names; those below are a fallback ONLY
     for a repo with no prior CI at all.
   - REUSE whatever real names you find for SSH key / host / user / port /
     path. Never create a parallel `DEPLOY_*` duplicate of a variable that
     already exists under another name — the job would silently read empty
     values while the real ones sit unused under the other name.
   - Note the environment SCOPE `glab variable list` reports for each var
     (e.g. `production`, or blank for "all environments"). Call this
     `CI_ENV_SCOPE`. If names are still unknown/absent after both checks,
     ask me to confirm the mapping.
   - If a needed var is genuinely missing, create it:
     `glab variable set NAME -R <gitlab>` (masked/protected for secrets,
     scoped to `CI_ENV_SCOPE` if the others are) — value from Phase 0 facts.
2. Environment-scoping gotcha (common, confusing failure — hit live: a job
   failed "Host key verification failed" not because the vars were missing,
   but because they were scoped to `production` and the job had no
   `environment:` block, so GitLab silently handed it EMPTY values). The
   generated job's `environment: name:` MUST equal `CI_ENV_SCOPE` from step 1
   — a job without a matching `environment:` gets blank `$SERVER_*`/`$DEPLOY_*`
   with no error to point at.
3. Write `.gitlab-ci.yml` (build_strategy = compose-build default). This
   uses the generic `DEPLOY_*` names for readability — substitute the REAL
   names discovered in step 1 throughout if they differ:

   stages: [deploy]
   deploy:
     stage: deploy
     rules:
       - if: '$CI_COMMIT_BRANCH == "<branch>"'
     environment:
       name: <CI_ENV_SCOPE from step 1 — e.g. production>
       url: https://<domain>   # or http://<domain> if Phase 0 set TLS_READY=false
     before_script:
       - eval $(ssh-agent -s)
       - echo "$DEPLOY_SSH_KEY" | tr -d '\r' | ssh-add -
       - mkdir -p ~/.ssh && chmod 700 ~/.ssh
       - ssh-keyscan -p "$DEPLOY_PORT" "$DEPLOY_HOST" >> ~/.ssh/known_hosts
     script:
       # rsync working tree to the domain dir — NEVER ship .env or data/git
       - rsync -az --delete
           --exclude '.git' --exclude '.env' --exclude '*-data/'
           -e "ssh -p $DEPLOY_PORT"
           ./ "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/"
       # domain user brings up their OWN containers (rootless docker)
       - ssh -p "$DEPLOY_PORT" "$DEPLOY_USER@$DEPLOY_HOST"
           "export DOCKER_HOST=unix:///run/user/$(ssh -p $DEPLOY_PORT $DEPLOY_USER@$DEPLOY_HOST id -u)/docker.sock;
            cd $DEPLOY_PATH &&
            docker compose up -d --build --remove-orphans &&
            docker image prune -f"
       # health gate from inside CI — scheme matches Phase 0's TLS_READY
       - sleep <healthcheck_grace>
       - 'curl -fsS -o /dev/null -w "%{http_code}\n"
            https://<domain><healthcheck_path> | grep -qE "^(200|30[0-9])$"'
            # swap to http://<domain> here too if TLS_READY=false

   > For build_strategy=prebuilt-image, replace `--build` with a pinned
   > `image:` in the override and `docker compose pull` before up.
4. Keep `.gitlab-ci.yml.orig` (Phase 3) in the repo root for reference.

--------------------------------------------------------------------
## PHASE 6 — One-time ROOT step + server-side secrets (privileged, idempotent)
This is the ONLY place root is used. Everything after is the domain user.
1. Rootless Docker for the domain user (run once; guard so re-runs are no-ops):
   ssh ROOT (server_key) and run:
     id <DOM_USER> >/dev/null 2>&1 || { echo "domain user missing"; exit 1; }
     apt-get update -y && apt-get install -y uidmap dbus-user-session docker-ce-rootless-extras || true
     loginctl enable-linger <DOM_USER>
     # perform rootless install AS the domain user, with a live user session bus
     sudo -iu <DOM_USER> bash -lc '
       export XDG_RUNTIME_DIR=/run/user/$(id -u)
       command -v dockerd-rootless-setuptool.sh >/dev/null &&
       dockerd-rootless-setuptool.sh install --force || true
       systemctl --user enable --now docker 2>/dev/null || true
       grep -q DOCKER_HOST ~/.bashrc ||
         echo "export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock" >> ~/.bashrc
     '
   Verify: `sudo -iu <DOM_USER> bash -lc 'docker version --format {{.Server.Version}}'`
   If this fails, STOP and show me the output — do not fall back to root docker.
2. Server-side `.env` (secrets live here only, once; preserved across deploys):
   ssh as DOMAIN user and check `$APP_DIR/.env`:
   - ABSENT -> write the proven `.env` content from Phase 4b directly.
   - PRESENT (e.g. a prior pm2/Postgres scaffold already wrote one before this
     pipeline touched the box) -> NEVER overwrite it blindly:
       a. Back it up first: `cp $APP_DIR/.env $APP_DIR/.env.$(date +%Y%m%d%H%M%S).bak`
       b. Diff its keys against the proven Phase 4b content. Add only keys
          that are MISSING; never change a value that's already set there —
          it may be the real production value (e.g. a Postgres password for
          a DB that already exists), not what we guessed locally.
       c. If a key we need is present with a CONFLICTING value, STOP and show
          me both — don't guess which one is authoritative.
     Only write the merged file after the backup exists.
3. Ensure volume dirs exist: `mkdir -p $APP_DIR/<service>-data`.

--------------------------------------------------------------------
## PHASE 7 — Push, then monitor the pipeline and auto-fix
1. Commit everything on <branch>.
2. Shallow-push guard (GitLab rejects a shallow repo outright with "shallow
   update not allowed" — this bites any repo that went through Phase 3's
   `--depth 1` fetch, or any shallow clone handed to us before this phase):
   `git rev-parse --is-shallow-repository` — if `true`, run `git fetch
   --unshallow` (against `origin`; `upstream` may already be gone) BEFORE
   pushing, and re-check it now reports `false`.
3. `git push -u origin <branch>`
4. Watch the pipeline:
   `glab ci status -R <gitlab> --branch <branch>` (poll) and on failure
   `glab ci trace -R <gitlab>` on the failed job.
5. Auto-fix loop (max 3 cycles): diagnose the failing job, apply the fix,
   commit, push, re-watch. Known failure -> fix map:
     - host key / permission denied -> re-check known_hosts + the discovered
       SSH-key variable (Phase 5 step 1 — may not be named DEPLOY_SSH_KEY)
     - "shallow update not allowed" -> re-run step 2's unshallow check
     - SERVER_*/DEPLOY_* look empty but exist in `glab variable list` ->
       environment-scoping gotcha (Phase 5 step 2); confirm the job's
       `environment: name:` matches `CI_ENV_SCOPE`
     - "docker: command not found" over SSH -> rootless not on PATH -> export
       DOCKER_HOST + use `bash -lc` (login shell) in the ssh command
     - port already allocated -> another stack owns <proxy_port>; ask me
     - compose build error -> read trace, patch override/Dockerfile, retry
     - 502 from Apache -> container up but proxy port mismatch; reconcile
       override publish port with the vhost proxy target
6. Stop when the pipeline is green AND the environment URL health check passed
   (see Phase 8 for how TLS_READY affects that check).

--------------------------------------------------------------------
## PHASE 8 — Verify & return ONLY the URL
1. Final external check, scheme decided by Phase 0's `TLS_READY`:
   - `TLS_READY=true`  -> `curl -fsS -o /dev/null -w '%{http_code}' https://<domain><healthcheck_path>`
   - `TLS_READY=false` -> `curl -fsS -o /dev/null -w '%{http_code}' http://<domain><healthcheck_path>`
     (interim HTTP-through-Apache check — do NOT probe or report `https://`
     here; 443 is still serving a mismatched cert and a "successful" TLS
     handshake would be misleading, not a real success)
2. If 200/30x and `TLS_READY=true`: print a one-line summary table (stack,
   branch, APP_DIR, pipeline id) and then, on its OWN final line, print exactly:
     https://<domain>
   If 200/30x and `TLS_READY=false`: print the same summary table plus a note
   that SSL is not yet provisioned (Phase 0) and how to fix it, then on its
   OWN final line print exactly:
     http://<domain>
   Do not print an `https://` line while `TLS_READY=false` — that would claim
   a security guarantee that doesn't hold yet.
3. If not healthy: print the failing layer (Apache / compose / app) and the
   single most useful log excerpt. Do not claim success.

====================================================================
## APPENDIX — Upstream sync runbook (GitHub -> our changes -> GitLab deploy)
Use `/sync-upstream` (or run manually) whenever you want the latest source:
  git fetch upstream
  git checkout <branch>
  git merge upstream/HEAD        # resolve conflicts only in files WE changed
  # our override/CI/.gitignore live outside upstream's tree, so they survive
  git push origin <branch>       # -> triggers Phase 5 pipeline -> redeploys
Isolation guarantee: our environment-specific files
(docker-compose.override.yml, .gitlab-ci.yml, .gitignore, profiles) are ours;
source code stays mergeable from upstream. Secrets never enter git either side.
