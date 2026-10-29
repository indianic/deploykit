/**
 * Deploy-key material → a temp private-key file, server-side only.
 *
 * The org's servers are key-first, and the working deploy key already lives in
 * GitLab CI as the base64 `SERVER_ACCESS` variable. Reusing it means the raw key
 * must be turned into an `ssh -i <file>` identity — but it must NEVER cross the
 * tool boundary as an argument (that would put it in the conversation and the
 * on-disk transcript). So the DECODE happens here, in the server, from a source
 * the agent only ever NAMES: an env var, or the operator's own 600-perm files.
 *
 * Every decoded key is written 0600 into the OS temp dir and paired with a
 * `cleanup` that unlinks it; the session store runs that cleanup on expiry.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PRIVATE_KEY_MARK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/** A valid POSIX env var name — the only thing the agent may pass for keyEnv. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface DecodedKey {
  keyPath: string;
  cleanup: () => void;
}

/**
 * Turn key material into a temp identity file. `raw` may be a base64-wrapped key
 * (the CI `SERVER_ACCESS` shape) or a plain PEM; both are accepted. Throws if it
 * does not resolve to something that looks like a private key, so a mis-set
 * variable fails loudly instead of silently producing an unusable identity.
 */
export function decodeKeyMaterial(raw: string, label: string): DecodedKey {
  const trimmed = raw.trim();
  let pem = trimmed;
  if (!PRIVATE_KEY_MARK.test(pem)) {
    // Not already a PEM — try base64 (the SERVER_ACCESS storage form).
    try {
      pem = Buffer.from(trimmed, "base64").toString("utf8");
    } catch {
      pem = "";
    }
  }
  if (!PRIVATE_KEY_MARK.test(pem)) {
    throw new Error(`${label}: did not resolve to a private key (expected raw PEM or base64-encoded PEM)`);
  }
  const keyPath = path.join(os.tmpdir(), `deploykit-key-${randomUUID()}`);
  // OpenSSH refuses a key file the group/others can read; write 0600 up front.
  fs.writeFileSync(keyPath, pem.endsWith("\n") ? pem : pem + "\n", { mode: 0o600 });
  return {
    keyPath,
    cleanup: () => {
      try {
        fs.unlinkSync(keyPath);
      } catch {
        /* already gone — teardown is best-effort */
      }
    },
  };
}

/** Read a base64 key from a NAMED env var (value stays server-side) → temp file. */
export function decodeKeyFromEnv(envName: string): DecodedKey {
  if (!ENV_NAME.test(envName)) {
    throw new Error(`deploy_key_env "${envName}" is not a valid env var name (${String(ENV_NAME)})`);
  }
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`deploy_key_env "${envName}" is not set in the MCP server environment`);
  }
  return decodeKeyMaterial(raw, `deploy_key_env "${envName}"`);
}
