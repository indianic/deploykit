# Changelog

All notable changes to deploykit. This project follows [semantic versioning](https://semver.org/).

## v1.2.0 — 2026‑08‑06

Reach servers whose SSH key lives in a managed key store (not as a file on disk), and a
generic in‑session fallback for any host. 16 tools, 155‑assertion smoke suite.

- **Store‑managed keys.** An sshcon target with `Auth Type: key` and no key path
  is no longer misread as “auth missing.” The key is exported for the session via
  `sshcon ssh-key <name> --write` (needs **sshcon ≥ 2.13.0**), used, and deleted on
  session expiry. Handles report `auth_method: "sshcon-managed"`; no credential ever
  crosses the tool boundary. Gate is configurable via `DEPLOYKIT_SSHCON_MIN`.
- **`ssh_resolve`** — resolve a host from inline details (works with **or without**
  sshcon): `host`/`user` + a `key_path`, an env‑var name (`key_env`/`password_env`),
  or a password. Lets an operator grant this machine SSH access in‑session.
- Older sshcon fails **closed** with an upgrade hint that points at `ssh_resolve`.

## v1.1.0 — 2026‑08‑06

Hardening from a real self‑hosted LobeHub deploy (auth was the #1 gap). The MCP
boundary is now a fully working, tested server (15 tools, 131‑assertion smoke suite).

- **Auth is key‑first, then password.** Reachable on key‑only servers; the password
  path no longer suppresses its own prompt. Reuse a base64 `SERVER_ACCESS` deploy key
  via `deploy_key_env`.
- **`ssh_auth_preflight`** — report which SSH auth methods a host offers, no credential.
- **`host_preflight`** — read‑only CPU x86‑64‑v2 / RAM+swap / disk‑quota / Docker report.
- **`grant_docker_access`** installs Docker CE if the box has none; tolerates the
  ISPConfig uid‑remap `systemctl --user` failure.
- **Hot‑reload** the sshcon key allowlist without restart (`reload_config`).
- **`detect_env` deep‑scan** — finds env keys in nested compose subdirs, not just root.
- **`lobehub` profile** + detection (Postgres+pgvector, fresh JWKS key, RustFS fix).
- **`lint_yaml`** — catches the plain‑scalar `": "` colon‑trap in generated YAML.
- **Self‑hosted GitLab** — `pipeline_*` accept a `repo` ref so `glab` targets the
  right instance instead of defaulting to gitlab.com.
- Root script now delivered by `scp` (never `bash -s` over stdin under sshpass).
- SKILL.md, HELP.md, and `knowledge/learnings.yml` updated with the new lessons.

## v1.0.x — earlier

- **deploy-direct mode** — SSH‑native, no‑CI deploy under pm2 with a read‑only preflight.
- **Root‑optional path** — `emit_root_runbook` + hardened root script + diagnostic verbs.
- **`/deploykit:retro`** + `knowledge/learnings.yml` — memory across deploys.
- **`target_resolve`** — named SSH targets for hosts not in sshcon.
- **Profiles** — `laravel`, `nextjs`, `python`, `_fallback`.
- **Hardened** `health_check` (2xx+3xx), `detect_env`, `analyze_repo`.
- **bootstrap-deploy** — local source support, shallow‑push guard, CI var reuse +
  environment scoping, `.env` backup, SSL preflight.
- **Initial release** — the profile‑driven bootstrap‑deploy pipeline and the
  privileged MCP boundary (sshcon, one‑time root grant, allowlisted domain execution).
