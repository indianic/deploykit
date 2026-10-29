/**
 * Append-only audit log.
 *
 * One JSON line per privileged call. Opened with O_APPEND so concurrent writes
 * cannot interleave-clobber, and never truncated.
 *
 * Secrets are excluded by construction: `AuditEntry` has no field that can hold
 * credential material, and `scrub()` is a second belt-and-braces pass over the
 * free-form `detail` map.
 */

import fs from "node:fs";
import path from "node:path";

export type AuditOutcome = "ok" | "rejected" | "error";

export interface AuditEntry {
  /** Tool that was invoked. */
  tool: string;
  /** Privilege band actually exercised. */
  privilege: "none" | "domain" | "root";
  outcome: AuditOutcome;
  /** Session handle id, if any. Not a secret. */
  session_id?: string;
  /** Allowlisted verb, if any. */
  verb?: string;
  /** Non-secret structured detail. Scrubbed before write. */
  detail?: Record<string, unknown>;
}

/** Key names that must never appear in the log, however they arrive. */
const FORBIDDEN_KEY = /pass|secret|token|key|cred|auth|pwd/i;

/**
 * Drop any entry whose key smells like a credential, at any depth.
 * Fails closed: unknown/unserializable values are replaced, not passed through.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

export class AuditLog {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  get path(): string {
    return this.#file;
  }

  /** Append exactly one JSON line. Never throws into the tool path. */
  write(entry: AuditEntry): void {
    const record = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      privilege: entry.privilege,
      outcome: entry.outcome,
      ...(entry.session_id ? { session_id: entry.session_id } : {}),
      ...(entry.verb ? { verb: entry.verb } : {}),
      ...(entry.detail ? { detail: scrub(entry.detail) as Record<string, unknown> } : {}),
    };
    try {
      fs.appendFileSync(this.#file, JSON.stringify(record) + "\n", {
        encoding: "utf8",
        flag: "a",
      });
    } catch (err) {
      // An audit failure must be visible but must not leak into stdout, which
      // is the MCP stdio transport.
      process.stderr.write(
        `[deploykit-mcp] AUDIT WRITE FAILED: ${(err as Error).message}\n`,
      );
    }
  }
}
