/**
 * Child-process boundary.
 *
 * Everything here uses execFile with an argv ARRAY. `child_process.exec` and
 * any string-concatenated command are banned in this file — that is what makes
 * "no shell interpolation of agent input" a property of the code rather than a
 * habit.
 *
 * The one place a shell appears is the REMOTE side of an ssh call: SKILL.md §6
 * requires `bash -lc` there, because rootless Docker is not on PATH in a
 * non-login shell. That remote string is assembled from a FIXED argv template
 * plus params already validated against a tight charset by config.ts, and every
 * element is shell-quoted. Agent input never reaches it unvalidated.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config, VerbSpec } from "./config.js";
import type { SessionFacts } from "./sessions.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

export interface RunOpts {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to the child's stdin, then closed. Used to pipe a script to `bash -s`. */
  input?: string;
}

/**
 * Run a binary with a literal argv array.
 *
 * spawn with shell:false — the argv is handed to execve as-is, so shell
 * metacharacters in any element are inert. There is no string command anywhere.
 */
export async function run(file: string, args: string[], opts: RunOpts): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, stdout, stderr + `\n[timeout after ${opts.timeoutMs}ms]`);
    }, opts.timeoutMs);

    const finish = (code: number, out: string, err: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: ExecResult = { code, stdout: out, stderr: err };
      if (code === 0) resolve(result);
      else reject(new ExecError(`${file} exited ${code}: ${err.trim().slice(0, 400)}`, result));
    };

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => finish(127, stdout, e.message));
    child.on("close", (code) => finish(code ?? 1, stdout, stderr));

    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** POSIX single-quote quoting for the remote bash -lc string. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// sshcon
// ---------------------------------------------------------------------------

export interface SshconParsed {
  host?: string;
  port?: number;
  user?: string;
  /**
   * "sshcon-managed" = Auth Type is key but sshcon reported NO key path: the key
   * lives in sshcon's own key store, not on this machine. `authValue` is then the
   * sshcon KEY NAME (used to materialize the key via `sshcon ssh-key --write`), never a
   * credential. This is NOT a parse failure — do not push it onto `missing`.
   */
  authMethod: "key" | "password" | "sshcon-managed" | "unknown";
  authValue?: string;
  appDir?: string;
  /** sshcon's "Application Port" — the proxy_port hint. Non-secret. */
  appPort?: string;
  /** Fields we could not confidently extract. Surfaced so the agent ASKS (§1). */
  missing: string[];
  /** Raw sshcon output with credential material masked. */
  redactedRaw: string;
}

/**
 * Mask anything auth-shaped before raw output is shown.
 *
 * Covers key/identity paths as well as passwords: the agent has no need for
 * either (the server holds them), and a key path narrows an attacker's search.
 */
const AUTH_LINE = /pass(word)?|secret|token|pwd|key|identity|cred|auth/i;

export function redactRaw(raw: string): string {
  return raw
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      if (!AUTH_LINE.test(line)) return line;
      // Mask the value in BOTH layouts. The column layout has no colon, so a
      // colon-only rule would leave real passwords in the "redacted" output.
      const colon = line.replace(/^(\s*[\w .\-]+?\s*[:=])\s*.+$/, "$1 [redacted]");
      if (colon !== line) return colon;
      return line.replace(/^(\s*[A-Za-z][A-Za-z \-]*?)(\s{2,})(.+)$/, "$1$2[redacted]");
    })
    .join("\n");
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** sshcon renders "no value" as an em dash. */
const isBlank = (v: string): boolean => v === "" || v === "—" || v === "-";

/**
 * Parse the real column layout:
 *
 *   🖥️   SSH Connection
 *     Host              10.0.0.1
 *     Password          ...
 *   📁  FTP
 *     Password          ...          <- a DIFFERENT password
 *
 * Section tracking is load-bearing, not cosmetic: `Password`, `User`, and `URL`
 * each appear under several sections, so an unscoped match can silently pick
 * the FTP or Admin-Panel credential and try to SSH with it.
 */
