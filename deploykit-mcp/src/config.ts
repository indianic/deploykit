/**
 * Config + the two allowlist gates.
 *
 * Both gates are closed by default: a key or verb that is not explicitly listed
 * here cannot be reached by any tool call.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  /** Path to the sshcon binary. Overridable so tests can point at a mock. */
  sshconBinary: string;
  /** Append-only audit log destination. */
  auditPath: string;
  /** Session lifetime. Secrets are dropped from memory when a session expires. */
  sessionTtlMs: number;
  /** Closed allowlist of sshcon keys this server may resolve. */
  sshconKeyAllowlist: string[];
  /** Wall-clock cap on any child process. */
  execTimeoutMs: number;
  /**
   * Minimum sshcon version that ships `ssh-key --write` (managed-key export).
   * Managed-key resolves are gated on this; below it, sshcon_resolve fails with
   * an upgrade hint instead of a broken connection. Bump when the sshcon CLI
   * that adds `ssh-key` is published. Override with DEPLOYKIT_SSHCON_MIN.
   */
  sshconMinVersion: string;
}

/**
 * EMPTY = no key restriction. Any sshcon key may be resolved.
 *
 * Restricting which keys can be named was friction without protection: the
 * operator's machine already has every key configured, and a resolved handle
 * only ever unlocks an allowlisted VERB — never a shell, never a credential.
 * The real boundary is the verb allowlist + no-secret handles + the single
 * fixed root script.
 *
 * An org that DOES want to pin targets can still set `sshconKeyAllowlist` in
 * config.json (or DEPLOYKIT_SSHCON_KEYS); a non-empty list is enforced.
 */
const DEFAULT_KEY_ALLOWLIST: string[] = [];

/** Keys still have to be argv-safe; this is not a policy gate, just hygiene. */
const SAFE_KEY = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Operator-owned config, read from ~/.deploykit/config.json.
 *
 * The sshcon key allowlist has to live OUTSIDE the plugin. It is deliberately a
 * closed gate (so the agent cannot resolve an arbitrary target like
 * prod-db-master), but its contents are per-operator: you add a key when you
 * take on a new domain. Editing the shipped .mcp.json would be wiped by the
 * next `plugin install`, and baking keys into the source would mean a release
 * per domain — so neither is the right home.
 *
 * Precedence: env var > this file > built-in default.
 *
 * {
 *   "sshconKeyAllowlist": ["web-host", "db-host", "staging"]
 * }
 */
interface FileConfig {
  sshconKeyAllowlist?: string[];
  sshconBinary?: string;
  auditPath?: string;
  sessionTtlMs?: number;
  execTimeoutMs?: number;
  sshconMinVersion?: string;
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["DEPLOYKIT_CONFIG"] ?? path.join(os.homedir(), ".deploykit", "config.json")
  );
}

/**
 * Read the operator config. A malformed file is reported on stderr and ignored
 * rather than thrown: a typo in config.json must not take the whole server
 * down, and falling back to the *narrower* built-in default fails closed.
 */
