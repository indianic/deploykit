/**
 * Session store.
 *
 * The invariant here is structural, not conventional: secrets live in
 * `SessionSecret`, which is a private field of the store and is never part of a
 * `SessionHandle`. `toHandle()` is the ONLY way a session crosses the tool
 * boundary, and it is typed to omit auth. There is no accessor that returns a
 * credential to a caller.
 */

import { randomUUID } from "node:crypto";

export type SessionKind = "domain" | "root";

/** Non-secret facts. Safe to return to the agent. */
export interface SessionFacts {
  kind: SessionKind;
  host: string;
  port: number;
  user: string;
  /** Domain sessions only: the app directory, i.e. APP_DIR. */
  appDir?: string;
}

/**
 * Secret material. NEVER leaves this module.
 *
 * A session can carry BOTH a key and a password: real servers are key-first,
 * but sshcon may only know a password, and an operator may bring a deploy key
 * on top of a password target. Auth is attempted key-FIRST, then password
 * (see exec.ts), so a key-only root host is reachable where password-only never
 * could be. `method` is only the label surfaced in the handle — it never gates
 * which materials are tried.
 *
 * "sshcon-managed" means the key came from sshcon's key store (Auth Type: key, no local
 * path). It is materialized to a 0600 temp `keyPath` at resolve time via
 * `sshcon ssh-key --write`, so downstream auth uses the ordinary keyPath path;
 * the method is kept only to record the credential's PROVENANCE in the handle.
 */
export interface SessionSecret {
  /** Private-key file path. Tried FIRST when present. */
  keyPath?: string;
  /** Password. Tried after the key (via sshpass -e; never on argv). */
  password?: string;
  /** The mechanism reported by sshcon/targets — the LABEL for the handle only. */
  method: "key" | "password" | "sshcon-managed" | "unknown";
}

interface Session {
  id: string;
  facts: SessionFacts;
  secret: SessionSecret;
  expiresAt: number;
  /** Best-effort teardown (e.g. unlink a temp deploy-key file) run on expiry. */
  cleanup?: () => void;
}

/** What the agent receives. Structurally cannot carry a credential. */
export interface SessionHandle {
  session_id: string;
  kind: SessionKind;
  host: string;
  port: number;
  user: string;
  app_dir?: string;
  /** Which auth method is in play — the mechanism, never the material. */
  auth_method: "key" | "password" | "sshcon-managed" | "unknown";
  expires_at: string;
}

export class SessionExpiredError extends Error {
  constructor(id: string) {
    super(`session ${id} is unknown or expired`);
    this.name = "SessionExpiredError";
  }
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  create(facts: SessionFacts, secret: SessionSecret, cleanup?: () => void): SessionHandle {
    this.sweep();
    const id = randomUUID();
    const session: Session = {
      id,
      facts,
      secret,
      expiresAt: this.#now() + this.#ttlMs,
    };
    if (cleanup) session.cleanup = cleanup;
    this.#sessions.set(id, session);
    return toHandle(session.id, session.facts, session.secret.method, session.expiresAt);
  }

  /** Delete a session and run its teardown exactly once. */
  #drop(s: Session): void {
    this.#sessions.delete(s.id);
    try {
      s.cleanup?.();
    } catch {
      /* teardown is best-effort; a temp-key unlink race must not throw here */
    }
  }

  /** Internal-only: resolve a live session, or throw. */
  #live(id: string): Session {
    const s = this.#sessions.get(id);
    if (!s) throw new SessionExpiredError(id);
    if (s.expiresAt <= this.#now()) {
      this.#drop(s);
      throw new SessionExpiredError(id);
    }
    return s;
  }

  /** Non-secret facts for a session. Safe for callers. */
  facts(id: string): SessionFacts {
    return this.#live(id).facts;
  }

  handle(id: string): SessionHandle {
    const s = this.#live(id);
    return toHandle(s.id, s.facts, s.secret.method, s.expiresAt);
  }

  /**
   * Run `fn` with the secret bundle, without ever handing it out.
   * Only the privileged tools call this, to drive the auth executor in exec.ts.
   */
  withSecret<T>(id: string, fn: (secret: Readonly<SessionSecret>) => T): T {
    return fn(this.#live(id).secret);
  }

  /** Drop expired sessions so secrets (and temp key files) do not linger. */
  sweep(): void {
    const now = this.#now();
    for (const s of [...this.#sessions.values()]) {
      if (s.expiresAt <= now) this.#drop(s);
    }
  }

  size(): number {
    this.sweep();
    return this.#sessions.size;
  }
}

function toHandle(
  id: string,
  facts: SessionFacts,
  method: "key" | "password" | "sshcon-managed" | "unknown",
  expiresAt: number,
): SessionHandle {
  const handle: SessionHandle = {
    session_id: id,
    kind: facts.kind,
    host: facts.host,
    port: facts.port,
    user: facts.user,
    auth_method: method,
    expires_at: new Date(expiresAt).toISOString(),
  };
  if (facts.appDir !== undefined) handle.app_dir = facts.appDir;
  return handle;
}
