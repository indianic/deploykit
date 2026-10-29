/**
 * Named SSH targets, for hosts that are not in sshcon.
 *
 * The whole point is WHERE the credential lives. The operator writes it once
 * into ~/.deploykit/targets.json; the agent only ever names an alias. So a
 * credential never appears in a tool argument, which means it never appears in
 * the conversation or in the on-disk session transcript.
 *
 * This is the same guarantee sshcon_resolve gives: the secret is read
 * server-side, parked in the session store, and only a handle crosses the
 * boundary.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionFacts, SessionKind, SessionSecret } from "./sessions.js";
import { decodeKeyMaterial } from "./keys.js";

export interface TargetDef {
  host: string;
  port?: number;
  user: string;
  /**
   * Auth. A key is tried before a password, so a target MAY carry both (the
   * key-first-then-password fallback). Exactly one KEY SOURCE is allowed:
   * keyPath (a file), keyB64 (inline base64 in this 600-perm file), or keyEnv
   * (the NAME of an env var holding a base64 key — the value stays server-side).
   */
  password?: string;
  keyPath?: string;
  keyB64?: string;
  keyEnv?: string;
  /** APP_DIR for a domain target. */
  appDir?: string;
  /** domain (default) or root. */
  kind?: SessionKind;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export function targetsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env["DEPLOYKIT_TARGETS"] ?? path.join(os.homedir(), ".deploykit", "targets.json");
}

/** `~/x` -> `$HOME/x`. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A credentials file readable by other local users is a real problem, so say so
 * loudly. It is a warning rather than a hard failure: refusing to run would
 * push people back to pasting passwords into the chat, which is worse.
 */
function warnIfLooselyPermissioned(file: string): void {
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(
        `[deploykit-mcp] WARNING: ${file} is mode ${mode.toString(8)} — it holds credentials. ` +
          `Run: chmod 600 ${file}\n`,
      );
    }
  } catch {
    /* stat failures surface later on read */
  }
}

function loadFile(env: NodeJS.ProcessEnv): Record<string, TargetDef> {
  const file = targetsFilePath(env);
  if (!fs.existsSync(file)) {
    throw new TargetError(
      `no targets file at ${file}. Create it with an entry like:\n` +
        `  {\n    "learning": {\n      "host": "10.0.0.5",\n      "user": "learning",\n` +
        `      "password": "...",            // or "keyPath": "~/.ssh/id_x"\n` +
        `      "appDir": "/var/www/clients/client1/web19/web"\n    }\n  }\n` +
        `then: chmod 600 ${file}`,
    );
  }
  warnIfLooselyPermissioned(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new TargetError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TargetError(`${file} must be a JSON object of { "name": { ...target } }`);
  }
  return parsed as Record<string, TargetDef>;
}

/** Names only — safe to show. Used when a lookup misses. */
export function listTargetNames(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return Object.keys(loadFile(env)).sort();
  } catch {
    return [];
  }
}

export interface ResolvedTarget {
  facts: SessionFacts;
  secret: SessionSecret;
  /** Unlink any temp key file decoded from keyB64/keyEnv. Run on session expiry. */
  cleanup?: () => void;
}

/** How many KEY sources a target declares — more than one is ambiguous. */
function keySourceCount(t: TargetDef): number {
  return [t.keyPath, t.keyB64, t.keyEnv].filter((v) => typeof v === "string" && v.length > 0).length;
}

/**
 * Resolve a named target into facts + a credential bundle. The secret stops
 * here. A target may carry a key AND a password (key is tried first, password
 * is the fallback), but exactly one KEY SOURCE.
 */
export function resolveTarget(
  name: string,
  overrideKind: SessionKind | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTarget {
  if (!SAFE_NAME.test(name)) {
    throw new TargetError(`target name "${name}" is not valid (expected ${String(SAFE_NAME)})`);
  }
  const all = loadFile(env);
  const t = all[name];
  if (!t) {
    const known = Object.keys(all).sort();
    throw new TargetError(
      `target "${name}" is not in ${targetsFilePath(env)}. Known targets: ${known.join(", ") || "(none)"}`,
    );
  }

  if (typeof t.host !== "string" || !t.host) throw new TargetError(`target "${name}": "host" is required`);
  if (typeof t.user !== "string" || !t.user) throw new TargetError(`target "${name}": "user" is required`);

  const keySources = keySourceCount(t);
  if (!t.password && keySources === 0) {
    throw new TargetError(`target "${name}": one of "password", "keyPath", "keyB64" or "keyEnv" is required`);
  }
  if (keySources > 1) {
    throw new TargetError(`target "${name}": set only ONE key source (keyPath, keyB64, or keyEnv)`);
  }

  const kind: SessionKind = overrideKind ?? t.kind ?? "domain";
  const facts: SessionFacts = {
    kind,
    host: t.host,
    port: typeof t.port === "number" && Number.isFinite(t.port) ? t.port : 22,
    user: t.user,
  };
  if (t.appDir) facts.appDir = t.appDir;

  const secret: SessionSecret = { method: "unknown" };
  let cleanup: (() => void) | undefined;

  if (t.keyPath) {
    const kp = expandHome(t.keyPath);
    if (!fs.existsSync(kp)) throw new TargetError(`target "${name}": keyPath not found: ${kp}`);
    secret.keyPath = kp;
  } else if (t.keyB64) {
    const dk = decodeKeyMaterial(t.keyB64, `target "${name}" keyB64`);
    secret.keyPath = dk.keyPath;
    cleanup = dk.cleanup;
  } else if (t.keyEnv) {
    const raw = env[t.keyEnv];
    if (raw === undefined || raw.trim() === "") {
      throw new TargetError(`target "${name}": keyEnv "${t.keyEnv}" is not set in the MCP server environment`);
    }
    const dk = decodeKeyMaterial(raw, `target "${name}" keyEnv "${t.keyEnv}"`);
    secret.keyPath = dk.keyPath;
    cleanup = dk.cleanup;
  }
  if (t.password) secret.password = t.password;

  // Key is tried first, so it is the label when present.
  secret.method = secret.keyPath ? "key" : secret.password ? "password" : "unknown";

  const resolved: ResolvedTarget = { facts, secret };
  if (cleanup) resolved.cleanup = cleanup;
  return resolved;
}