function loadFileConfig(env: NodeJS.ProcessEnv): FileConfig {
  const file = configFilePath(env);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      process.stderr.write(`[deploykit-mcp] ${file}: expected a JSON object; ignoring\n`);
      return {};
    }
    const cfg = parsed as FileConfig;
    if (cfg.sshconKeyAllowlist !== undefined) {
      if (
        !Array.isArray(cfg.sshconKeyAllowlist) ||
        !cfg.sshconKeyAllowlist.every((k) => typeof k === "string" && k.length > 0)
      ) {
        process.stderr.write(
          `[deploykit-mcp] ${file}: sshconKeyAllowlist must be an array of non-empty strings; ignoring it\n`,
        );
        delete cfg.sshconKeyAllowlist;
      }
    }
    return cfg;
  } catch (err) {
    process.stderr.write(
      `[deploykit-mcp] ${file}: ${(err as Error).message}; ignoring (using defaults)\n`,
    );
    return {};
  }
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listFromEnv(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined || raw.trim() === "") return fallback;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = loadFileConfig(env);
  return {
    sshconBinary: env["DEPLOYKIT_SSHCON_BIN"] ?? file.sshconBinary ?? "sshcon",
    // NOT cwd: as a plugin MCP server, cwd is whatever project the user happens
    // to be in, which would scatter audit logs into unrelated repos (and risk
    // committing them). The audit trail is per-operator, so it lives in $HOME.
    auditPath:
      env["DEPLOYKIT_AUDIT_PATH"] ??
      file.auditPath ??
      path.join(os.homedir(), ".deploykit", "audit.jsonl"),
    sessionTtlMs: intFromEnv(env["DEPLOYKIT_SESSION_TTL_MS"], file.sessionTtlMs ?? 15 * 60 * 1000),
    sshconKeyAllowlist: listFromEnv(
      env["DEPLOYKIT_SSHCON_KEYS"],
      file.sshconKeyAllowlist ?? DEFAULT_KEY_ALLOWLIST,
    ),
    execTimeoutMs: intFromEnv(
      env["DEPLOYKIT_EXEC_TIMEOUT_MS"],
      file.execTimeoutMs ?? 10 * 60 * 1000,
    ),
    sshconMinVersion:
      (env["DEPLOYKIT_SSHCON_MIN"]?.trim() || undefined) ?? file.sshconMinVersion ?? "2.13.0",
  };
}

/**
 * Re-read ONLY the sshcon key allowlist (file + env), fresh.
 *
 * The allowlist is per-operator and edited mid-deploy (you add a key when you
 * take on a new domain). Reading it once at startup meant an edit did nothing
 * until the whole MCP was reconnected — brutal, and it risks losing the
 * session's context. sshcon_resolve calls this on EVERY resolve so an edit to
 * config.json / DEPLOYKIT_SSHCON_KEYS takes effect immediately. Everything else
 * (timeouts, paths) is stable for the process; only the gate hot-reloads.
 */
export function currentSshconKeyAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = loadFileConfig(env);
  return listFromEnv(env["DEPLOYKIT_SSHCON_KEYS"], file.sshconKeyAllowlist ?? DEFAULT_KEY_ALLOWLIST);
}

/** Raised when a closed allowlist rejects input. Never carries secret data. */
export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistError";
  }
}

/**
 * Gate 1: sshcon key hygiene, and an OPTIONAL pin.
 *
 * By default any key is resolvable (see DEFAULT_KEY_ALLOWLIST). The membership
 * check only applies when an operator has explicitly pinned a list.
 */
export function assertKeyAllowed(cfg: Config, key: string): void {
  if (!SAFE_KEY.test(key)) {
    throw new AllowlistError(
      `sshcon key "${key}" is not a valid key name (expected ${String(SAFE_KEY)}).`,
    );
  }
  if (cfg.sshconKeyAllowlist.length === 0) return; // unrestricted (default)
  if (!cfg.sshconKeyAllowlist.includes(key)) {
    throw new AllowlistError(
      `sshcon key "${key}" is not in the pinned allowlist: ${cfg.sshconKeyAllowlist.join(", ")}.\n` +
        `This pin is opt-in — remove or extend "sshconKeyAllowlist" in ${configFilePath()} ` +
        `(or DEPLOYKIT_SSHCON_KEYS) to allow it.`,
    );
  }
}

/**
 * Gate 2: the closed verb allowlist for domain_exec.
 *
 * Each verb maps to a fixed argv template. `{tokens}` are filled from validated
 * params or session facts and are ALWAYS passed as discrete argv elements —
 * they are never concatenated into a shell string, and no shell is spawned.
 */
export interface VerbSpec {
  /** Fixed argv template applied on the remote side. */
  remoteArgv: string[];
  /** Params this verb accepts. Anything else is rejected. */
  params: Record<string, RegExp>;
  /** Human description, surfaced in tool schema docs. */
  description: string;
  /** True when the verb runs locally (rsync) rather than over ssh. */
  local?: boolean;
}