function parseSections(clean: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = "";
  for (const line of clean.split("\n")) {
    const header = line.match(
      /(General|SSH Connection|Database|FTP|Admin Panel)\s*$/i,
    );
    if (header?.[1]) {
      current = header[1].toLowerCase();
      continue;
    }
    // "  Label            value"  — two-or-more spaces separate label from value
    const kv = line.match(/^\s{2,}([A-Za-z][A-Za-z \-]*?)\s{2,}(.+?)\s*$/);
    if (kv?.[1] && kv[2] !== undefined) {
      const k = kv[1].trim().toLowerCase();
      const v = kv[2].trim();
      if (isBlank(v)) continue;
      (sections[current] ??= {})[k] = v;
    }
  }
  return sections;
}

/** Parse the simple `key: value` layout. */
function parseColon(clean: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of clean.split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z _-]*?)\s*[:=]\s*(.+?)\s*$/);
    if (m?.[1] && m[2] !== undefined && !isBlank(m[2].trim())) {
      out[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  return out;
}

/**
 * Lenient sshcon parser.
 *
 * SKILL.md §1: the output format is NOT guaranteed stable, so this never
 * silently mis-reads. It understands both the column layout and a plain
 * `key: value` layout; anything not confidently matched lands in `missing`, and
 * the caller shows the redacted raw block and asks rather than guessing.
 */
export function parseSshcon(raw: string, keyName?: string): SshconParsed {
  const clean = raw.replace(ANSI, "");
  const sections = parseSections(clean);
  const ssh = sections["ssh connection"] ?? {};
  const general = sections["general"] ?? {};
  const colon = parseColon(clean);

  // SSH section wins; colon layout is the fallback. FTP/Admin are never read.
  const first = (...vals: (string | undefined)[]): string | undefined =>
    vals.find((v) => v !== undefined && !isBlank(v));

  const host = first(ssh["host"], colon["host"], colon["hostname"], colon["ip"], colon["address"]);
  const user = first(ssh["username"], ssh["user"], colon["username"], colon["user"], colon["login"]);
  const portRaw = first(ssh["port"], colon["port"]);
  const password = first(ssh["password"], colon["password"], colon["pass"], colon["pwd"]);
  const keyPath = first(
    ssh["key"], ssh["identity file"], ssh["identity"],
    colon["key"], colon["identity"], colon["identityfile"], colon["key_path"],
  );
  const appDir = first(
    ssh["post-login path"], ssh["path"],
    colon["path"], colon["dir"], colon["directory"], colon["docroot"],
    colon["app_dir"], colon["appdir"], colon["domain_dir"],
  );
  const appPort = first(general["application port"], colon["application port"]);

  // Trust an explicit "Auth Type" when sshcon states one.
  const declared = first(ssh["auth type"], colon["auth type"], colon["auth"])?.toLowerCase();
  // "Auth Type: key" with NO key path is NOT a parse failure — it is SSH
  // Manager-managed key auth (the key material lives server-side; sshcon injects
  // it at connect time). We materialize it later via `sshcon ssh-key --write`.
  const authMethod: SshconParsed["authMethod"] =
    declared === "password" ? "password"
    : declared === "key" && keyPath ? "key"
    : declared === "key" ? "sshcon-managed"
    : keyPath ? "key"
    : password ? "password"
    : "unknown";

  const authValue =
    authMethod === "sshcon-managed" ? keyName // the KEY NAME, not a credential
    : authMethod === "key" ? keyPath
    : authMethod === "password" ? password
    : undefined;

  const missing: string[] = [];
  if (!host) missing.push("host");
  if (!user) missing.push("user");
  // sshcon-managed carries a key NAME, not a credential, so a missing local
  // key/password is EXPECTED here and must not trip the disambiguation prompt.
  if (!authValue) missing.push("auth");

  const parsed: SshconParsed = {
    authMethod,
    missing,
    redactedRaw: redactRaw(clean),
  };
  if (host) parsed.host = host;
  if (user) parsed.user = user;
  const portNum = portRaw ? Number.parseInt(portRaw, 10) : NaN;
  parsed.port = Number.isFinite(portNum) ? portNum : 22;
  if (authValue) parsed.authValue = authValue;
  if (appDir) parsed.appDir = appDir;
  if (appPort) parsed.appPort = appPort;
  return parsed;
}

/** Invoke `sshcon list <key>`. */
export async function sshconList(cfg: Config, key: string): Promise<SshconParsed> {
  const res = await run(cfg.sshconBinary, ["list", key], {
    timeoutMs: 30_000,
  });
  // Thread the key NAME through so a managed key (Auth Type: key, no path) can
  // carry the name it must later be materialized from.
  return parseSshcon(res.stdout, key);
}

// ---------------------------------------------------------------------------
// sshcon version gate + managed-key materialization
// ---------------------------------------------------------------------------

/** Numeric major.minor.patch comparison; prerelease/build suffixes are ignored. */
export function semverGte(a: string, b: string): boolean {
  const parts = (s: string): [number, number, number] => {
    const [x = 0, y = 0, z = 0] = s.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return [x, y, z];
  };
  const [a1, a2, a3] = parts(a);
  const [b1, b2, b3] = parts(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

/**
 * Read the installed sshcon version via `sshcon version --json`.
 *
 * SKILL: we detect the `ssh-key --write` capability by VERSION, not by running
 * `ssh-key` and parsing an error — the latter would be an unreadable failure on
 * an old binary. `version --json` is stable across releases.
 */
export async function sshconVersion(cfg: Config): Promise<string> {
  const res = await run(cfg.sshconBinary, ["version", "--json"], { timeoutMs: 15_000 });
  let v: string | undefined;
  try {
    const j = JSON.parse(res.stdout) as { result?: { version?: string } };
    v = j?.result?.version;
  } catch {
    /* fall through to the throw below */
  }
  if (!v) {
    throw new Error(
      `could not read the sshcon version from \`sshcon version --json\` ` +
        `(got: ${res.stdout.slice(0, 120).replace(/\n/g, " ")})`,
    );
  }
  return v;
}

/**
 * Export an sshcon-held private key to a fresh 0600 temp file.
 *
 * The key never crosses the tool boundary: sshcon writes it to a path we name,
 * we `chmod 0600` as belt-and-suspenders (OpenSSH refuses group/other-readable
 * keys), and the paired `cleanup` unlinks it — the session store runs cleanup on
 * expiry. Mirrors keys.ts's DecodedKey shape so callers treat all temp keys alike.
 */
export async function materializeSshconKey(
  cfg: Config,
  name: string,
): Promise<{ keyPath: string; cleanup: () => void }> {
  const keyPath = path.join(os.tmpdir(), `deploykit-sshkey-${randomUUID()}`);
  await run(cfg.sshconBinary, ["ssh-key", name, "--write", keyPath], { timeoutMs: 30_000 });
  if (!fs.existsSync(keyPath)) {
    throw new Error(`sshcon ssh-key ${name} --write produced no key file at ${keyPath}`);
  }
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort; sshcon is expected to write it 0600 already */
  }
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

// ---------------------------------------------------------------------------
// verb -> argv
// ---------------------------------------------------------------------------

/**
 * Resolve `{tokens}` in a fixed template.
 * Only lowercase/underscore tokens are placeholders, so Go templates such as
 * `{{.Server.Version}}` pass through untouched.
 */
export function resolveTemplate(
  template: string[],
  facts: SessionFacts,
  params: Record<string, string>,
): string[] {
  const table: Record<string, string | undefined> = {
    app_dir: facts.appDir,
    user: facts.user,
    host: facts.host,
    ...params,
  };
  return template.map((element) =>
    element.replace(/\{([a-z_]+)\}/g, (_whole, token: string) => {
      const value = table[token];
      if (value === undefined) {
        throw new Error(`template token "{${token}}" has no value for this session`);
      }
      return String(value);
    }),
  );
}

/**
 * Build the ssh CONNECTION tail for an allowlisted verb.
 *
 * This is everything AFTER the per-attempt auth options: port, target, and the
 * remote `bash -lc <cmd>`. The auth options (-i / -o PreferredAuthentications /
 * sshpass wrap) are added by runSshWithAuth, which owns the key-then-password
 * fallback — so a verb builder never has to know which credential is in play.
 */
export function buildSshArgv(
  spec: VerbSpec,
  facts: SessionFacts,
  params: Record<string, string>,
): { connArgs: string[]; remote: string } {
  const remoteArgv = resolveTemplate(spec.remoteArgv, facts, params);
  // Fixed template + validated params, each element quoted.
  const remote = remoteArgv.map(shellQuote).join(" ");
  const connArgs = [
    "-p",
    String(facts.port),
    `${facts.user}@${facts.host}`,
    "--",
    "bash",
    "-lc",
    remote,
  ];
  return { connArgs, remote };
}

// ---------------------------------------------------------------------------
// Auth executor — key first, then password
// ---------------------------------------------------------------------------

/**
 * The credential bundle handed to the executor. Mirrors SessionSecret but is
 * decoupled from the store so exec.ts has no dependency on session internals.
 */
export interface SshCredentials {
  keyPath?: string;
  password?: string;
}

/**
 * Options for the KEY attempt. Non-interactive on purpose: BatchMode=yes makes
 * a missing/wrong key fail fast (exit 255) instead of hanging, and pinning
 * PreferredAuthentications=publickey stops ssh from silently trying a decoy
 * method. `accept-new` seeds an unknown host key without the interactive prompt.
 */
function keyOpts(keyPath: string): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "PreferredAuthentications=publickey",
    "-o", "StrictHostKeyChecking=accept-new",
    "-i", keyPath,
  ];
}

/**
 * Options for the PASSWORD attempt.
 *
 * CRITICAL: NO BatchMode here. `BatchMode=yes` disables the password prompt
 * entirely, so `sshpass` has nothing to answer and ssh falls through to pubkey →
 * "Permission denied (publickey)" even with a correct password. That single
 * misconfiguration was the field failure. We also pin password-only + disable
 * pubkey so a stray agent key can't shadow the password we mean to use.
 */
function passwordOpts(): string[] {
  return [
    "-o", "PreferredAuthentications=password,keyboard-interactive",
    "-o", "PubkeyAuthentication=no",
    "-o", "StrictHostKeyChecking=accept-new",
  ];
}

/** Options when NO credential is known — rely on the agent/default keys ssh finds. */
function defaultOpts(): string[] {
  return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
}

/** ssh exits 255 on connect/auth failure; these strings confirm it was AUTH. */
const AUTH_FAIL = /permission denied|authentication fail|no more authentication|too many authentication/i;

function isAuthFailure(r: ExecResult): boolean {
  return r.code === 255 || AUTH_FAIL.test(r.stderr);
}

export interface AuthExecResult extends ExecResult {
  /** Which credential actually connected — surfaced (not the material) to callers. */
  authMethodUsed: "key" | "password" | "default";
}

/**
 * Run `binary` (ssh or scp) trying KEY auth first, then PASSWORD.
 *
 * `baseArgs` is everything after the auth options: for ssh the connArgs from
 * buildSshArgv; for scp the `-P <port> <src> <user@host>:<dst>` triplet. The
 * password path NEVER receives stdin: sshpass owns the tty channel and a stdin
 * redirect steals it, re-triggering pubkey-only failure. Deliver scripts by scp
 * + a remote `bash <file>` instead (see scpFile), never `bash -s < script`.
 *
 * Fallback only happens on an AUTH failure. A non-auth non-zero exit is the
 * REMOTE command's own result and is returned as-is — we must not re-run a
 * mutating command just because it exited 1.
 */
export async function runWithAuth(
  binary: "ssh" | "scp",
  baseArgs: string[],
  creds: SshCredentials,
  opts: { timeoutMs: number },
): Promise<AuthExecResult> {
  const attempts: ("key" | "password" | "default")[] = [];
  if (creds.keyPath) attempts.push("key");
  if (creds.password) attempts.push("password");
  if (attempts.length === 0) attempts.push("default");

  let lastErr: ExecError | undefined;
  for (let i = 0; i < attempts.length; i++) {
    const method = attempts[i]!;
    const env = { ...process.env };
    let file: string;
    let args: string[];
    if (method === "key") {
      file = binary;
      args = [...keyOpts(creds.keyPath as string), ...baseArgs];
    } else if (method === "password") {
      // Password via SSHPASS env only — never on argv (world-readable in ps).
      env["SSHPASS"] = creds.password as string;
      file = "sshpass";
      args = ["-e", binary, ...passwordOpts(), ...baseArgs];
    } else {
      file = binary;
      args = [...defaultOpts(), ...baseArgs];
    }
    try {
      const r = await run(file, args, { timeoutMs: opts.timeoutMs, env });
      return { ...r, authMethodUsed: method };
    } catch (err) {
      if (!(err instanceof ExecError)) throw err;
      lastErr = err;
      const hasNext = i < attempts.length - 1;
      if (isAuthFailure(err.result) && hasNext) continue; // fall back to next method
      throw err; // remote-command failure, or no credential left to try
    }
  }
  // Unreachable (attempts always has ≥1 element), but keeps the type total.
  throw lastErr ?? new Error("runWithAuth: no attempt executed");
}

/** Convenience: run an allowlisted verb's connArgs over ssh with key→password fallback. */
export function runSshWithAuth(
  connArgs: string[],
  creds: SshCredentials,
  opts: { timeoutMs: number },
): Promise<AuthExecResult> {
  return runWithAuth("ssh", connArgs, creds, opts);
}

/** scp a local file to `user@host:remotePath`, key→password fallback. */
export function scpFile(
  facts: SessionFacts,
  creds: SshCredentials,
  localPath: string,
  remotePath: string,
  opts: { timeoutMs: number },
): Promise<AuthExecResult> {
  const baseArgs = [
    "-P", String(facts.port), // scp uses -P (capital); ssh uses -p
    localPath,
    `${facts.user}@${facts.host}:${remotePath}`,
  ];
  return runWithAuth("scp", baseArgs, creds, opts);
}

/**
 * Read which auth methods a server OFFERS, without authenticating.
 *
 * `ssh -o PreferredAuthentications=none` always fails, but the server first
 * advertises its methods in "Permission denied (publickey,password)." We parse
 * that list so the caller learns key-only / password / both BEFORE guessing a
 * credential. No secret is used or needed.
 */
export function parseOfferedAuthMethods(stderr: string): string[] {
  const m = stderr.match(/permission denied\s*\(([^)]+)\)/i);
  if (!m?.[1]) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Run the no-auth probe and return the offered methods (empty if unreadable). */
export async function probeAuthMethods(
  facts: SessionFacts,
  opts: { timeoutMs: number },
): Promise<{ methods: string[]; raw: string }> {
  const args = [
    "-p", String(facts.port),
    "-o", "BatchMode=yes",
    "-o", "PreferredAuthentications=none",
    "-o", "StrictHostKeyChecking=accept-new",
    `${facts.user}@${facts.host}`,
    "--",
    "true",
  ];
  try {
    const r = await run("ssh", args, { timeoutMs: opts.timeoutMs });
    // A 0 exit means the server accepted "none" auth (rare/misconfigured).
    return { methods: ["none"], raw: r.stderr };
  } catch (err) {
    const stderr = err instanceof ExecError ? err.result.stderr : (err as Error).message;
    return { methods: parseOfferedAuthMethods(stderr), raw: stderr };
  }
}

/**
 * Build the rsync argv. Excludes are hardcoded per invariants #3 and #4.
 *
 * rsync gets ONE shot (no per-call fallback), so it uses the primary method:
 * key when present, else password. The `-e` transport string mirrors the ssh
 * auth options exactly — including NOT setting BatchMode on the password path,
 * which would otherwise suppress the sshpass prompt and break the push.
 */
export function buildRsyncArgv(
  facts: SessionFacts,
  src: string,
  creds: SshCredentials,
): { file: string; args: string[]; env: NodeJS.ProcessEnv; display: string } {
  if (!facts.appDir) throw new Error("rsync.push requires a domain session with app_dir");
  const p = String(facts.port);
  const excludes = ["--exclude", ".git", "--exclude", ".env", "--exclude", "*-data/"];
  const srcDir = src.endsWith("/") ? src : `${src}/`;
  const dst = `${facts.user}@${facts.host}:${facts.appDir}/`;

  let file = "rsync";
  let transport: string;
  const env = { ...process.env };
  let pre: string[] = [];
  if (creds.keyPath) {
    transport = `ssh -p ${p} -i ${creds.keyPath} -o BatchMode=yes -o PreferredAuthentications=publickey -o StrictHostKeyChecking=accept-new`;
  } else if (creds.password) {
    file = "sshpass";
    pre = ["-e", "rsync"];
    env["SSHPASS"] = creds.password;
    transport = `ssh -p ${p} -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new`;
  } else {
    transport = `ssh -p ${p} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
  }

  const args = [...pre, "-az", "--delete", ...excludes, "-e", transport, srcDir, dst];
  // Display omits the auth detail (key path is as sensitive as the key itself).
  const display = `rsync -az --delete ${excludes.join(" ")} -e 'ssh -p ${p}' ${srcDir} ${dst}`;
  return { file, args, env, display };
}
