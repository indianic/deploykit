# deploy-direct Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `deploy-direct` mode that deploys code (git or local) straight onto a live server over SSH — no GitLab/CI — running it natively under pm2, after a read-only preflight that reports (never installs) any missing packages.

**Architecture:** Zero new privileged surface. New capability is entirely (a) read-only preflight verbs + native pm2 run verbs added to the existing closed `VERB_ALLOWLIST` (run by the existing `domain_exec`), (b) a `requires:` data block in profiles that drives the preflight, and (c) a new command doc that orchestrates the phases. The MCP never installs packages or runs anything as root; the operator provisions manually when preflight reports a gap.

**Tech Stack:** TypeScript (NodeNext ESM, strict), `@modelcontextprotocol/sdk` v1.29, zod. Tests are assertions in `deploykit-mcp/scripts/smoke.mjs`, run via `npm run smoke` (self-contained, mocked ssh; no real infra). Build via `npm run build` (esbuild bundle → `dist/server.js`, committed).

## Global Constraints

- Verbs are fixed-argv templates with regex-validated params; no shell string, no raw command, no agent free-text reaching argv. (invariant #2)
- All child procs go through `spawn(shell:false)`; the only shell is the remote `bash -lc` built from a fixed template. No `exec`, no string commands.
- The MCP never installs packages, creates DBs, or runs anything as root for setup. Preflight is read-only; gaps are reported for the operator to fix.
- App processes run as the DOMAIN user (never root). (invariant #2)
- Secrets never enter git, argv, or `audit.jsonl`; `detect_env` returns key names/classes only. (invariants #4/#5)
- `{app_dir}`, `{user}`, `{host}` resolve from session facts; all other `{tokens}` are declared, regex-validated params (see `resolveTemplate` in `exec.ts`).
- `npm run build` must pass with zero TS errors and `npm run smoke` must be 0-failed after every task. Do not hand-edit `dist/`.
- Do NOT commit `dist/server.js` until it is rebuilt in the same task; rebuild before committing.
- Commit style: no `Co-Authored-By: Claude` trailer, no `Claude-Session` trailer, no AI-attribution (repo rule).

---

### Task 1: `requires:` blocks in profiles (data that drives preflight)

**Files:**
- Modify: `profiles/nextjs.yml`, `profiles/python.yml`, `profiles/laravel.yml`, `profiles/_fallback.yml`
- Test: inline `python3 -c` yaml validation (profiles are not covered by smoke.mjs)

**Interfaces:**
- Produces: a `requires:` list per profile — the source of truth the `deploy-direct` command loops over. Shape:
  ```yaml
  requires:
    - bin: <string, PATH binary name>
      min: "<optional major version string>"
      install: "<human hint printed on a gap — per-OS-vague, NOT an exact apt line>"
  ```
  Consumed by Task 4 (the command reads `requires:` and calls the `bin.which`/`bin.version` verbs from Task 2).

- [ ] **Step 1: Add `requires:` to `profiles/nextjs.yml`** (append at top level)

```yaml
requires:
  - bin: node
    min: "18"
    install: "Install Node 18+ (nvm, or NodeSource) for the domain user"
  - bin: npm
    install: "Ships with Node"
  - bin: pm2
    install: "npm i -g pm2 (as the domain user, or global with a user-writable prefix)"
```

- [ ] **Step 2: Add `requires:` to `profiles/python.yml`**

```yaml
requires:
  - bin: python3
    min: "3.10"
    install: "Install Python 3.10+ for the domain user"
  - bin: pip3
    install: "python3 -m ensurepip / your OS python3-pip package"
  - bin: pm2
    install: "npm i -g pm2 (pm2 runs any long-lived process, incl. gunicorn/uvicorn)"
```

- [ ] **Step 3: Add `requires:` to `profiles/laravel.yml`**

```yaml
requires:
  - bin: php
    min: "8.2"
    install: "Install PHP 8.2+ CLI + FPM for the domain user's runtime"
  - bin: composer
    install: "Install Composer (getcomposer.org) on PATH"
  - bin: pm2
    install: "npm i -g pm2 (used to supervise the queue worker / octane, if any)"
```

- [ ] **Step 4: Add `requires:` to `profiles/_fallback.yml`** (conservative — unknown stack)

```yaml
requires:
  - bin: pm2
    install: "npm i -g pm2 (deploy-direct supervises the app under pm2)"
  # Unknown stack: the command MUST ask which runtime binary this app needs and
  # add it to the preflight before proceeding (invariant #6 — never assume).
```

- [ ] **Step 5: Validate all four parse and every `bin` is charset-safe**

Run:
```bash
cd /Volumes/SandeepSSD/www/tools/deploykit
python3 -c "
import yaml, re
ok = re.compile(r'^[a-zA-Z0-9._+-]{1,64}\$')
for f in ['nextjs','python','laravel','_fallback']:
    p = yaml.safe_load(open(f'profiles/{f}.yml'))
    reqs = p.get('requires')
    assert isinstance(reqs, list) and reqs, f'{f}: requires missing/empty'
    for r in reqs:
        assert ok.match(r['bin']), f'{f}: bad bin {r[\"bin\"]!r}'
        assert 'install' in r, f'{f}: {r[\"bin\"]} missing install hint'
    print(f'{f}: {len(reqs)} requires OK')
"
```
Expected: four lines, each `<stack>: N requires OK`.

- [ ] **Step 6: Commit**

```bash
git add profiles/nextjs.yml profiles/python.yml profiles/laravel.yml profiles/_fallback.yml
git commit -m "profiles: add requires: block driving the deploy-direct preflight"
```

---

### Task 2: read-only preflight verbs (`bin.which`, `bin.version`)

**Files:**
- Modify: `deploykit-mcp/src/config.ts` (add two entries to `VERB_ALLOWLIST`)
- Modify: `deploykit-mcp/scripts/smoke.mjs` (add assertions)
- Modify: `deploykit-mcp/dist/server.js` (rebuilt, not hand-edited)

**Interfaces:**
- Consumes: `VerbSpec` shape + `resolveTemplate` `{bin}`-from-params behavior (both in `config.ts`/`exec.ts`, unchanged).
- Produces: verbs `bin.which` and `bin.version`, callable via `domain_exec({session_id, verb, params:{bin}})`. `bin` param regex: `/^[a-zA-Z0-9._+-]{1,64}$/`.

- [ ] **Step 1: Write the failing tests** — add to `deploykit-mcp/scripts/smoke.mjs` after the existing `domain_exec` verb assertions (the block that tests `docker.compose.up`), reusing the existing domain session `d`:

```javascript
// --- deploy-direct: read-only preflight verbs ---
const which = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "bin.which", params: { bin: "node" } } });
assert("bin.which builds `command -v <bin>` argv", !which.isError && /command.*-v.*node/s.test(jsonOf(which)?.argv ?? ""), jsonOf(which)?.argv);

const ver = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "bin.version", params: { bin: "pm2" } } });
assert("bin.version builds `<bin> --version` argv", !ver.isError && /pm2.*--version/s.test(jsonOf(ver)?.argv ?? ""), jsonOf(ver)?.argv);

const badBin = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "bin.which", params: { bin: "node; rm -rf /" } } });
assert("bin.which REJECTS a non-binary-name param", badBin.isError === true && /failed validation/i.test(textOf(badBin)), textOf(badBin).slice(0, 140));
```

- [ ] **Step 2: Run smoke to verify the new assertions fail**

Run: `cd deploykit-mcp && npm run build && node scripts/smoke.mjs`
Expected: build passes; smoke reports failures on the three new assertions (verbs not allowlisted yet → `not allowlisted`).

- [ ] **Step 3: Add the two verbs to `VERB_ALLOWLIST`** in `deploykit-mcp/src/config.ts` (place with the other read-only/diagnostic verbs):

```typescript
  "bin.which": {
    description:
      "Read-only preflight: is a binary on the domain user's PATH? Used by deploy-direct " +
      "to check required packages; a non-zero exit means missing, which the caller reports.",
    remoteArgv: ["command", "-v", "{bin}"],
    params: { bin: /^[a-zA-Z0-9._+-]{1,64}$/ },
  },
  "bin.version": {
    description: "Read-only preflight: a binary's --version, for minimum-version checks.",
    remoteArgv: ["{bin}", "--version"],
    params: { bin: /^[a-zA-Z0-9._+-]{1,64}$/ },
  },
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `cd deploykit-mcp && npm run build && node scripts/smoke.mjs`
Expected: `N passed, 0 failed` (N = prior count + 3).

- [ ] **Step 5: Commit**

```bash
git add deploykit-mcp/src/config.ts deploykit-mcp/scripts/smoke.mjs deploykit-mcp/dist/server.js
git commit -m "verbs: add read-only bin.which/bin.version for deploy-direct preflight"
```

---

### Task 3: native pm2 run verbs

**Files:**
- Modify: `deploykit-mcp/src/config.ts` (add pm2 entries to `VERB_ALLOWLIST`)
- Modify: `deploykit-mcp/scripts/smoke.mjs` (add assertions)
- Modify: `deploykit-mcp/dist/server.js` (rebuilt)

**Interfaces:**
- Consumes: `resolveTemplate` `{app_dir}` (from session facts) + declared params.
- Produces: verbs `pm2.start.ecosystem`, `pm2.start.script`, `pm2.restart`, `pm2.reload`, `pm2.logs`, `pm2.status`, `pm2.save`. Param regexes: `ecosystem: /^ecosystem\.config\.(c?js|json)$/`, `script: /^[A-Za-z0-9._\/-]{1,128}$/`, `name: /^[A-Za-z0-9._-]{1,64}$/`, `lines: /^[0-9]{1,5}$/`.

- [ ] **Step 1: Write the failing tests** — add to `deploykit-mcp/scripts/smoke.mjs` (after Task 2's block):

```javascript
// --- deploy-direct: native pm2 run verbs (domain user) ---
const eco = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.start.ecosystem", params: { ecosystem: "ecosystem.config.cjs" } } });
assert("pm2.start.ecosystem builds `pm2 start <appdir>/ecosystem.config.cjs`", !eco.isError && /pm2.*start.*web18\/web\/ecosystem\.config\.cjs/s.test(jsonOf(eco)?.argv ?? ""), jsonOf(eco)?.argv);

const scr = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.start.script", params: { script: "server.js", name: "app" } } });
assert("pm2.start.script builds pm2 start with --name and --cwd", !scr.isError && /pm2.*start.*server\.js.*--name.*app.*--cwd/s.test(jsonOf(scr)?.argv ?? ""), jsonOf(scr)?.argv);

const restart = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.restart", params: { name: "app" } } });
assert("pm2.restart builds `pm2 restart <name>`", !restart.isError && /pm2.*restart.*app/s.test(jsonOf(restart)?.argv ?? ""), jsonOf(restart)?.argv);

const logs = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.logs", params: { name: "app", lines: "50" } } });
assert("pm2.logs is read-only (--nostream) with validated lines", !logs.isError && /pm2.*logs.*app.*--lines.*50.*--nostream/s.test(jsonOf(logs)?.argv ?? ""), jsonOf(logs)?.argv);

const status = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.status" } });
assert("pm2.status builds `pm2 jlist`", !status.isError && /pm2.*jlist/s.test(jsonOf(status)?.argv ?? ""), jsonOf(status)?.argv);

const badName = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.restart", params: { name: "app; reboot" } } });
assert("pm2.restart REJECTS a bad name param", badName.isError === true && /failed validation/i.test(textOf(badName)), textOf(badName).slice(0, 140));

const badEco = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.start.ecosystem", params: { ecosystem: "../../etc/passwd" } } });
assert("pm2.start.ecosystem REJECTS a non-ecosystem filename", badEco.isError === true && /failed validation/i.test(textOf(badEco)), textOf(badEco).slice(0, 140));
```

- [ ] **Step 2: Run smoke to verify the new assertions fail**

Run: `cd deploykit-mcp && npm run build && node scripts/smoke.mjs`
Expected: build passes; the seven new assertions fail (`not allowlisted`).

- [ ] **Step 3: Add the pm2 verbs to `VERB_ALLOWLIST`** in `deploykit-mcp/src/config.ts`:

```typescript
  "pm2.start.ecosystem": {
    description: "Start the app from its pm2 ecosystem file, as the domain user.",
    remoteArgv: ["pm2", "start", "{app_dir}/{ecosystem}"],
    params: { ecosystem: /^ecosystem\.config\.(c?js|json)$/ },
  },
  "pm2.start.script": {
    description:
      "Start the app from a script entrypoint under pm2, as the domain user. The start " +
      "script comes from the profile or an explicit ask (invariant #6), never invented.",
    remoteArgv: ["pm2", "start", "{app_dir}/{script}", "--name", "{name}", "--cwd", "{app_dir}"],
    params: { script: /^[A-Za-z0-9._\/-]{1,128}$/, name: /^[A-Za-z0-9._-]{1,64}$/ },
  },
  "pm2.restart": {
    description: "Restart a pm2-managed app by name (domain user).",
    remoteArgv: ["pm2", "restart", "{name}"],
    params: { name: /^[A-Za-z0-9._-]{1,64}$/ },
  },
  "pm2.reload": {
    description: "Zero-downtime reload of a pm2-managed app by name (domain user).",
    remoteArgv: ["pm2", "reload", "{name}"],
    params: { name: /^[A-Za-z0-9._-]{1,64}$/ },
  },
  "pm2.logs": {
    description: "Read-only: last N lines of a pm2 app's logs (no stream).",
    remoteArgv: ["pm2", "logs", "{name}", "--lines", "{lines}", "--nostream"],
    params: { name: /^[A-Za-z0-9._-]{1,64}$/, lines: /^[0-9]{1,5}$/ },
  },
  "pm2.status": {
    description: "Read-only: pm2 process list as JSON.",
    remoteArgv: ["pm2", "jlist"],
    params: {},
  },
  "pm2.save": {
    description:
      "Persist the pm2 process list so it survives a reboot (paired with a pm2 startup " +
      "unit the OPERATOR installs — that step needs root and is not the MCP's job).",
    remoteArgv: ["pm2", "save"],
    params: {},
  },
```

- [ ] **Step 4: Run smoke to verify it passes**

Run: `cd deploykit-mcp && npm run build && node scripts/smoke.mjs`
Expected: `N passed, 0 failed` (N = prior + 7).

- [ ] **Step 5: Update the tool-surface note** — if `smoke.mjs` asserts a fixed VERB count anywhere, update it. (Tool COUNT is unchanged — these are verbs under `domain_exec`, not new tools. Confirm the "tools/list exposes all 11 tools" assertion is untouched.)

Run: `grep -n "exposes all" deploykit-mcp/scripts/smoke.mjs` → expected: still `11`.

- [ ] **Step 6: Commit**

```bash
git add deploykit-mcp/src/config.ts deploykit-mcp/scripts/smoke.mjs deploykit-mcp/dist/server.js
git commit -m "verbs: add native pm2 run verbs for deploy-direct"
```

---

### Task 4: the `deploy-direct` command

**Files:**
- Create: `commands/deploy-direct.md`
- Test: inline frontmatter yaml validation

**Interfaces:**
- Consumes: `sshcon_resolve`/`target_resolve`, `analyze_repo`, `detect_env`, the profile `requires:` list (Task 1), the `bin.which`/`bin.version` verbs (Task 2), the `pm2.*` verbs (Task 3), `rsync.push`, `health_check`.
- Produces: the `/deploykit:deploy-direct` slash command (auto-discovered via the `./commands` dir — no manifest edit).

- [ ] **Step 1: Write the command doc** — create `commands/deploy-direct.md` with this exact content:

````markdown
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

## PHASE 4 — Local health gate (invariant #1)
Prove the app runs locally first (the same local gate bootstrap-deploy uses). If
the app has no local-runnable form, say so and ask before continuing — never ship
unproven code.

## PHASE 5 — Deliver
- `rsync.push` the working tree → APP_DIR (excludes .git/.env/*-data are built in).
- Write the server .env from the Phase 3 answers. If APP_DIR/.env already exists,
  back it up to .env.<timestamp>.bak first, add only missing keys, STOP on a
  conflict (never overwrite a value blindly). .env is server-side only.

## PHASE 6 — Run under pm2 (domain user)
- If the repo ships an ecosystem file: `domain_exec pm2.start.ecosystem {file}`.
- Else: use the start command from the profile or ASK me (invariant #6), then
  `domain_exec pm2.start.script {script} {name}`.
- `domain_exec pm2.save` so it survives a reboot (note: a pm2 startup unit needs
  root — if the app must auto-start on boot, tell me to run `pm2 startup` output).
- On a redeploy of an already-running app, use `pm2.reload`/`pm2.restart`.

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
````

- [ ] **Step 2: Validate the frontmatter parses**

Run:
```bash
cd /Volumes/SandeepSSD/www/tools/deploykit
python3 -c "import yaml; t=open('commands/deploy-direct.md').read(); e=t.find(chr(10)+'---',3); fm=yaml.safe_load(t[3:e]); print('keys:', sorted(fm)); assert set(fm)=={'allowed-tools','argument-hint','description'}"
```
Expected: `keys: ['allowed-tools', 'argument-hint', 'description']`.

- [ ] **Step 3: Commit**

```bash
git add commands/deploy-direct.md
git commit -m "commands: add /deploykit:deploy-direct (no-git native deploy)"
```

---

### Task 5: SKILL.md §9 (direct-deploy) + §6 entries

**Files:**
- Modify: `skills/deploy-engine/SKILL.md`
- Test: inline section-presence check

**Interfaces:**
- Consumes: nothing new; documents Tasks 1–4 for the shared engine.
- Produces: SKILL.md §9 (direct-deploy mode) + two §6 failure→fix entries.

- [ ] **Step 1: Add §9 to `skills/deploy-engine/SKILL.md`** (after §8):

```markdown
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
  `save`). Prefer the repo's ecosystem file; otherwise the start command comes
  from the profile or an explicit ask (invariant #6). A pm2 startup unit (boot
  persistence) needs root — that is the operator's step, reported not run.
DB details are SECRET → server `.env` only. Health gate and TLS behaviour are the
same as §5.
```

- [ ] **Step 2: Add two §6 failure→fix entries** — in `skills/deploy-engine/SKILL.md`, append to the §6 list:

```markdown
- **preflight reports a missing package** -> the server lacks a required binary.
  deploy-direct prints the install hint and STOPS; the operator installs it, then
  we re-check. The MCP never installs. (deploy-direct §9)
- **native app not on boot after reboot** -> `pm2 save` persists the list but boot
  start needs a pm2 startup unit (root). Report the `pm2 startup` command for the
  operator to run once; do not run it as root from the MCP.
```

- [ ] **Step 3: Validate the sections landed**

Run:
```bash
cd /Volumes/SandeepSSD/www/tools/deploykit
python3 -c "
t=open('skills/deploy-engine/SKILL.md').read()
assert '## 9. Direct-to-server mode' in t
assert 'preflight reports a missing package' in t
print('SKILL §9 + §6 entries present')
"
```
Expected: `SKILL §9 + §6 entries present`.

- [ ] **Step 4: Commit**

```bash
git add skills/deploy-engine/SKILL.md
git commit -m "SKILL: §9 direct-to-server mode + §6 preflight/boot entries"
```

---

### Task 6: end-to-end sanity + HELP + push

**Files:**
- Modify: `HELP.md` (document the new command + mode)
- Test: full build + smoke; a from-clean-tree run of the bundle

- [ ] **Step 1: Add `deploy-direct` to `HELP.md`** — under the commands section, add:

```markdown
### `/deploykit:deploy-direct` — no-git, direct-to-server native deploy

```
source=<github_url | local_path | .>   target_key=<sshcon_or_targets_name>
[proxy_port=<port>] [branch=indianic/main]
```

Delivers code over SSH and runs it natively under pm2 as the domain user — no
GitLab, no CI. A read-only preflight checks the server for required packages and,
if any are missing, prints exactly what to install and stops until you've done it.
The MCP never installs anything or runs as root.
```

- [ ] **Step 2: Full gate from a clean bundle**

Run:
```bash
cd /Volumes/SandeepSSD/www/tools/deploykit/deploykit-mcp
npm run build && node scripts/smoke.mjs
```
Expected: build clean; `N passed, 0 failed`.

- [ ] **Step 3: Confirm the bundle is self-contained (teammate-install proof)**

Run:
```bash
cd /Volumes/SandeepSSD/www/tools/deploykit
TREE=$(git stash create 2>/dev/null || echo HEAD)
# quick check: the shipped bundle runs with no node_modules reachable
D=$(mktemp -d); cp deploykit-mcp/dist/server.js "$D/"; ( cd "$D" && DEPLOYKIT_AUDIT_PATH="$D/a.jsonl" timeout 3 node server.js 2>&1 | head -1 )
```
Expected: `[deploykit-mcp] ready …` (server starts with no deps).

- [ ] **Step 4: Commit and push**

```bash
git add HELP.md
git commit -m "HELP: document /deploykit:deploy-direct and the no-git native mode"
git push origin main
```

- [ ] **Step 5: Final whole-branch review**

Dispatch superpowers:requesting-code-review over the deploy-direct commits (this
plan's range). Fix Critical/Important, re-gate, then the work is done.

---

## Self-Review (completed)

- **Spec coverage:** preflight gate → Tasks 1+2+4 Phase 2; native run → Task 3 + Task 4 Phase 6; `requires:` data → Task 1; command flow → Task 4; reused pieces → Task 4 Phases 0/3/4/5/7; NOT-in-scope (no provisioning) → enforced by using only read-only preflight verbs, documented in Task 5 §9. All spec sections mapped.
- **Placeholder scan:** none — every code/verb/test block is concrete.
- **Type consistency:** verb names and param-regex names are identical across Task 3's Interfaces, its code, and the smoke assertions; `{app_dir}` matches `resolveTemplate`'s existing token; `bin` regex identical in Task 2 code and tests.
- **Process-manager scope:** pm2 only (systemd-user is an explicit follow-up), consistent across Tasks 3/4/5.
