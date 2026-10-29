/**
 * The privileged boundary: sshcon_resolve, grant_docker_access, domain_exec.
 *
 * Each of the three enforces a different invariant, in code:
 *   sshcon_resolve      -> returns a handle, never credentials
 *   grant_docker_access -> root-kind session only; ONE fixed script; no fallback
 *   domain_exec         -> closed verb allowlist; fixed argv; no shell interp
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertKeyAllowed,
  assertParamsValid,
  assertVerbAllowed,
  configFilePath,
  currentSshconKeyAllowlist,
  AllowlistError,
  VERB_ALLOWLIST,
  type Config,
} from "../config.js";
import { SessionStore, type SessionFacts, type SessionSecret } from "../sessions.js";
import { resolveTarget, TargetError } from "../targets.js";
import type { AuditLog } from "../audit.js";
import {
  buildRsyncArgv,
  buildSshArgv,
  run,
  runSshWithAuth,
  scpFile,
  shellQuote,
  probeAuthMethods,
  sshconList,
  sshconVersion,
  semverGte,
  materializeSshconKey,
  ExecError,
  type ExecResult,
  type SshCredentials,
} from "../exec.js";
import { decodeKeyFromEnv, ENV_NAME } from "../keys.js";

/** Extract the auth-executor's credential view from a stored secret bundle. */
function credsOf(secret: Readonly<SessionSecret>): SshCredentials {
  const c: SshCredentials = {};
  if (secret.keyPath) c.keyPath = secret.keyPath;
  if (secret.password) c.password = secret.password;
  return c;
}

/** Domain usernames are tightly constrained; this value reaches a root script. */
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;

