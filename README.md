# 🚀 deploykit

### Put any project online by describing it to Claude — in plain English.

**deploykit** turns _"here's my code, please make it live"_ into a guided, safe,
repeatable deployment. You point it at a project (a GitHub link, a folder on your
computer, or a server you can SSH into), answer a few plain questions it asks you,
and it hands you back a working **`https://your-site`** URL.

It runs inside **Claude Code** as a plugin. You don't write scripts, you don't SSH
by hand, you don't copy‑paste secrets into chat. Claude does the work; deploykit is
the rulebook and the safety rails that keep every deploy correct.

> **Before deploykit:** clone, read the README, guess the build, hand‑edit CI YAML,
> SSH as root, install Docker, wire the reverse proxy, paste passwords around, hope.
>
> **With deploykit:** one command → it inspects the project, asks only what it truly
> needs, proves the build works **on your machine first**, deploys, and returns the URL.

---

## Table of contents

1. [Is this for me?](#1-is-this-for-me)
2. [The big picture (what it actually does)](#2-the-big-picture)
3. [What you'll need](#3-what-youll-need)
4. [Install (step by step, for first‑timers)](#4-install-step-by-step)
5. [The three ways to deploy](#5-the-three-ways-to-deploy) — GitHub · local folder · no‑Git/direct
6. [Command cheat‑sheet](#6-command-cheat-sheet)
7. [What happens when you run it](#7-what-happens-when-you-run-it)
8. [Safety model, in plain English](#8-safety-model-in-plain-english)
9. [Under the hood: the MCP tools](#9-under-the-hood-the-mcp-tools)
10. [Supported stacks (profiles)](#10-supported-stacks-profiles)
11. [Troubleshooting](#11-troubleshooting)
12. [FAQ](#12-faq)
13. [Repo layout](#13-repo-layout)
14. [License](#14-license)
15. [Built by IndiaNIC](#15-built-by-indianic)

---

## 1. Is this for me?

**Yes, if** you have a web project and access to IndiaNIC's hosting (or any
Ubuntu + ISPConfig server) and you want it deployed **without becoming a DevOps
expert**. You can be a developer, a project manager, or a first‑time deployer —
if you can type a sentence into Claude, you can deploy.

deploykit is built for **IndiaNIC's self‑hosted stack**: **GitLab CI + ISPConfig +
rootless Docker**. If that's your world, this is your one‑command deploy button.

**Two mental models it supports:**

- **Full pipeline** — your code lives in GitLab, every push builds and deploys
  through CI. Best for team projects and repeatable releases.
- **Direct‑to‑server** — no Git, no CI: deploykit copies your code onto a server
  over SSH and runs it there. Best for quick, standalone apps.

You pick; deploykit handles the rest.

---

## 2. The big picture

**The vision:** deploying should be a _conversation_, not a checklist. You should
be able to say *"deploy this,"* answer a couple of questions a smart colleague would
ask, and get a live URL — with none of the footguns (leaked secrets, root shells,
"works on my machine," clobbered data) that make deployment scary.

deploykit delivers that by splitting the job in two:

- **The brain (Claude + the deploy‑engine skill).** Claude reads your project,
  figures out the stack, drafts the config, asks you the minimum set of questions,
  and follows a strict rulebook of safety invariants and a "failure → fix" playbook
  built from real deploys.
- **The hands (the deploykit MCP server).** Everything that touches **credentials
  or root** goes through a small, audited, typed tool boundary. Claude never holds
  your password, never gets a root shell, and can only run a fixed, reviewed set of
  operations. Secrets are read on the server side and **never enter the chat**.

The result is a deploy that is **safe by construction**, **repeatable**, and
**explains itself** as it goes. Stack knowledge lives in tiny `profiles/*.yml`
data files — so supporting a new framework means adding a profile, not rewriting
the engine.

---

## 3. What you'll need

Think of this as the "before you start" shopping list. If you're non‑technical,
your DevOps teammate can confirm most of these in a minute.

**On your computer (where Claude Code runs):**

| Tool | What it's for | Check it's there |
|---|---|---|
| **Claude Code** | Runs deploykit | Open the app / run `claude` |
| **Node.js** (v20+) | Runs the deploykit MCP server | `node --version` |
| **git** | Version control | `git --version` |
| **Docker** + Compose v2 | Builds/runs your app locally to prove it works | `docker compose version` |
| **rsync, curl, openssl** | Copy files, health‑check, generate secrets | `rsync --version` |
| **`glab`** | GitLab CLI (for the full‑pipeline mode) | `glab auth status` |
| **`sshcon`** | IndiaNIC internal tool that safely looks up server logins | ask your DevOps team |

**On the target server** (usually already done for you by IndiaNIC hosting):

- The **domain user** and its web folder exist (created by ISPConfig).
- Apache/nginx already proxies the domain to `127.0.0.1:<port>`.
- **Root** is reachable (used **once**, to install rootless Docker for that user).

> New to this? Ask your DevOps team: *"What's the sshcon key for my domain, the
> server/root key, and the proxy port?"* Those three answers are all deploykit needs.

---

## 4. Install (step by step)

deploykit is a **Claude Code plugin**, distributed as a one‑plugin marketplace.
You install it once; it loads automatically every session after that.

**Step 1 — Open Claude Code** (terminal, desktop app, or IDE extension).

**Step 2 — Add the marketplace** (type this in the Claude prompt):

```
/plugin marketplace add indianic/deploykit
```

**Step 3 — Install the plugin:**

```
/plugin install deploykit@indianic-deploy
```

> `deploykit` is the plugin name; `indianic-deploy` is the **marketplace** name.
> The format is always `<plugin>@<marketplace>`.

**Step 4 — Start a fresh session.** The bundled MCP server loads at session start.
Confirm it's live:

```
/mcp
```

You should see **deploykit** listed with **15 tools**. That's it — nothing to build,
no repo to clone. (The MCP ships prebuilt; you only need Node installed to run it.)

**To update later:**

```
/plugin marketplace update indianic-deploy
```

**To pin a specific version or branch:**

```
/plugin marketplace add indianic/deploykit#v1.2.0
```

---

## 5. The three ways to deploy

Every deploy is **one command** you type to Claude. Pick the scenario that matches
you. Replace the `UPPERCASE` bits with your own values (your DevOps team can give
you the keys/ports).

### 🅐 Deploy a GitHub project (full pipeline)

You have a project on GitHub and want it deployed through GitLab CI so every future
push redeploys automatically.

```
/deploykit:bootstrap-deploy \
  source=https://github.com/OWNER/PROJECT \
  gitlab=https://gitlab.example.com/GROUP/DEPLOY_REPO \
  domain_key=DOMAIN_KEY \
  server_key=SERVER_KEY \
  proxy_port=PROXY_PORT
```

| You provide | Means |
|---|---|
| `source` | The GitHub project to deploy |
| `gitlab` | Your GitLab deploy repo (the one with your CI variables) |
| `domain_key` | `sshcon` key for the **domain user** (where the app runs) |
| `server_key` | `sshcon` key for **root** (one‑time Docker setup only) |
| `proxy_port` | The host port your site's Apache/nginx vhost proxies to |
| `branch` | *(optional)* working branch, default `indianic/main` |

deploykit will **pause and ask you** which database and which optional integrations
(email, storage, OAuth, AI keys…) to turn on, and for any required secrets — before
it writes or deploys anything. On success it prints just: `https://your-domain`.

### 🅑 Deploy a project from your own computer

Same as above, but the source is a **folder on your machine** (or the current
directory). Use this when the code isn't on GitHub yet, or you have local changes.

```
/deploykit:bootstrap-deploy \
  source=. \
  gitlab=https://gitlab.example.com/GROUP/DEPLOY_REPO \
  domain_key=DOMAIN_KEY \
  server_key=SERVER_KEY \
  proxy_port=PROXY_PORT
```

- `source=.` means *"deploy the folder I'm in right now."*
- `source=/path/to/project` works too.

This still uses the GitLab pipeline (so you get automatic redeploys later). If you
want **no pipeline at all**, use option 🅒.

### 🅒 Deploy without Git — straight onto a server

No GitLab, no CI, no pipeline. deploykit copies your code onto a server over SSH and
runs it **natively** (under `pm2`, as the domain user). Perfect for a quick,
standalone app.

```
/deploykit:deploy-direct \
  source=. \
  target_key=TARGET_KEY \
  proxy_port=PROXY_PORT
```

| You provide | Means |
|---|---|
| `source` | A GitHub URL, a local path, or `.` (the current folder) |
| `target_key` | An `sshcon` domain key **or** a name in `~/.deploykit/targets.json` |
| `proxy_port` | *(optional)* the port the app listens on / the vhost proxies to |

deploykit runs a **read‑only preflight** first: if the server is missing something
(Node, pm2, …), it tells you **exactly what to install**, stops, and continues once
you've done it. **It never installs anything or runs as root itself.**

> **Servers not in sshcon?** Put their login in `~/.deploykit/targets.json` (a
> private, `chmod 600` file the plugin reads server‑side) and reference it by name
> as `target_key`. Credentials there never appear in the chat. It supports SSH keys,
> passwords, or both (key is tried first).

### 🔁 Keep it up to date & redeploy

```
/deploykit:sync-upstream                 # pull the latest from GitHub, keep your changes, redeploy
/deploykit:sync-upstream --dry-run       # just preview what would change

/deploykit:redeploy                      # rebuild + restart the current branch (env preserved)
/deploykit:redeploy --restart-only       # just bounce the app (fastest)
/deploykit:redeploy --rollback           # redeploy the previous commit
```

---

## 6. Command cheat‑sheet

| Command | Use it when… |
|---|---|
| `/deploykit:bootstrap-deploy` | First deploy of a project **through the GitLab pipeline** (GitHub or local source). |
| `/deploykit:deploy-direct` | Deploy **straight to a server over SSH, no Git/CI** (runs under pm2). |
| `/deploykit:sync-upstream` | Pull the latest from the GitHub upstream, keep your changes, and redeploy. |
| `/deploykit:redeploy` | Rebuild / restart / roll back the current deploy (no source change). |
| `/deploykit:retro` | After a session, capture new lessons so the next deploy starts smarter. |

Tip: you can also just **describe what you want** — "deploy this repo to web-host on
port 50034" — and Claude will pick the right command and confirm the details with you.

---

## 7. What happens when you run it

You stay in control the whole time; deploykit narrates each step and **stops for your
input** before anything irreversible.

1. **Look up the server** — resolves the domain (and root) login **without ever
   showing you or storing the password**, and confirms the proxy target.
2. **Read the project** — detects the stack, the build strategy, the port, and every
   environment variable it needs → loads the matching profile.
3. **Ask you** — one short questionnaire: confirm the auto‑derived values, choose a
   database, toggle optional integrations, provide any required secrets. _It pauses here._
4. **Prove it locally** — builds and health‑checks your app **on your machine first**.
   If it fails here, it fails on your laptop, not in production. (This is a hard gate.)
5. **Wire up CI** (pipeline mode) — writes the deploy config, reusing your existing
   GitLab variables.
6. **One‑time root** — installs rootless Docker for the domain user (the _only_ root
   step) and writes the server‑side `.env` once.
7. **Deploy & watch** — pushes, follows the pipeline, and auto‑fixes known failures.
8. **Verify** — health‑checks the live site, then returns just `https://your-domain`.

For direct mode (🅒), steps 5–7 become "copy code over SSH → start under pm2."

---

## 8. Safety model, in plain English

These rules are enforced **in code**, not by good intentions:

1. **It works on your machine before it touches the server.** No deploy skips the
   local health check.
2. **Your app never runs as root.** Everything runs as the domain user via rootless
   Docker (or pm2). Root is used exactly **once**, to set up rootless Docker.
3. **Secrets never enter Git or the chat.** Your `.env` lives only on the server; the
   plugin reads credentials server‑side and hands Claude a _handle_, never the value.
4. **Your data survives deploys.** Databases and uploaded files are preserved; a
   redeploy or rollback restores **code only**.
5. **On success, you get just the URL** — no noise, and never a fake `https://`
   before a real certificate exists.
6. **It asks instead of guessing** the things that matter (port, health path, build
   strategy) for any stack it doesn't recognize.

Every privileged action is written to an **append‑only audit log** with secrets
scrubbed. Full detail: [`skills/deploy-engine/SKILL.md`](skills/deploy-engine/SKILL.md).

---

## 9. Under the hood: the MCP tools

Everything credential‑ or root‑related is a typed call to the **deploykit MCP
server** — a small, audited boundary. Claude drives these; you never do directly.

| Tool | Purpose |
|---|---|
| `sshcon_resolve` | Resolve an sshcon target → session handle + non‑secret facts (key‑first auth; `deploy_key_env` for key‑only hosts) |
| `target_resolve` | Same, for hosts in `~/.deploykit/targets.json` (key + password fallback; `keyB64`/`keyEnv`) |
| `ssh_auth_preflight` | Report which SSH auth methods a host offers (key‑only / password / both) — no credential used |
| `reload_config` | Re‑read the sshcon key allowlist without restarting |
| `grant_docker_access` | The **one** root op: install rootless Docker (installs Docker CE if absent; handles ISPConfig quirks) |
| `emit_root_runbook` | Generate a root runbook for a server team to run (executes nothing) |
| `host_preflight` | Read‑only capability report: CPU x86‑64‑v2, RAM/swap, disk quota, Docker |
| `domain_exec` | Run one allowlisted verb as the domain user (fixed argv, no shell) |
| `analyze_repo` | Detect stack, Dockerfile/compose, candidate ports |
| `detect_env` | Deep‑scan + classify env keys (never values) |
| `lint_yaml` | Catch the plain‑scalar `": "` colon‑trap (and tabs) in generated YAML |
| `pipeline_run` / `pipeline_status` / `pipeline_trace` | Wrap `glab ci …` (self‑hosted `repo` ref) |
| `health_check` | HTTP health check; 2xx **and** 3xx count as healthy |

---

## 10. Supported stacks (profiles)

Stack knowledge lives in `profiles/*.yml` — small data files, no engine changes.

| Profile | For |
|---|---|
| `laravel` | Laravel / PHP (artisan + composer) |
| `nextjs` | Next.js apps |
| `lobehub` | Self‑hosted LobeHub (Postgres+pgvector, fresh JWKS key, RustFS) |
| `python` | Conservative Python stack |
| `_fallback` | Anything unrecognized — asks you the four essentials instead of guessing |

**Add a stack:** copy `profiles/nextjs.yml`, adjust `internal_port`,
`healthcheck_path`, `build_strategy`, `compose_service`, and the `env_classify`
rules. No code changes.

---

## 11. Troubleshooting

deploykit already knows these and will usually fix or warn automatically — but here's
the human‑readable version:

| Symptom | What it means / the fix |
|---|---|
| `Permission denied (publickey,password)` | Host is key‑only or password auth mis‑ran. deploykit is key‑first; for a key‑only root host, use `deploy_key_env` (your base64 `SERVER_ACCESS` key). |
| Build fails deep in `sharp` / `SIGILL` | Build host CPU is too old (needs x86‑64‑v2). Build on a newer host and push, or on Apple Silicon use `colima --vz-rosetta`. |
| `disk quota exceeded` mid‑deploy | ISPConfig's default 2 GB quota is full (rootless images live under the user's home). Raise it in the ISPConfig panel. |
| Build gets OOM‑killed | Not enough RAM (some builds peak ~8 GB). Add swap or build on a bigger host. `host_preflight` warns about this up front. |
| `apt-get install docker-ce-rootless-extras` 404s | No Docker + no Docker apt repo. `grant_docker_access` now installs Docker CE first. |
| Health check is red but the app is fine | An auth‑gated app answers `/` with a 30x redirect — that's healthy. deploykit accepts 3xx. |
| `glab` 404 on a self‑hosted project | A bare `owner/repo` defaults to gitlab.com. Pass the full URL / `host/group/project`. |

Full "failure → fix" playbook: [`skills/deploy-engine/SKILL.md`](skills/deploy-engine/SKILL.md) §6.

---

## 12. FAQ

**Do I need to know Docker/CI/SSH?** No. deploykit does that. You provide a few keys
and answer its questions.

**Will it see my passwords?** No. Credentials are resolved and used **server‑side**;
Claude only ever gets a non‑secret handle. Nothing sensitive enters the chat or Git.

**Can it break my production data?** Deploys restore **code only** — databases and
uploaded files are preserved and excluded from the sync.

**What if my stack isn't listed?** The `_fallback` profile kicks in and asks you the
four essentials (port, health path, build strategy, service name) rather than guessing.

**GitHub vs local vs no‑Git — which do I pick?** GitHub/local → `bootstrap-deploy`
(full pipeline, auto‑redeploys). No pipeline / quick app → `deploy-direct`.

**How do I update the plugin?** `/plugin marketplace update indianic-deploy`.

---

## 13. Repo layout

```
deploykit/
├── .claude-plugin/
│   ├── plugin.json          # plugin manifest
│   ├── mcp.json             # launches the MCP server (dist/server.js)
│   └── marketplace.json     # one‑plugin marketplace catalog
├── commands/                # the slash commands
│   ├── bootstrap-deploy.md  # first deploy through the pipeline (GitHub or local)
│   ├── deploy-direct.md     # no‑Git, direct‑to‑server native deploy (pm2)
│   ├── sync-upstream.md     # GitHub → your changes → redeploy
│   ├── redeploy.md          # rebuild / restart / rollback
│   └── retro.md             # capture lessons after a session
├── skills/
│   └── deploy-engine/SKILL.md   # shared invariants, sshcon contract, env algo, fix map
├── profiles/                # stack knowledge (data, not code)
│   ├── laravel.yml  nextjs.yml  lobehub.yml  python.yml  _fallback.yml
├── knowledge/
│   └── learnings.yml        # append‑only memory of solved problems, loaded each deploy
├── deploykit-mcp/           # the privileged MCP server (TypeScript → prebuilt dist/)
│   ├── src/                 # exec, sessions, config, audit, tools/
│   ├── dist/server.js       # shipped bundle (what mcp.json runs)
│   └── scripts/smoke.mjs    # self‑contained security + behavior test suite
├── HELP.md                  # quick reference
├── CHANGELOG.md             # version history
└── README.md                # you are here
```

---

## 14. License

MIT — see [`LICENSE`](LICENSE). Use it, fork it, adapt it to your own stack.

Version history lives in [`CHANGELOG.md`](CHANGELOG.md).

---

## 15. Built by IndiaNIC

deploykit is built and maintained by [IndiaNIC](https://www.indianic.com) and given
away under MIT. The parts that make it worth running — the stack profiles, the
failure‑to‑fix playbook in `knowledge/learnings.yml`, the invariants that refuse to
touch a server before a build proves itself locally — were all earned on real client
deploys, and the whole thing is here rather than a trimmed‑down sample of it.

That work is also what we do commercially: MCP servers and AI agents shaped around
how a team already operates, plus the unglamorous integration work that decides
whether they hold up in production instead of ending as a persuasive pilot.

If you have a workflow that deserves automating, we would like to hear about it.

**[Talk to us →](https://www.indianic.com)** · www.indianic.com