/**
 * Placeholders resolved from session facts (not agent input):
 *   {app_dir} {user} {uid}
 * Placeholders resolved from validated params are declared in `params`.
 */
export const VERB_ALLOWLIST: Record<string, VerbSpec> = {
  "docker.compose.up": {
    description: "Build and start the app stack as the domain user (rootless).",
    remoteArgv: [
      "docker",
      "compose",
      "--project-directory",
      "{app_dir}",
      "up",
      "-d",
      "--build",
      "--remove-orphans",
    ],
    params: {},
  },
  "docker.compose.pull": {
    description: "Pull prebuilt images for the prebuilt build_strategy.",
    remoteArgv: ["docker", "compose", "--project-directory", "{app_dir}", "pull"],
    params: {},
  },
  "docker.compose.down": {
    description: "Stop the app stack. Volumes are preserved (no -v).",
    remoteArgv: ["docker", "compose", "--project-directory", "{app_dir}", "down"],
    params: {},
  },
  "docker.compose.restart": {
    description: "Restart one compose service.",
    remoteArgv: [
      "docker",
      "compose",
      "--project-directory",
      "{app_dir}",
      "restart",
      "{service}",
    ],
    params: { service: /^[a-zA-Z0-9._-]{1,64}$/ },
  },
  "docker.compose.ps": {
    description: "List compose containers and their state.",
    remoteArgv: ["docker", "compose", "--project-directory", "{app_dir}", "ps"],
    params: {},
  },
  "docker.compose.logs": {
    description: "Tail logs for one compose service.",
    remoteArgv: [
      "docker",
      "compose",
      "--project-directory",
      "{app_dir}",
      "logs",
      "--no-color",
      "--tail",
      "{tail}",
      "{service}",
    ],
    params: { service: /^[a-zA-Z0-9._-]{1,64}$/, tail: /^[0-9]{1,5}$/ },
  },
  "docker.image.prune": {
    description: "Prune dangling images after a build.",
    remoteArgv: ["docker", "image", "prune", "-f"],
    params: {},
  },
  "docker.version": {
    description:
      "Report the rootless Docker server version as the domain user (§4 verify).",
    remoteArgv: ["docker", "version", "--format", "{{.Server.Version}}"],
    params: {},
  },
  "id.uid": {
    description: "Domain user's uid, for the DERIVED PUID env value.",
    remoteArgv: ["id", "-u"],
    params: {},
  },
  "id.gid": {
    description: "Domain user's gid, for the DERIVED PGID env value.",
    remoteArgv: ["id", "-g"],
    params: {},
  },
  // Read-only PREFLIGHT/VERIFY verbs for the domain-user (rootless) path.
  // WHY: an operator with SSH to the domain user but no root still needs to
  // diagnose the exact ISPConfig failures grant_docker_access hardens against
  // (immutable HOME, uid->subid gaps, a dead user D-Bus) BEFORE asking a server
  // team to run the root runbook. One verb == one argv: a verb cannot chain two
  // commands without a shell, which is why subuid/subgid are two separate verbs.
  "docker.info.rootless": {
    description: "Report rootless Docker security options (proves rootless mode is active).",
    // The {{json .SecurityOptions}} Go template must reach docker verbatim; the
    // {token} resolver only touches [a-z_] single-brace tokens, so it passes through.
    remoteArgv: ["docker", "info", "--format", "{{json .SecurityOptions}}"],
    params: {},
  },
  "systemd.user.docker": {
    description: "Is the user-level docker.service active? (rootless daemon liveness).",
    remoteArgv: ["systemctl", "--user", "is-active", "docker"],
    params: {},
  },
  "fs.lsattr.home": {
    description: "Show file attributes of a home dir — reveals a chattr +i (immutable) web root.",
    remoteArgv: ["lsattr", "-d", "{home}"],
    // Absolute path only; no spaces or shell metacharacters can reach argv.
    params: { home: /^\/[A-Za-z0-9._\/-]{1,255}$/ },
  },
  "subid.subuid": {
    description: "Show the /etc/subuid range for the domain user (rootless needs a range).",
    remoteArgv: ["getent", "subuid", "{user}"],
    params: {},
  },
  "subid.subgid": {
    description: "Show the /etc/subgid range for the domain user (rootless needs a range).",
    remoteArgv: ["getent", "subgid", "{user}"],
    params: {},
  },
  "rsync.push": {
    description:
      "Push the working tree to APP_DIR. Excludes are hardcoded per invariants #3/#4.",
    local: true,
    remoteArgv: [],
    params: { src: /^[^\0]{1,512}$/ },
  },
  // Read-only PREFLIGHT verbs for deploy-direct: is a required binary present
  // (and, if so, what version)? Never installs — a gap is reported for the
  // operator to fix manually (invariant: the MCP never provisions).
  "bin.which": {
    description:
      "Read-only preflight: is a binary on the domain user's PATH? Used by deploy-direct " +
      "to check required packages; a non-zero exit means missing, which the caller reports.",
    remoteArgv: ["command", "-v", "{bin}"],
    params: { bin: /^[a-zA-Z0-9._+-]{1,64}$/ },
  },
  "bin.version": {
    description: "Read-only preflight: a runtime's --version, for minimum-version checks.",
    // Unlike every other verb, {bin} here is argv[0] — it EXECUTES the named
    // program. bin.which only *resolves* a name (command -v), so it can stay a
    // charset; but executing an agent-named program is a broader capability than
    // the fixed-argv model wants, so bin.version is pinned to a CLOSED ENUM of
    // the runtimes profiles actually version-check. Presence of anything outside
    // this set is still checkable via bin.which; only its --version is gated.
    remoteArgv: ["{bin}", "--version"],
    params: { bin: /^(node|npm|php|composer|python3|python|pip3|pm2|go|ruby|java|bun|deno)$/ },
  },
  // Native pm2 run verbs for deploy-direct: the app runs as the domain user
  // under pm2, no root, no docker. `{app_dir}` is a session fact, never agent
  // input; `ecosystem`/`script`/`name`/`lines` are regex-validated params.
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
    // `script` composes into `{app_dir}/{script}`. shellQuote neutralises shell
    // metachars but NOT path traversal, so the regex must: forbid any `..`
    // segment and a leading `/`, keeping the started file inside APP_DIR.
    params: { script: /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]{1,128}$/, name: /^[A-Za-z0-9._-]{1,64}$/ },
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
};

/** Gate 2 enforcement: resolve a verb or reject it. */
export function assertVerbAllowed(verb: string): VerbSpec {
  const spec = VERB_ALLOWLIST[verb];
  if (!spec) {
    throw new AllowlistError(
      `verb "${verb}" is not allowlisted. Allowed verbs: ${Object.keys(VERB_ALLOWLIST).join(", ")}`,
    );
  }
  return spec;
}

/** Validate params against the verb's declared shape. Rejects unknown params. */
export function assertParamsValid(
  verb: string,
  spec: VerbSpec,
  params: Record<string, string>,
): void {
  for (const name of Object.keys(params)) {
    if (!(name in spec.params)) {
      throw new AllowlistError(
        `verb "${verb}" does not accept param "${name}". Accepted: ${Object.keys(spec.params).join(", ") || "(none)"}`,
      );
    }
  }
  for (const [name, pattern] of Object.entries(spec.params)) {
    const value = params[name];
    if (value === undefined) {
      throw new AllowlistError(`verb "${verb}" requires param "${name}"`);
    }
    if (!pattern.test(value)) {
      throw new AllowlistError(
        `param "${name}" for verb "${verb}" failed validation ${String(pattern)}`,
      );
    }
  }
}