// Inline ssh_resolve inputs. All reach argv as discrete elements (never a shell
// string), so these are hygiene, not a security boundary — but a tight charset
// keeps a malformed host/user from producing a confusing ssh invocation.
const SSH_HOST = /^[A-Za-z0-9._-]{1,255}$/; // hostname or IPv4 (IPv6 literals unsupported here)
const SSH_USER = /^[A-Za-z0-9._-]{1,64}$/; // ssh login user (root, web108, …)
const ABS_PATH = /^\/[A-Za-z0-9._/-]{1,255}$/; // app_dir: absolute, no spaces/metachars
const SAFE_PATH = /^[^\0]{1,512}$/; // key_path on THIS machine; existence-checked below

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * The ONE privileged script. Hardcoded and idempotent (SKILL.md §4).
 *
 * It is a literal constant: the only variable part is the domain username,
 * which is regex-validated and passed as a positional ARGUMENT to bash, not
 * interpolated into the script text. There is no code path that runs any other
 * command as root, and no fallback to root-mode Docker on failure (invariant #2).
 *
 * NOTE ON `${...}`: this is a String.raw template but JS still interpolates
 * `${expr}`. Every shell variable below is written `$var` (no braces) on
 * purpose; `${var}` would be eaten by JS, not bash. Keep it that way.
 *
 * The four hardenings (a-d) below track REAL ISPConfig failures; the human
 * runbook in ROOTLESS_DOCKER_RUNBOOK mirrors each one step-for-step.
 */
const ROOTLESS_DOCKER_SCRIPT = String.raw`
set -euo pipefail
u="$1"

# Guard: ISPConfig owns the user. We never create it.
if ! id "$u" >/dev/null 2>&1; then
  echo "FATAL: domain user $u does not exist; ISPConfig must create it" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive

# (C.1) NO DOCKER + NO DOCKER APT REPO. A fresh box may have neither Docker nor
# the Docker apt repo, so 'apt-get install docker-ce-rootless-extras' 404s and
# the whole setup aborts. Install Docker CE via the official convenience script
# FIRST when absent — it adds the repo and pulls docker-ce, the compose plugin,
# AND docker-ce-rootless-extras. Guarded by presence so re-runs are no-ops. We
# never touch the rootful daemon's state beyond what get.docker.com does; the
# app only ever uses the per-user rootless daemon (invariant #2).
if ! command -v dockerd >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
  echo "DOCKER_CE_INSTALLED syshost=$(hostname)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/deploykit-get-docker.sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO /tmp/deploykit-get-docker.sh https://get.docker.com
  else
    echo "FATAL: Docker is absent and neither curl nor wget is present to install it" >&2
    exit 4
  fi
  sh /tmp/deploykit-get-docker.sh >/dev/null
  rm -f /tmp/deploykit-get-docker.sh
fi

# Rootless prerequisites + compose plugin. Idempotent no-op when present; the
# repo now exists (either it did, or get.docker.com added it).
apt-get install -y uidmap dbus-user-session docker-ce-rootless-extras docker-compose-plugin >/dev/null 2>&1 \
  || apt-get install -y uidmap dbus-user-session >/dev/null

# The rootless setuptool ships in docker-ce-rootless-extras. If it is still not
# on PATH after the install above, stop with a clear message rather than failing
# deep inside the install branch.
if ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
  echo "FATAL: dockerd-rootless-setuptool.sh not found after install (docker-ce-rootless-extras missing)" >&2
  exit 4
fi

uid="$(id -u "$u")"
runtime="/run/user/$uid"

# (b) UID -> DIFFERENT USERNAME. ISPConfig can map one uid to two passwd
# entries (e.g. uid 5017 -> web19 for systemd, op_webapp for the shell).
# systemd's user manager keys off the FIRST passwd entry, so a unit written to
# any other home is invisible. Resolve the name + home systemd will actually use
# and act on THAT home. shellhome is where 'su - $u' lands.
sysname="$(id -un "$uid")"
syshome="$(getent passwd "$sysname" | cut -d: -f6)"
shellhome="$(getent passwd "$u" | cut -d: -f6)"
if [ -z "$syshome" ]; then syshome="$shellhome"; fi
# A passwd entry with an empty home would make every path below "/.config" etc.
# — refuse rather than operate on the filesystem root.
if [ -z "$syshome" ]; then echo "FATAL: no home dir resolved for $u" >&2; exit 2; fi
if [ "$sysname" != "$u" ]; then
  echo "UID_REMAPPED sysname=$sysname shell_user=$u syshome=$syshome"
fi

unit_dir="$syshome/.config/systemd/user"
override_dir="$unit_dir/docker.service.d"
data_home="$syshome/.local/share"

# (a) IMMUTABLE HOME. ISPConfig web roots are frequently 'chattr +i', so even
# root cannot create ~/.config/systemd/user ("Operation not permitted") and
# rootless-setuptool dies "HOME needs to be writable". Detect the flag, clear it
# only long enough to create the writable subtrees, and ALWAYS restore it. A
# trap guarantees +i is put back on EVERY exit path — we never leave it cleared.
immutable=0
if lsattr -d "$syshome" 2>/dev/null | awk '{print $1}' | grep -q 'i'; then
  immutable=1
fi
restore_immutable() { if [ "$immutable" = 1 ]; then chattr +i "$syshome" 2>/dev/null || true; fi; }
if [ "$immutable" = 1 ]; then
  echo "IMMUTABLE_HOME_HANDLED syshome=$syshome"
  # Trap the fatal signals too, not just EXIT: run()'s timeout SIGKILLs the local
  # ssh client, which SIGHUPs this remote bash — and bash does NOT run an EXIT
  # trap on an untrapped signal. Without HUP/INT/TERM/PIPE here, a timeout in the
  # window before the restore below would leave the web root mutable, silently.
  trap restore_immutable EXIT HUP INT TERM PIPE
  chattr -i "$syshome"
fi

# Create every dir systemd + dockerd need while the home is writable, owned by
# the domain user. Idempotent: mkdir -p / chown are no-ops on re-runs.
mkdir -p "$unit_dir" "$override_dir" "$data_home"
chown "$uid:$uid" "$syshome/.config" "$syshome/.config/systemd" "$unit_dir" "$override_dir" "$syshome/.local" "$data_home" 2>/dev/null || true

# Restore +i now that the writable subtrees exist (they are separate inodes, so
# dockerd can still write inside them under an immutable top-level home). The
# trap remains a backstop should anything above have exited early.
if [ "$immutable" = 1 ]; then
  chattr +i "$syshome"
  trap - EXIT HUP INT TERM PIPE
fi

# Idempotent: enabling linger twice is a no-op. Linger keeps the user manager
# (and its D-Bus) alive with no login session — required for 'systemctl --user'.
loginctl enable-linger "$u"

# (c) NO SESSION BUS under su/sudo -i. 'systemctl --user' needs a per-user
# D-Bus at /run/user/$uid/bus. Verify it exists FIRST and remediate LOUDLY
# rather than dying with an opaque "Failed to connect to bus".
if [ ! -S "$runtime/bus" ]; then
  echo "FATAL: $runtime/bus (per-user D-Bus) is missing." >&2
  echo "Remediate: 'loginctl enable-linger $u' then 'systemctl start user@$uid.service'," >&2
  echo "wait for $runtime/bus to appear, and re-run this script. We do NOT fall back to root Docker." >&2
  exit 3
fi
userbus="XDG_RUNTIME_DIR=$runtime DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime/bus"

# Guard: re-runs must not reinstall over a healthy daemon.
if su - "$u" -c "DOCKER_HOST=unix://$runtime/docker.sock docker version --format '{{.Server.Version}}'" >/dev/null 2>&1; then
  echo "ALREADY_INSTALLED"
else
  # (C.3) The setuptool ends by running 'systemctl --user enable --now docker'
  # ITSELF. In the uid-remap dual-home case that unit lands in the wrong home and
  # the user manager can't find it, so the setuptool exits non-zero — but it has
  # already installed the rootless binaries and written the unit. That failure is
  # EXPECTED: swallow it (don't let pipefail abort) and finish via the unit
  # relocation + our own enable below, which target the systemd-resolved home.
  if ! su - "$u" -c "$userbus dockerd-rootless-setuptool.sh install --force"; then
    echo "SETUPTOOL_NONZERO (expected under uid-remap; continuing via unit relocation)"
  fi
fi

# (b) setuptool writes docker.service into the SHELL user's home; if systemd
# uses a DIFFERENT home (uid remap), copy the unit into the systemd-resolved
# home so 'systemctl --user' can actually find it. Idempotent (cp -f).
if [ "$syshome" != "$shellhome" ] && [ -f "$shellhome/.config/systemd/user/docker.service" ]; then
  cp -f "$shellhome/.config/systemd/user/docker.service" "$unit_dir/docker.service"
  chown "$uid:$uid" "$unit_dir/docker.service"
fi

# (b) Pin HOME + XDG dirs in an override so dockerd's data-root lands in a
# WRITABLE home. Idempotent: the same drop-in is rewritten verbatim each run.
cat > "$override_dir/10-deploykit.conf" <<CONF
[Service]
Environment=HOME=$syshome
Environment=XDG_CONFIG_HOME=$syshome/.config
Environment=XDG_DATA_HOME=$data_home
Environment=XDG_RUNTIME_DIR=$runtime
CONF
chown "$uid:$uid" "$override_dir/10-deploykit.conf"

su - "$u" -c "$userbus systemctl --user daemon-reload"
su - "$u" -c "$userbus systemctl --user enable --now docker"

# Idempotent: only append the export if it is not already there.
su - "$u" -c "grep -q 'DOCKER_HOST=unix:///run/user/' ~/.bashrc || echo 'export DOCKER_HOST=unix:///run/user/'\$(id -u)'/docker.sock' >> ~/.bashrc"

# Verify AS THE DOMAIN USER. If this fails we stop; we never fall back to root docker.
su - "$u" -c "DOCKER_HOST=unix://$runtime/docker.sock docker version --format '{{.Server.Version}}'"
`;

/**
 * The HUMAN runbook: same operations as ROOTLESS_DOCKER_SCRIPT, but written to
 * be READ and run by a server team that holds root when the operator does not.
 *
 * This is a pure TEXT constant. emit_root_runbook returns it verbatim and runs
 * NOTHING (no run(), no spawn, no ssh) — invariant #3: the one thing that runs
 * as root is grant_docker_access, never this. Every step is guarded/idempotent,
 * echoes what it did, is annotated so a sysadmin can audit it, and it ends with
 * ONE DEPLOYKIT_VERIFY line the operator pastes back.
 *
 * The domain user is the POSITIONAL argument "$1"; it is NEVER interpolated into
 * the body (the value only appears in the human invocation line of the cover
 * note). Same '$var not ${var}' rule as above (String.raw + JS interpolation).
 */
const ROOTLESS_DOCKER_RUNBOOK = String.raw`#!/usr/bin/env bash
#
# deploykit rootless-Docker runbook — RUN AS ROOT on the target server.
# Usage:  sudo bash deploykit-rootless-docker.sh <DOMAIN_USER>
# This is auditable: every step is guarded, idempotent, and echoes what it did.
# It installs rootless Docker for ONE existing domain user. It never creates the
# user, never touches another user, and never enables root-mode Docker.
#
set -euo pipefail
U="$1"   # the domain user — the ONLY input; supplied as a positional argument

if [ -z "$U" ]; then echo "usage: $0 <domain_user>" >&2; exit 64; fi

# --- Guard: ISPConfig owns the user; we never create it. --------------------
if ! id "$U" >/dev/null 2>&1; then
  echo "FATAL: domain user $U does not exist; ISPConfig must create it first" >&2
  exit 2
fi
echo "step: domain user $U exists (uid=$(id -u "$U"))"

# --- Docker CE (install if absent) + rootless prerequisites. ----------------
export DEBIAN_FRONTEND=noninteractive
# A fresh box may have neither Docker nor the Docker apt repo, so installing
# docker-ce-rootless-extras alone 404s. Install Docker CE via the official
# script FIRST when absent (it adds the repo + the compose plugin + rootless
# extras). Guarded by presence, so re-runs are no-ops.
if ! command -v dockerd >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
  echo "step: Docker is absent — installing Docker CE via get.docker.com"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/deploykit-get-docker.sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO /tmp/deploykit-get-docker.sh https://get.docker.com
  else
    echo "FATAL: Docker absent and neither curl nor wget present to install it" >&2; exit 4
  fi
  sh /tmp/deploykit-get-docker.sh >/dev/null
  rm -f /tmp/deploykit-get-docker.sh
fi
apt-get install -y uidmap dbus-user-session docker-ce-rootless-extras docker-compose-plugin >/dev/null 2>&1 \
  || apt-get install -y uidmap dbus-user-session >/dev/null
if ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
  echo "FATAL: dockerd-rootless-setuptool.sh missing after install (docker-ce-rootless-extras absent)" >&2; exit 4
fi
echo "step: Docker CE + rootless prerequisites present (uidmap, dbus-user-session, rootless-extras, compose plugin)"

UID_N="$(id -u "$U")"
RUNTIME="/run/user/$UID_N"

# --- (b) uid -> two usernames. systemd keys off the FIRST passwd entry. ------
# Resolve the name + home systemd will actually use; act on THAT home.
SYSNAME="$(id -un "$UID_N")"
SYSHOME="$(getent passwd "$SYSNAME" | cut -d: -f6)"
SHELLHOME="$(getent passwd "$U" | cut -d: -f6)"
if [ -z "$SYSHOME" ]; then SYSHOME="$SHELLHOME"; fi
# An empty passwd home would root every path below at "/.config" — refuse.
if [ -z "$SYSHOME" ]; then echo "FATAL: no home dir resolved for $U" >&2; exit 2; fi
if [ "$SYSNAME" != "$U" ]; then
  echo "note: uid $UID_N maps to systemd-name '$SYSNAME' (home $SYSHOME), shell-name '$U'"
fi

UNIT_DIR="$SYSHOME/.config/systemd/user"
OVERRIDE_DIR="$UNIT_DIR/docker.service.d"
DATA_HOME="$SYSHOME/.local/share"

# --- (a) Immutable home (chattr +i web root). -------------------------------
# We clear +i only long enough to create the writable subtrees, and a trap
# RESTORES +i on every exit path so the web root is never left unlocked.
IMMUTABLE=0
if lsattr -d "$SYSHOME" 2>/dev/null | awk '{print $1}' | grep -q 'i'; then
  IMMUTABLE=1
fi
restore_immutable() { if [ "$IMMUTABLE" = 1 ]; then chattr +i "$SYSHOME" 2>/dev/null || true; fi; }
if [ "$IMMUTABLE" = 1 ]; then
  echo "step: home $SYSHOME is immutable (chattr +i) — clearing temporarily, will restore"
  # Trap the fatal signals too, not just EXIT: run()'s timeout SIGKILLs the local
  # ssh client, which SIGHUPs this remote bash — and bash does NOT run an EXIT
  # trap on an untrapped signal. Without HUP/INT/TERM/PIPE here, a timeout in the
  # window before the restore below would leave the web root mutable, silently.
  trap restore_immutable EXIT HUP INT TERM PIPE
  chattr -i "$SYSHOME"
fi

mkdir -p "$UNIT_DIR" "$OVERRIDE_DIR" "$DATA_HOME"
chown "$UID_N:$UID_N" "$SYSHOME/.config" "$SYSHOME/.config/systemd" "$UNIT_DIR" "$OVERRIDE_DIR" "$SYSHOME/.local" "$DATA_HOME" 2>/dev/null || true
echo "step: systemd + dockerd directories present under $SYSHOME"

if [ "$IMMUTABLE" = 1 ]; then
  chattr +i "$SYSHOME"
  trap - EXIT HUP INT TERM PIPE
  echo "step: restored chattr +i on $SYSHOME"
fi

# --- Linger: keep the user manager + its D-Bus alive without a login. -------
loginctl enable-linger "$U"
echo "step: linger enabled for $U"

# --- (c) Per-user D-Bus must exist before 'systemctl --user'. ---------------
if [ ! -S "$RUNTIME/bus" ]; then
  echo "FATAL: $RUNTIME/bus (per-user D-Bus) is missing." >&2
  echo "Remediate: 'systemctl start user@$UID_N.service', wait for $RUNTIME/bus, re-run." >&2
  echo "Do NOT fall back to root-mode Docker." >&2
  exit 3
fi
USERBUS="XDG_RUNTIME_DIR=$RUNTIME DBUS_SESSION_BUS_ADDRESS=unix:path=$RUNTIME/bus"
echo "step: per-user D-Bus present at $RUNTIME/bus"

# --- Install (guarded: skip if a healthy daemon already answers). -----------
if su - "$U" -c "DOCKER_HOST=unix://$RUNTIME/docker.sock docker version --format '{{.Server.Version}}'" >/dev/null 2>&1; then
  echo "step: rootless Docker already installed for $U — skipping install"
else
  # The setuptool ends by running 'systemctl --user enable --now docker' itself.
  # Under uid-remap that unit lands in the wrong home and can't be found, so the
  # setuptool exits non-zero AFTER installing the binaries + writing the unit.
  # That failure is EXPECTED — swallow it and finish via the relocation + enable
  # below (which target the systemd-resolved home).
  if ! su - "$U" -c "$USERBUS dockerd-rootless-setuptool.sh install --force"; then
    echo "step: setuptool exited non-zero (expected under uid-remap) — continuing via unit relocation"
  else
    echo "step: dockerd-rootless-setuptool install complete"
  fi
fi

# --- (b) Make the unit visible in the systemd-resolved home + pin XDG. ------
if [ "$SYSHOME" != "$SHELLHOME" ] && [ -f "$SHELLHOME/.config/systemd/user/docker.service" ]; then
  cp -f "$SHELLHOME/.config/systemd/user/docker.service" "$UNIT_DIR/docker.service"
  chown "$UID_N:$UID_N" "$UNIT_DIR/docker.service"
  echo "step: copied docker.service into systemd-resolved home $SYSHOME"
fi
cat > "$OVERRIDE_DIR/10-deploykit.conf" <<CONF
[Service]
Environment=HOME=$SYSHOME
Environment=XDG_CONFIG_HOME=$SYSHOME/.config
Environment=XDG_DATA_HOME=$DATA_HOME
Environment=XDG_RUNTIME_DIR=$RUNTIME
CONF
chown "$UID_N:$UID_N" "$OVERRIDE_DIR/10-deploykit.conf"
echo "step: pinned HOME/XDG override for dockerd data-root"

su - "$U" -c "$USERBUS systemctl --user daemon-reload"
su - "$U" -c "$USERBUS systemctl --user enable --now docker"
echo "step: docker.service enabled + started for $U"

# --- Persist DOCKER_HOST for interactive shells (idempotent append). --------
su - "$U" -c "grep -q 'DOCKER_HOST=unix:///run/user/' ~/.bashrc || echo 'export DOCKER_HOST=unix:///run/user/'\$(id -u)'/docker.sock' >> ~/.bashrc"

# --- Verify AS THE DOMAIN USER. On failure we STOP (no root-Docker fallback). -
VER="$(su - "$U" -c "DOCKER_HOST=unix://$RUNTIME/docker.sock docker version --format '{{.Server.Version}}'")"

# --- The ONE line to paste back to the operator. ----------------------------
echo "DEPLOYKIT_VERIFY: docker=$VER user=$U uid=$UID_N"
`;

/**
 * Read-only host preflight (finding #4). No agent input reaches it — the whole
 * script is a constant, so a pipe/subshell here has no injection surface. It
 * prints KEY=VALUE lines the tool parses; it CHANGES NOTHING (no install, no
 * write). Every fact maps to a build failure this deploy actually hit:
 *   - CPU x86-64-v2  : LobeHub's `sharp` needs it; a pre-v2 build host fails
 *                      deep in `next build`. The RUN host needs it too.
 *   - RAM + swap     : the build peaked ~8 GB on a ~4.7 GB box.
 *   - disk quota     : ISPConfig defaults the domain user to 2 GB; rootless
 *                      images/volumes live under $HOME → "disk quota exceeded".
 *   - docker/rootless: is the per-user daemon even there yet.
 */
const HOST_PREFLIGHT_SCRIPT = String.raw`
set +e
echo "USER=$(id -un)"
echo "UID=$(id -u)"
echo "ARCH=$(uname -m)"
# x86-64-v2 requires this CPU flag set. Absence of ANY one means pre-v2.
flags="$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | cut -d: -f2)"
have_v2=1
for f in sse4_2 popcnt cx16 lahf_lm sse4_1 ssse3; do
  echo " $flags " | grep -qw "$f" || have_v2=0
done
echo "CPU_X86_64_V2=$have_v2"
echo "MEM_TOTAL_MB=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)"
echo "MEM_AVAIL_MB=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)"
echo "SWAP_TOTAL_MB=$(awk '/^SwapTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)"
if command -v docker >/dev/null 2>&1; then echo "DOCKER_PRESENT=1"; else echo "DOCKER_PRESENT=0"; fi
if systemctl --user is-active docker >/dev/null 2>&1; then echo "ROOTLESS_DOCKER_ACTIVE=1"; else echo "ROOTLESS_DOCKER_ACTIVE=0"; fi
# Disk quota for THIS user (best-effort; quota may be off). Fields: used|soft|hard (1K blocks).
q="$(quota -w -u "$(id -un)" 2>/dev/null | tail -1)"
echo "QUOTA_FIELDS=$(echo "$q" | awk '{gsub(/[*]/,"",$2); print $2"|"$3"|"$4}')"
echo "HOME_AVAIL_MB=$(df -Pm "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
echo "PREFLIGHT_DONE=1"
`;

/** Parse KEY=VALUE lines from the preflight script into a flat map. */
function parseKv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").trim();
  }
  return out;
}

const numOr = (v: string | undefined): number | null => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : null;
};

export function registerPrivilegedTools(
  server: McpServer,
  cfg: Config,
  store: SessionStore,
  audit: AuditLog,
): void {
  // -----------------------------------------------------------------------
  // sshcon_resolve
  // -----------------------------------------------------------------------
  server.registerTool(
    "sshcon_resolve",
    {
      title: "Resolve an sshcon target to a session handle",
      description:
        "Resolve an allowlisted sshcon key. Returns a session_id plus non-secret facts " +
        "(host/port/user/app_dir) and a REDACTED raw block. Never returns a password or key.",
      inputSchema: {
        key: z.string().min(1).describe("sshcon key, e.g. web-host or db-host"),
        kind: z
          .enum(["domain", "root"])
          .describe("domain = the web user the app runs as; root = §4 setup only"),
        deploy_key_env: z
          .string()
          .optional()
          .describe(
            "NAME of an env var holding a base64 SSH deploy key (e.g. the project's SERVER_ACCESS). " +
              "The value stays server-side; it is decoded into a temp identity and tried BEFORE any " +
              "password. Use this to reach key-only hosts.",
          ),
      },
    },
    async ({ key, kind, deploy_key_env }) => {
      try {
        // Hot-reload the pin on every call so a config edit needs no restart (#2).
        assertKeyAllowed({ ...cfg, sshconKeyAllowlist: currentSshconKeyAllowlist() }, key);
        const parsed = await sshconList(cfg, key);

        if (!parsed.host || !parsed.user) {
          audit.write({
            tool: "sshcon_resolve",
            privilege: "none",
            outcome: "rejected",
            detail: { key, reason: "unparsed_fields", missing: parsed.missing },
          });
          // SKILL.md §1: show the raw block and ask; never guess a field.
          return fail(
            `sshcon output for "${key}" could not be parsed confidently.\n` +
              `Missing: ${parsed.missing.join(", ")}\n\n` +
              `Redacted raw output — tell me which line is which:\n${parsed.redactedRaw}`,
          );
        }

        const facts: SessionFacts = {
          kind,
          host: parsed.host,
          port: parsed.port ?? 22,
          user: parsed.user,
        };
        if (parsed.appDir !== undefined) facts.appDir = parsed.appDir;

        // Build the credential bundle: whatever sshcon reported, PLUS an
        // optional deploy key from a named env var. Key is tried first, so it
        // becomes the primary when present; the password stays as fallback.
        const secret: SessionSecret = { method: parsed.authMethod };
        if (parsed.authMethod === "key" && parsed.authValue) secret.keyPath = parsed.authValue;
        if (parsed.authMethod === "password" && parsed.authValue) secret.password = parsed.authValue;
        let cleanup: (() => void) | undefined;

        // sshcon-managed key: the key lives in sshcon's store, not on disk. Gate on
        // an sshcon new enough to export it, then materialize it to a 0600 temp
        // file for THIS session only (cleaned up on expiry). The label stays
        // "sshcon-managed" so the handle records where the credential came from.
        if (parsed.authMethod === "sshcon-managed") {
          const version = await sshconVersion(cfg);
          if (!semverGte(version, cfg.sshconMinVersion)) {
            audit.write({
              tool: "sshcon_resolve",
              privilege: "none",
              outcome: "rejected",
              detail: { key, reason: "sshcon_too_old", version, required: cfg.sshconMinVersion },
            });
            return fail(
              `sshcon ${version} cannot export the key for "${key}" — its Auth Type is "key" but the ` +
                `key is held in sshcon's key store, and \`ssh-key --write\` needs sshcon >= ${cfg.sshconMinVersion}.\n` +
                `Fix one of:\n` +
                `  • upgrade sshcon:  sshcon upgrade\n` +
                `  • or resolve this host WITHOUT sshcon via ssh_resolve, giving a key_path or password ` +
                `(ask the operator to grant this machine SSH access).`,
            );
          }
          const mk = await materializeSshconKey(cfg, key);
          secret.keyPath = mk.keyPath;
          cleanup = mk.cleanup;
        }

        if (deploy_key_env) {
          const dk = decodeKeyFromEnv(deploy_key_env);
          secret.keyPath = dk.keyPath;
          secret.method = "key";
          // Chain, don't clobber: a managed-key temp file (above) must still be
          // unlinked even when a deploy_key_env overrides which key is used.
          const prev = cleanup;
          cleanup = () => {
            try {
              prev?.();
            } finally {
              dk.cleanup();
            }
          };
        }

        const handle = store.create(facts, secret, cleanup);

        audit.write({
          tool: "sshcon_resolve",
          privilege: "none",
          outcome: "ok",
          session_id: handle.session_id,
          detail: {
            key,
            kind,
            host: facts.host,
            user: facts.user,
            auth_method: handle.auth_method,
            deploy_key_env: deploy_key_env ?? null,
          },
        });

        return ok({
          ...handle,
          ...(parsed.appPort ? { application_port: parsed.appPort } : {}),
          missing_fields: parsed.missing,
          redacted_raw: parsed.redactedRaw,
        });
      } catch (err) {
        audit.write({
          tool: "sshcon_resolve",
          privilege: "none",
          outcome: err instanceof AllowlistError ? "rejected" : "error",
          detail: { key, reason: (err as Error).name },
        });
        return fail(`${(err as Error).name}: ${(err as Error).message}`);
      }
    },
  );

  // -----------------------------------------------------------------------
  // reload_config — surface the hot-reloaded allowlist (no restart needed)
  // -----------------------------------------------------------------------
  server.registerTool(
    "reload_config",
    {
      title: "Re-read the operator config (sshcon key allowlist) without restarting",
      description:
        "Re-reads ~/.deploykit/config.json and DEPLOYKIT_SSHCON_KEYS and returns the ACTIVE sshcon " +
        "key allowlist. sshcon_resolve already re-reads the pin on every call; this makes the " +
        "current state visible so an operator can confirm an edit took effect mid-deploy.",
      inputSchema: {},
    },
    async () => {
      const list = currentSshconKeyAllowlist();
      audit.write({
        tool: "reload_config",
        privilege: "none",
        outcome: "ok",
        detail: { allowlist_size: list.length, unrestricted: list.length === 0 },
      });
      return ok({
        sshcon_key_allowlist: list,
        unrestricted: list.length === 0,
        config_file: configFilePath(),
        note:
          list.length === 0
            ? "no pin configured — any sshcon key is resolvable (default)"
            : "pin active — only these keys resolve",
      });
    },
  );

  // -----------------------------------------------------------------------
  // target_resolve — for hosts that are not in sshcon
  // -----------------------------------------------------------------------
  server.registerTool(
    "target_resolve",
    {
      title: "Resolve a NAMED ssh target to a session handle",
      description:
        "Resolve a target defined in ~/.deploykit/targets.json by NAME. Use this when the host is " +
        "not in sshcon. Credentials live in that file and are never passed as arguments, so they " +
        "never enter the conversation. Returns a session_id + non-secret facts, like sshcon_resolve.",
      inputSchema: {
        target: z.string().min(1).describe("target NAME from targets.json (never the credentials)"),
        kind: z
          .enum(["domain", "root"])
          .optional()
          .describe("override the target's declared kind; default domain"),
        deploy_key_env: z
          .string()
          .optional()
          .describe("NAME of an env var holding a base64 SSH deploy key; tried before any password"),
      },
    },
    async ({ target, kind, deploy_key_env }) => {
      try {
        const { facts, secret, cleanup: targetCleanup } = resolveTarget(target, kind);
        let cleanup = targetCleanup;
        if (deploy_key_env) {
          const dk = decodeKeyFromEnv(deploy_key_env);
          secret.keyPath = dk.keyPath;
          secret.method = "key";
          // Chain teardown so a keyB64/keyEnv target temp key is also unlinked.
          const prev = cleanup;
          cleanup = () => {
            try { prev?.(); } finally { dk.cleanup(); }
          };
        }
        const handle = store.create(facts, secret, cleanup);
        audit.write({
          tool: "target_resolve",
          privilege: "none",
          outcome: "ok",
          session_id: handle.session_id,
          detail: { target, kind: facts.kind, host: facts.host, user: facts.user, auth_method: handle.auth_method },
        });
        return ok({ ...handle, source: "targets.json" });
      } catch (err) {
        audit.write({
          tool: "target_resolve",
          privilege: "none",
          outcome: err instanceof TargetError ? "rejected" : "error",
          detail: { target, reason: (err as Error).name },
        });
        return fail(`${(err as Error).name}: ${(err as Error).message}`);
      }
    },
  );

  // -----------------------------------------------------------------------
  // ssh_resolve — resolve a host from INLINE details (works without sshcon)
  // -----------------------------------------------------------------------
  // The generic fallback: when a host is in neither sshcon nor targets.json, the
  // operator grants THIS machine access in-session by handing over a key path or
  // a password (directly, or via an env-var NAME whose value stays server-side).
  // Same no-secret-handle guarantee as the other resolvers: a key_path is a path
  // (not a credential) and env-var names are not secrets; only a raw `password`
  // enters the transcript, which the schema flags and de-emphasizes.
  server.registerTool(
    "ssh_resolve",
    {
      title: "Resolve an SSH target from inline connection details (with or without sshcon)",
      description:
        "Resolve a host by giving its connection details directly — for when it is in neither sshcon nor " +
        "targets.json. Provide host + user (+ optional port, app_dir, kind) and ONE credential: key_path " +
        "(a path to a private key ON THIS MACHINE — a path is not a secret), key_env / password_env (the " +
        "NAME of an env var whose value stays server-side), or password (raw — this ENTERS the transcript; " +
        "prefer password_env). Returns a session_id + non-secret facts, exactly like sshcon_resolve. Use " +
        "this to let the operator grant this deploykit host SSH access when no stored credential exists.",
      inputSchema: {
        host: z.string().regex(SSH_HOST).describe("hostname or IPv4 of the server"),
        user: z.string().regex(SSH_USER).describe("SSH login user, e.g. web108 or root"),
        port: z.number().int().min(1).max(65535).optional().describe("SSH port; default 22"),
        app_dir: z
          .string()
          .regex(ABS_PATH)
          .optional()
          .describe("APP_DIR for a domain target (enables rsync/pm2/compose verbs)"),
        kind: z.enum(["domain", "root"]).optional().describe("domain (default) or root"),
        key_path: z
          .string()
          .regex(SAFE_PATH)
          .optional()
          .describe("path to a private key ON THIS MACHINE (supports ~/…); a path is not a secret"),
        key_env: z
          .string()
          .optional()
          .describe("NAME of an env var holding a base64/PEM private key; the value stays server-side"),
        password_env: z
          .string()
          .optional()
          .describe("NAME of an env var holding the SSH password; the value stays server-side"),
        password: z
          .string()
          .optional()
          .describe("raw SSH password — WARNING: this enters the conversation transcript; prefer password_env"),
      },
    },
    async ({ host, user, port, app_dir, kind, key_path, key_env, password_env, password }) => {
      try {
        const keySources = [key_path, key_env].filter((v) => typeof v === "string" && v.length > 0).length;
        if (keySources > 1) return fail("REJECTED: set only ONE key source (key_path or key_env).");

        const facts: SessionFacts = { kind: kind ?? "domain", host, port: port ?? 22, user };
        if (app_dir) facts.appDir = app_dir;

        const secret: SessionSecret = { method: "unknown" };
        let cleanup: (() => void) | undefined;

        if (key_path) {
          const kp = key_path.startsWith("~/") ? path.join(os.homedir(), key_path.slice(2)) : key_path;
          if (!fs.existsSync(kp)) return fail(`REJECTED: key_path not found on this machine: ${kp}`);
          secret.keyPath = kp;
        } else if (key_env) {
          const dk = decodeKeyFromEnv(key_env); // validates the name, reads the value server-side
          secret.keyPath = dk.keyPath;
          cleanup = dk.cleanup;
        }

        if (password_env) {
          if (!ENV_NAME.test(password_env)) {
            return fail(`REJECTED: password_env "${password_env}" is not a valid env var name.`);
          }
          const pw = process.env[password_env];
          if (pw === undefined || pw.trim() === "") {
            return fail(`REJECTED: password_env "${password_env}" is not set in the MCP server environment.`);
          }
          secret.password = pw;
        } else if (password) {
          secret.password = password;
        }

        if (!secret.keyPath && !secret.password) {
          return fail(
            "REJECTED: no credential given. Provide key_path, key_env, password_env, or password — " +
              "ask the operator to grant this machine SSH access to the server.",
          );
        }

        // Key is tried first, so it is the label when present (see exec.ts).
        secret.method = secret.keyPath ? "key" : "password";
        const handle = store.create(facts, secret, cleanup);
        audit.write({
          tool: "ssh_resolve",
          privilege: "none",
          outcome: "ok",
          session_id: handle.session_id,
          detail: {
            host: facts.host,
            user: facts.user,
            kind: facts.kind,
            auth_method: handle.auth_method,
            // Record WHERE the credential came from, never the credential itself.
            credential_source: key_path ? "key_path" : key_env ? "key_env" : password_env ? "password_env" : "password",
          },
        });
        return ok({ ...handle, source: "inline" });
      } catch (err) {
        audit.write({
          tool: "ssh_resolve",
          privilege: "none",
          outcome: "error",
          detail: { host, reason: (err as Error).name },
        });
        return fail(`${(err as Error).name}: ${(err as Error).message}`);
      }
    },
  );

  // -----------------------------------------------------------------------
  // ssh_auth_preflight — which methods does the server OFFER? (no auth used)
  // -----------------------------------------------------------------------
  // The #1 field failure was guessing at auth. This probes the server with
  // `PreferredAuthentications=none` — it always "fails", but the server first
  // advertises its methods ("publickey,password"), which we parse. No credential
  // is read or sent, so it works even before a working one is known. The caller
  // uses the result to pick a method: key-only → supply a deploy key; password-
  // only → supply a password; both → key is tried first anyway.
  server.registerTool(
    "ssh_auth_preflight",
    {
      title: "Report which SSH auth methods a resolved host OFFERS (no credential used)",
      description:
        "Runs `ssh -o PreferredAuthentications=none` against a session's host and reports the auth " +
        "methods the server advertises (publickey / password / keyboard-interactive). Uses NO " +
        "credential. Call this before guessing: a key-only host can never be reached with a password.",
      inputSchema: {
        session_id: z.string().uuid().describe("session_id from sshcon_resolve or target_resolve"),
      },
    },
    async ({ session_id }) => {
      try {
        const facts = store.facts(session_id);
        const { methods } = await probeAuthMethods(facts, { timeoutMs: 30_000 });
        const offersKey = methods.includes("publickey");
        const offersPassword = methods.includes("password") || methods.includes("keyboard-interactive");
        const classification =
          offersKey && offersPassword ? "both"
          : offersKey ? "key-only"
          : offersPassword ? "password-only"
          : "unknown";
        audit.write({
          tool: "ssh_auth_preflight",
          privilege: "none",
          outcome: "ok",
          session_id,
          detail: { host: facts.host, user: facts.user, methods, classification },
        });
        return ok({
          host: facts.host,
          user: facts.user,
          methods,
          offers_key: offersKey,
          offers_password: offersPassword,
          key_only: offersKey && !offersPassword,
          classification,
          hint:
            classification === "key-only"
              ? "Password auth is OFF on this host — resolve with a deploy_key_env (or a keyPath/keyB64 target)."
              : classification === "password-only"
                ? "This host offers only password auth — a password credential is required."
                : "This host offers both — the key is tried first, password is the fallback.",
        });
      } catch (err) {
        audit.write({
          tool: "ssh_auth_preflight",
          privilege: "none",
          outcome: "error",
          session_id,
          detail: { reason: (err as Error).name },
        });
        return fail(`ERROR: ${(err as Error).message}`);
      }
    },
  );

  // -----------------------------------------------------------------------
  // host_preflight — read-only capability report (finding #4)
  // -----------------------------------------------------------------------
  server.registerTool(
    "host_preflight",
    {
      title: "Read-only host capability report (CPU microarch, RAM/swap, quota, Docker)",
      description:
        "Gathers, over a resolved session, the facts that decide whether a host can BUILD/RUN the " +
        "app: CPU x86-64-v2 (sharp needs it), RAM + swap (LobeHub build peaks ~8 GB), the domain " +
        "user's disk quota (ISPConfig defaults to 2 GB → 'disk quota exceeded'), and whether Docker/" +
        "rootless Docker is present. Read-only: installs and changes NOTHING. Pair with " +
        "ssh_auth_preflight for the SSH auth methods.",
      inputSchema: {
        session_id: z.string().uuid().describe("session_id from sshcon_resolve or target_resolve"),
      },
    },
    async ({ session_id }) => {
      try {
        const facts = store.facts(session_id);
        // No agent input in the script → the whole thing is a constant; shellQuote
        // it once so the remote login shell hands it to `bash -lc` intact.
        const connArgs = [
          "-p",
          String(facts.port),
          `${facts.user}@${facts.host}`,
          "--",
          "bash",
          "-lc",
          shellQuote(HOST_PREFLIGHT_SCRIPT),
        ];
        const result = await store.withSecret(session_id, (secret) =>
          runSshWithAuth(connArgs, credsOf(secret), { timeoutMs: 60_000 }),
        );
        const kv = parseKv(result.stdout);

        const cpuV2 = kv["CPU_X86_64_V2"] === "1";
        const memAvail = numOr(kv["MEM_AVAIL_MB"]);
        const swap = numOr(kv["SWAP_TOTAL_MB"]);
        const usableMb = (memAvail ?? 0) + (swap ?? 0);
        const dockerPresent = kv["DOCKER_PRESENT"] === "1";
        const rootlessActive = kv["ROOTLESS_DOCKER_ACTIVE"] === "1";

        // quota fields: used|soft|hard in 1K blocks.
        const [qUsed, , qHard] = (kv["QUOTA_FIELDS"] ?? "").split("|");
        const quotaHardMb = numOr(qHard) !== null ? Math.round((numOr(qHard) as number) / 1024) : null;
        const quotaUsedMb = numOr(qUsed) !== null ? Math.round((numOr(qUsed) as number) / 1024) : null;

        const BUILD_PEAK_MB = 8000; // LobeHub build peak, per the retro.
        const warnings: string[] = [];
        if (!cpuV2) {
          warnings.push(
            "CPU is NOT x86-64-v2 — packages like sharp fail deep in the build (and at runtime). " +
              "Build on a v2 host and push a prebuilt image, or move this workload.",
          );
        }
        if (usableMb > 0 && usableMb < BUILD_PEAK_MB) {
          warnings.push(
            `Usable memory ~${usableMb} MB (avail ${memAvail ?? "?"} + swap ${swap ?? 0}) is below the ` +
              `~${BUILD_PEAK_MB} MB build peak — add a swapfile before building here, or build elsewhere.`,
          );
        }
        if (quotaHardMb !== null && quotaHardMb > 0 && quotaHardMb <= 3000) {
          warnings.push(
            `Disk quota hard limit ~${quotaHardMb} MB (used ~${quotaUsedMb ?? "?"} MB) is tight — rootless ` +
              `images/volumes live under the user's home and will hit 'disk quota exceeded'. Raise it in the ` +
              `ISPConfig panel (a raw setquota may be reverted by ISPConfig's quota sync).`,
          );
        }
        if (!dockerPresent) {
          warnings.push("Docker is not present — run grant_docker_access (root) to install rootless Docker.");
        } else if (!rootlessActive) {
          warnings.push("Docker present but the user's rootless daemon is not active — check grant_docker_access.");
        }

        audit.write({
          tool: "host_preflight",
          privilege: "domain",
          outcome: "ok",
          session_id,
          detail: { host: facts.host, cpu_x86_64_v2: cpuV2, usable_mb: usableMb, warnings: warnings.length },
        });

        return ok({
          host: facts.host,
          user: kv["USER"] ?? facts.user,
          arch: kv["ARCH"] ?? null,
          cpu_x86_64_v2: cpuV2,
          mem_total_mb: numOr(kv["MEM_TOTAL_MB"]),
          mem_available_mb: memAvail,
          swap_total_mb: swap,
          usable_mem_mb: usableMb,
          build_peak_estimate_mb: BUILD_PEAK_MB,
          disk_quota_hard_mb: quotaHardMb,
          disk_quota_used_mb: quotaUsedMb,
          home_available_mb: numOr(kv["HOME_AVAIL_MB"]),
          docker_present: dockerPresent,
          rootless_docker_active: rootlessActive,
          warnings,
          ok_to_build_here: cpuV2 && (usableMb === 0 || usableMb >= BUILD_PEAK_MB),
        });
      } catch (err) {
        audit.write({
          tool: "host_preflight",
          privilege: "domain",
          outcome: "error",
          session_id,
          detail: { reason: (err as Error).name },
        });
        return fail(`ERROR: ${(err as Error).message}`);
      }
    },
  );

  // -----------------------------------------------------------------------
  // grant_docker_access  — the ONLY root operation
  // -----------------------------------------------------------------------
  server.registerTool(
    "grant_docker_access",
    {
      title: "Install rootless Docker for a domain user (the one root op)",
      description:
        "Requires a ROOT-kind session. Runs one fixed, idempotent rootless-Docker script " +
        "for the named domain user. Cannot run anything else as root. Never falls back to root Docker.",
      inputSchema: {
        root_session_id: z.string().uuid().describe("session_id from sshcon_resolve(kind=root)"),
        domain_user: z.string().regex(USERNAME).describe("the domain user, e.g. web20"),
      },
    },
    async ({ root_session_id, domain_user }) => {
      try {
        const facts = store.facts(root_session_id);

        // Invariant #2: root-kind only. A domain session must never reach this.
        if (facts.kind !== "root") {
          audit.write({
            tool: "grant_docker_access",
            privilege: "root",
            outcome: "rejected",
            session_id: root_session_id,
            detail: { reason: "non_root_session", kind: facts.kind, domain_user },
          });
          return fail(
            `REJECTED: grant_docker_access requires a root-kind session; got "${facts.kind}". ` +
              `Resolve the server key with kind=root.`,
          );
        }

        // Deliver the script by scp, NEVER `bash -s` over stdin: under sshpass a
        // stdin redirect steals the tty channel sshpass answers on → pubkey-only
        // failure (finding A.3). scp + a remote `bash <file>` has no such channel
        // conflict and works identically for key and password auth. The remote
        // wrapper runs the file then removes it; domain_user is a positional arg,
        // never interpolated. Both scp and ssh use the key→password fallback.
        const localScript = path.join(os.tmpdir(), `deploykit-rootless-${randomUUID()}.sh`);
        const remoteScript = `/tmp/deploykit-rootless-${randomUUID()}.sh`;
        fs.writeFileSync(localScript, ROOTLESS_DOCKER_SCRIPT, { mode: 0o600 });

        const result = await store.withSecret(root_session_id, async (secret) => {
          const creds = credsOf(secret);
          try {
            await scpFile(facts, creds, localScript, remoteScript, { timeoutMs: cfg.execTimeoutMs });
            const connArgs = [
              "-p",
              String(facts.port),
              `${facts.user}@${facts.host}`,
              "--",
              "bash",
              "-c",
              // Fixed literal; $1=script path, $2=domain user (both positional).
              'bash "$1" "$2"; r=$?; rm -f "$1"; exit $r',
              "deploykit",
              remoteScript,
              domain_user,
            ];
            return await runSshWithAuth(connArgs, creds, { timeoutMs: cfg.execTimeoutMs });
          } finally {
            try {
              fs.unlinkSync(localScript);
            } catch {
              /* best-effort local cleanup */
            }
          }
        });

        // The script echoes markers when it took a hardening branch, so the
        // audit trail records WHICH real-host quirk was handled without the
        // server ever parsing free-form output into behaviour.
        const immutableHomeHandled = result.stdout.includes("IMMUTABLE_HOME_HANDLED");
        const uidRemapped = result.stdout.includes("UID_REMAPPED");
        const dockerCeInstalled = result.stdout.includes("DOCKER_CE_INSTALLED");
        const setuptoolNonzero = result.stdout.includes("SETUPTOOL_NONZERO");

        audit.write({
          tool: "grant_docker_access",
          privilege: "root",
          outcome: "ok",
          session_id: root_session_id,
          detail: {
            domain_user,
            host: facts.host,
            auth_method_used: result.authMethodUsed,
            already_installed: result.stdout.includes("ALREADY_INSTALLED"),
            docker_ce_installed: dockerCeInstalled,
            immutable_home_handled: immutableHomeHandled,
            uid_remapped: uidRemapped,
            setuptool_nonzero: setuptoolNonzero,
            docker_version: result.stdout.trim().split("\n").pop() ?? "",
          },
        });

        return ok({
          status: "ok",
          domain_user,
          auth_method_used: result.authMethodUsed,
          already_installed: result.stdout.includes("ALREADY_INSTALLED"),
          docker_ce_installed: dockerCeInstalled,
          immutable_home_handled: immutableHomeHandled,
          uid_remapped: uidRemapped,
          setuptool_nonzero: setuptoolNonzero,
          docker_server_version: result.stdout.trim().split("\n").pop() ?? "",
        });
      } catch (err) {
        audit.write({
          tool: "grant_docker_access",
          privilege: "root",
          outcome: "error",
          session_id: root_session_id,
          detail: { domain_user, reason: (err as Error).name },
        });
        // Invariant #2: stop, show output, never work around with root docker.
        const detail = err instanceof ExecError ? err.result.stderr.slice(0, 800) : "";
        return fail(
          `rootless docker install FAILED — stopping. Do NOT fall back to root Docker (invariant #2).\n` +
            `${(err as Error).message}\n${detail}`,
        );
      }
    },
  );

  // -----------------------------------------------------------------------
  // emit_root_runbook — PURE TEXT generator (invariant #3: executes NOTHING)
  // -----------------------------------------------------------------------
  // For the operator who has SSH to the DOMAIN user but no root session: this
  // hands their server team an auditable script to run. It never connects to
  // `host` (display only), never reads a credential, and never calls run()/
  // spawn()/ssh — it only returns text plus one audit line.
  server.registerTool(
    "emit_root_runbook",
    {
      title: "Generate (not run) the root rootless-Docker runbook for a server team",
      description:
        "Read-only TEXT generator. Returns a self-contained, auditable bash runbook a server " +
        "team runs as root to install rootless Docker for a domain user, plus a cover note and " +
        "the one VERIFY line to paste back. Runs NOTHING itself and takes no credentials.",
      inputSchema: {
        domain_user: z
          .string()
          .regex(USERNAME)
          .describe("the domain user the runbook targets, e.g. web20"),
        host: z
          .string()
          .min(1)
          .describe("server hostname — DISPLAY ONLY, shown in the cover note; never connected to"),
        needs: z
          .array(z.string())
          .optional()
          .describe("optional free-form notes for the server team (e.g. 'web root is chattr +i')"),
      },
    },
    async ({ domain_user, host, needs }) => {
      // No ssh, no exec, no session lookup. Just build strings + audit once.
      const notes = (needs ?? []).filter((n) => n.trim().length > 0);
      const coverNote =
        `Hand this to your server team (someone with root on ${host}).\n\n` +
        `We deploy apps as rootless Docker under the domain user "${domain_user}" so nothing ` +
        `runs as root. This one-time setup needs root, which the deploying operator does not have.\n\n` +
        `Please run the runbook below AS ROOT, exactly as written:\n\n` +
        `    sudo bash deploykit-rootless-docker.sh ${domain_user}\n\n` +
        `It is idempotent (safe to re-run), touches only "${domain_user}", never enables ` +
        `root-mode Docker, and restores any immutable (chattr +i) web root it had to unlock.\n` +
        `When it finishes it prints one line starting "DEPLOYKIT_VERIFY:" — paste that line back ` +
        `to us and we take it from there.` +
        (notes.length ? `\n\nContext for this host:\n- ${notes.join("\n- ")}` : "");

      const verifyHint =
        `The runbook's last line is:  DEPLOYKIT_VERIFY: docker=<server-version> user=${domain_user} uid=<uid>\n` +
        `Paste that single line back — a non-empty docker= version confirms rootless Docker is live.`;

      audit.write({
        tool: "emit_root_runbook",
        privilege: "none",
        outcome: "ok",
        detail: { domain_user, host, needs_count: notes.length },
      });

      return ok({
        cover_note: coverNote,
        runbook: ROOTLESS_DOCKER_RUNBOOK,
        verify_hint: verifyHint,
      });
    },
  );

  // -----------------------------------------------------------------------
  // domain_exec  — allowlisted verbs only
  // -----------------------------------------------------------------------
  server.registerTool(
    "domain_exec",
    {
      title: "Run an allowlisted verb as the domain user",
      description:
        `Run ONE verb from the closed allowlist as the domain user over rootless Docker. ` +
        `Raw command strings are rejected by design. Allowed verbs: ${Object.keys(VERB_ALLOWLIST).join(", ")}`,
      inputSchema: {
        session_id: z.string().uuid().describe("session_id from sshcon_resolve(kind=domain)"),
        verb: z.string().describe("an allowlisted verb, e.g. docker.compose.up"),
        params: z
          .record(z.string())
          .optional()
          .describe("verb-specific params; each is validated against a fixed pattern"),
      },
    },
    async ({ session_id, verb, params }) => {
      const supplied = params ?? {};
      try {
        const facts = store.facts(session_id);

        // Invariant #2: app operations run as the domain user, never as root.
        if (facts.kind !== "domain") {
          audit.write({
            tool: "domain_exec",
            privilege: "domain",
            outcome: "rejected",
            session_id,
            verb,
            detail: { reason: "non_domain_session", kind: facts.kind },
          });
          return fail(
            `REJECTED: domain_exec requires a domain-kind session; got "${facts.kind}". ` +
              `App containers never run as root (invariant #2).`,
          );
        }

        const spec = assertVerbAllowed(verb);
        assertParamsValid(verb, spec, supplied);

        let shown = "";
        let connArgs: string[] | null = null;
        const rsyncSrc = spec.local ? supplied["src"] : undefined;
        if (spec.local) {
          if (rsyncSrc === undefined) throw new AllowlistError(`verb "${verb}" requires param "src"`);
        } else {
          const built = buildSshArgv(spec, facts, supplied);
          connArgs = built.connArgs;
          shown = built.remote;
        }

        // The auth executor tries key first, then password (finding A). rsync
        // gets the primary method; ssh verbs fall back within the one call.
        const result: ExecResult = await store.withSecret(session_id, async (secret) => {
          const creds = credsOf(secret);
          if (spec.local) {
            const built = buildRsyncArgv(facts, rsyncSrc as string, creds);
            shown = built.display;
            return run(built.file, built.args, { timeoutMs: cfg.execTimeoutMs, env: built.env });
          }
          return runSshWithAuth(connArgs as string[], creds, { timeoutMs: cfg.execTimeoutMs });
        });

        audit.write({
          tool: "domain_exec",
          privilege: "domain",
          outcome: "ok",
          session_id,
          verb,
          detail: { params: supplied, host: facts.host, user: facts.user, exit_code: result.code },
        });

        return ok({
          verb,
          argv: shown,
          exit_code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (err) {
        const rejected = err instanceof AllowlistError;
        audit.write({
          tool: "domain_exec",
          privilege: "domain",
          outcome: rejected ? "rejected" : "error",
          session_id,
          verb,
          detail: { params: supplied, reason: (err as Error).name },
        });
        return fail(`${rejected ? "REJECTED" : "ERROR"}: ${(err as Error).message}`);
      }
    },
  );
}
