/**
 * Local, read-only analysis: analyze_repo, detect_env.
 *
 * No privilege, no network, no credentials. detect_env's contract is that it
 * returns KEY NAMES and CLASSES only — never a value. That is enforced by the
 * return type: there is no field to put a value in.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuditLog } from "../audit.js";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

const exists = (p: string): boolean => fs.existsSync(p);
const readIf = (p: string): string | undefined =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;

// Real `docker compose` file-discovery precedence (highest first). This order
// matters: a repo can ship a podman-only compose.yaml AND a docker-compose.yml,
// and `docker compose` silently prefers compose.yaml by filename even though it
// may be Docker-invalid — see isPodmanOnly() below.
const COMPOSE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

function findAllCompose(root: string): string[] {
  return COMPOSE_NAMES.filter((n) => exists(path.join(root, n)));
}

/** First docker-preferred compose file, for callers that only want one. */
function findCompose(root: string): string | undefined {
  return findAllCompose(root)[0];
}

// Podman-only markers docker compose cannot run correctly, even when it picks
// the file by name precedence. userns_mode: keep-id is podman's rootless
// UID-remap mode; :U/:z/:Z are podman/SELinux volume suffixes that are
// Docker-invalid.
const PODMAN_USERNS = /^\s*userns_mode:\s*["']?keep-id["']?\s*$/im;
const PODMAN_VOLUME_SUFFIX = /^\s*-\s*["']?[^:\n"']+:[^:\n"']+:[UzZ]["']?\s*$/m;

function isPodmanOnly(text: string): boolean {
  return PODMAN_USERNS.test(text) || PODMAN_VOLUME_SUFFIX.test(text);
}

/**
 * Shallow, bounded scan for a settings-style JSON config layout:
 * **\/settings/*.json, config/*.json, or data/**\/settings/*.json. Depth-capped
 * and skips vendor dirs — this only needs to answer "does this shape exist",
 * not enumerate every file, so unbounded recursion would be a needless
 * liability on a large checkout.
 */
function hasSettingsDirConfig(root: string): boolean {
  const SKIP_DIRS = new Set(["node_modules", ".git", "vendor"]);
  const MAX_DEPTH = 4;

  function hasJsonFile(dir: string): boolean {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .some((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"));
    } catch {
      return false;
    }
  }

  function walk(dir: string, depth: number): boolean {
    if (depth > MAX_DEPTH) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // **/settings/*.json (data/**/settings/*.json is the same shape, just deeper)
      if (e.name === "settings" && hasJsonFile(full)) return true;
      // config/*.json — checked at any bounded depth, not just root, since a
      // nested config dir is the same non-env signal.
      if (e.name === "config" && hasJsonFile(full)) return true;
      if (walk(full, depth + 1)) return true;
    }
    return false;
  }

  return walk(root, 0);
}

/**
 * Deep-scan for dotenv-shaped files (finding #6).
 *
 * The old detect_env only read the ROOT `.env.example` — for LobeHub that found
 * one key and missed the real server-DB surface in `docker-compose/deploy/
 * .env.example`. This walks the checkout (bounded, vendor dirs skipped) and
 * returns every `.env`/`.env.*` file as a repo-relative POSIX path. Only KEY
 * names are ever read out of these (values are discarded), so scanning a nested
 * real `.env` is safe. Root files come back as their basename for back-compat.
 */
const IS_ENV_FILE = /^\.env(\.[^/]*)?$/;

function findEnvFiles(root: string): string[] {
  const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".next"]);
  const MAX_DEPTH = 4;
  const MAX_FILES = 60;
  const found: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isFile() && IS_ENV_FILE.test(e.name)) {
        found.push(path.relative(root, full).split(path.sep).join("/"));
      } else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
        walk(full, depth + 1);
      }
    }
  }
  walk(root, 0);
  return found.sort();
}

/**
 * Stack detection per SKILL.md §2.
 * laravel = artisan + composer.json; nextjs = package.json + next dep; else _fallback.
 */
function detectStack(root: string): { stack: string; signals: string[] } {
  const signals: string[] = [];
  const composer = readIf(path.join(root, "composer.json"));
  const hasArtisan = exists(path.join(root, "artisan"));
  if (composer && hasArtisan) {
    signals.push("artisan", "composer.json");
    return { stack: "laravel", signals };
  }
  const pkgRaw = readIf(path.join(root, "package.json"));
  if (pkgRaw) {
    signals.push("package.json");
    try {
      const pkg = JSON.parse(pkgRaw) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      // LobeHub is a Next.js app, so it MUST be matched before the generic nextjs
      // branch — it needs Postgres+pgvector, a fresh JWKS_KEY, and the RustFS fix
      // that the plain nextjs profile knows nothing about.
      const isLobe =
        (typeof pkg.name === "string" && /lobe-?hub|lobe-?chat/i.test(pkg.name)) ||
        Object.keys(deps).some((d) => d.startsWith("@lobehub/"));
      if (isLobe && deps["next"]) {
        signals.push("lobehub marker (@lobehub/* or name)");
        return { stack: "lobehub", signals };
      }
      if (deps["next"]) {
        signals.push("next dependency");
        return { stack: "nextjs", signals };
      }
    } catch {
      signals.push("package.json unparseable");
    }
  }
  return { stack: "_fallback", signals };
}

/**
 * Port detection. Reports every candidate with its source rather than picking
 * one silently — invariant #6 says internal_port must be known, not assumed.
 */
function detectPorts(root: string, composeFile: string | undefined): {
  candidates: { port: number; source: string }[];
} {
  const candidates: { port: number; source: string }[] = [];

  const dockerfile = readIf(path.join(root, "Dockerfile"));
  if (dockerfile) {
    for (const m of dockerfile.matchAll(/^\s*EXPOSE\s+(\d{2,5})/gim)) {
      const p = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(p)) candidates.push({ port: p, source: "Dockerfile EXPOSE" });
    }
  }

  if (composeFile) {
    const compose = readIf(path.join(root, composeFile));
    if (compose) {
      // "HOST:CONTAINER" or "- CONTAINER"
      for (const m of compose.matchAll(/^\s*-\s*["']?(?:(\d{2,5}):)?(\d{2,5})["']?\s*$/gm)) {
        const p = Number.parseInt(m[2] ?? "", 10);
        if (Number.isFinite(p)) candidates.push({ port: p, source: `${composeFile} ports` });
      }
      for (const m of compose.matchAll(/^\s*expose:\s*\n(?:\s*-\s*["']?(\d{2,5})["']?\s*\n?)+/gim)) {
        const p = Number.parseInt(m[1] ?? "", 10);
        if (Number.isFinite(p)) candidates.push({ port: p, source: `${composeFile} expose` });
      }
    }
  }

  const seen = new Set<string>();
  return {
    candidates: candidates.filter((c) => {
      const k = `${c.port}:${c.source}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

// ---------------------------------------------------------------------------
// env classification (SKILL.md §3)
// ---------------------------------------------------------------------------

export type EnvClass = "AUTO" | "DERIVED" | "SECRET" | "INTEGRATION" | "IGNORE";

const RULES: { class: EnvClass; pattern: RegExp }[] = [
  { class: "DERIVED", pattern: /^(APP_URL|PUID|PGID|APP_ENV|NODE_ENV|ENV|APP_PORT|PORT)$/i },
  { class: "AUTO", pattern: /^(APP_KEY|JWT_SECRET|NEXTAUTH_SECRET|SECRET_KEY_BASE)$/i },
  {
    class: "INTEGRATION",
    pattern:
      /^(MAIL|SMTP|SLACK|AWS|S3|OAUTH|GOOGLE|GITHUB|FACEBOOK|STRIPE|TWILIO|PUSHER|SENTRY|MAILGUN|POSTMARK|SES|ALGOLIA)_/i,
  },
  { class: "SECRET", pattern: /(PASSWORD|PASSWD|_PASS$|SECRET|TOKEN|_KEY$|CREDENTIAL|PRIVATE)/i },
  { class: "IGNORE", pattern: /^(LOG_LEVEL|LOG_CHANNEL|APP_DEBUG|DEBUG|LOCALE|TIMEZONE|TZ|APP_NAME)$/i },
];

export function classifyKey(key: string, overrides: { class: EnvClass; pattern: RegExp }[] = []): EnvClass {
  // Profile overrides win (SKILL.md §3.2).
  for (const r of overrides) if (r.pattern.test(key)) return r.class;
  for (const r of RULES) if (r.pattern.test(key)) return r.class;
  return "IGNORE";
}

/** Extract KEY names from a dotenv-style file. Values are discarded immediately. */
function keysFromDotenv(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

function keysFromCompose(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(/^\s*-\s*([A-Z_][A-Z0-9_]*)\s*[=:]/gm)) {
    if (m[1]) keys.push(m[1]);
  }
  for (const m of text.matchAll(/^\s{6,}([A-Z_][A-Z0-9_]*)\s*:/gm)) {
    if (m[1]) keys.push(m[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// YAML colon-trap lint (finding #7)
// ---------------------------------------------------------------------------

export interface YamlLintFinding {
  line: number;
  issue: string;
  text: string;
}

// Blocks whose list entries are COMMAND SCALARS (GitLab CI, most compose-adjacent
// CI). Inside them, a `- echo "WARN: x"` breaks: YAML reads `echo "WARN` as a key
// because of the `: ` (colon-space). It bit this deploy twice.
const SCRIPT_BLOCK = /^(\s*)(script|before_script|after_script|commands|entrypoint|command):\s*$/;

/**
 * Lint YAML text for the two traps the deploy actually hit:
 *  1. colon-space in an UNQUOTED command scalar inside a script-like block
 *     (the plain-scalar ": " trap) — fix by quoting or using a block scalar.
 *  2. a literal TAB in indentation (YAML forbids tabs; parsers reject it).
 * Heuristic and intentionally conservative: quoted (' "), block (| >), and
 * flow ({ [) values are never flagged.
 */
export function lintYaml(text: string): { findings: YamlLintFinding[]; clean: boolean } {
  const findings: YamlLintFinding[] = [];
  const lines = text.split("\n");
  let scriptIndent: number | null = null; // indent of the active script block, or null

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    // A tab anywhere in the leading indentation — YAML forbids tabs there.
    if (/^[ \t]*\t/.test(raw)) {
      findings.push({ line: lineNo, issue: "tab in indentation (YAML forbids tabs)", text: raw });
    }
    if (raw.trim() === "" || raw.trim().startsWith("#")) return;

    const indent = raw.length - raw.replace(/^\s*/, "").length;
    const startBlock = raw.match(SCRIPT_BLOCK);
    if (startBlock) {
      scriptIndent = (startBlock[1] ?? "").length;
      return;
    }
    // Leaving the script block: a non-list line at or below the block indent.
    const isListEntry = /^\s*-\s+/.test(raw);
    if (scriptIndent !== null && !isListEntry && indent <= scriptIndent) {
      scriptIndent = null;
    }
    if (scriptIndent === null || !isListEntry) return;

    const value = raw.replace(/^\s*-\s+/, "");
    const firstCh = value[0] ?? "";
    // Quoted / block / flow scalars are safe.
    if (`'"|>{[`.includes(firstCh)) return;
    // Unquoted plain scalar in a command block: a `: ` (or a trailing `:`) makes
    // YAML try to parse it as a mapping.
    if (/:\s/.test(value) || /:\s*$/.test(value)) {
      findings.push({
        line: lineNo,
        issue: 'unquoted command contains ": " (colon-space) — YAML parses it as a mapping; quote it or use a block scalar',
        text: raw,
      });
    }
  });

  return { findings, clean: findings.length === 0 };
}

export function registerAnalysisTools(server: McpServer, audit: AuditLog): void {
  server.registerTool(
    "lint_yaml",
    {
      title: "Lint generated YAML for the plain-scalar colon-trap (and tabs)",
      description:
        "Static lint of YAML TEXT (e.g. a generated .gitlab-ci.yml or compose file) for the two " +
        "traps this stack hits: an unquoted command scalar containing \": \" inside a script-like " +
        "block (YAML mis-parses it as a mapping), and literal tabs in indentation. Returns line-level " +
        "findings; changes nothing.",
      inputSchema: {
        yaml: z.string().min(1).describe("the YAML text to lint"),
      },
    },
    async ({ yaml }) => {
      const { findings, clean } = lintYaml(yaml);
      audit.write({ tool: "lint_yaml", privilege: "none", outcome: "ok", detail: { findings: findings.length, clean } });
      return ok({ clean, finding_count: findings.length, findings });
    },
  );

  server.registerTool(
    "analyze_repo",
    {
      title: "Detect stack, Dockerfile/compose, and candidate ports",
      description:
        "Read-only local analysis of a checkout. Detects stack (laravel/nextjs/_fallback), " +
        "whether a Dockerfile exists, EVERY compose file present (flagging podman-only ones and " +
        "warning when selection is ambiguous), and every candidate internal port with its source.",
      inputSchema: {
        repo_path: z.string().min(1).describe("absolute path to a local checkout"),
      },
    },
    async ({ repo_path }) => {
      try {
        const root = path.resolve(repo_path);
        if (!exists(root) || !fs.statSync(root).isDirectory()) {
          return fail(`repo_path is not a directory: ${root}`);
        }
        const { stack, signals } = detectStack(root);
        const composeFiles = findAllCompose(root);
        const composeFile = composeFiles[0]; // first docker-preferred, for back-compat
        const hasDockerfile = exists(path.join(root, "Dockerfile"));
        const { candidates } = detectPorts(root, composeFile);

        const composeDetails = composeFiles.map((f) => ({
          file: f,
          podman_only: isPodmanOnly(readIf(path.join(root, f)) ?? ""),
        }));
        // Ambiguous or Docker-invalid selection must never be picked silently —
        // docker compose would otherwise pick by filename precedence and could
        // run the wrong (podman-only) file.
        const composeWarning =
          composeDetails.length > 1 || composeDetails.some((c) => c.podman_only)
            ? "Multiple or podman-only compose files found. `docker compose` selects by " +
              "filename precedence and may silently pick a Docker-invalid file — select " +
              "explicitly with `-f <file>` and prefer an operator-owned override rather " +
              "than editing upstream."
            : undefined;

        audit.write({
          tool: "analyze_repo",
          privilege: "none",
          outcome: "ok",
          detail: { repo_path: root, stack, has_dockerfile: hasDockerfile, compose_count: composeFiles.length },
        });

        return ok({
          repo_path: root,
          stack,
          detection_signals: signals,
          has_dockerfile: hasDockerfile,
          has_compose: composeFiles.length > 0,
          compose_file: composeFile ?? null,
          compose_files: composeDetails,
          ...(composeWarning ? { compose_warning: composeWarning } : {}),
          port_candidates: candidates,
          profile_to_load: `profiles/${stack}.yml`,
          note:
            candidates.length === 1
              ? "single candidate port"
              : "multiple or zero candidates — invariant #6: confirm internal_port, do not assume",
        });
      } catch (err) {
        audit.write({
          tool: "analyze_repo",
          privilege: "none",
          outcome: "error",
          detail: { reason: (err as Error).name },
        });
        return fail(`ERROR: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "detect_env",
    {
      title: "Discover and classify env KEYS (never values)",
      description:
        "Union of env keys from EVERY dotenv-shaped file in the checkout (root AND nested, e.g. " +
        "docker-compose/deploy/.env.example) plus compose; each classified as " +
        "AUTO/DERIVED/SECRET/INTEGRATION/IGNORE. Returns key names and classes only — " +
        "never a value. Also reports config_model: repos with a Dockerfile/compose but no dotenv " +
        "file and a settings/*.json layout are flagged non-env so the caller doesn't assume .env.",
      inputSchema: {
        repo_path: z.string().min(1).describe("absolute path to a local checkout"),
        overrides: z
          .array(z.object({ pattern: z.string(), class: z.enum(["AUTO", "DERIVED", "SECRET", "INTEGRATION", "IGNORE"]) }))
          .optional()
          .describe("profile env_classify overrides; these win over the generic pass"),
      },
    },
    async ({ repo_path, overrides }) => {
      try {
        const root = path.resolve(repo_path);
        const compiled = (overrides ?? []).map((o) => ({
          class: o.class as EnvClass,
          pattern: new RegExp(o.pattern),
        }));

        const sources: Record<string, string[]> = {};
        // Deep-scan every dotenv-shaped file, not just the root one (#6). This is
        // what surfaces server-DB env living in docker-compose/*/.env*.example.
        const envFiles = findEnvFiles(root);
        for (const rel of envFiles) {
          const text = readIf(path.join(root, rel));
          if (text) sources[rel] = keysFromDotenv(text);
        }
        const composeFile = findCompose(root);
        if (composeFile) {
          const c = readIf(path.join(root, composeFile));
          if (c) sources[composeFile] = keysFromCompose(c);
        }

        // Don't assume .env is the source of truth: a JSON/settings-dir app with
        // a Dockerfile or compose file but no dotenv variant at all is almost
        // certainly configured a different way (e.g. settings/*.json read at
        // runtime) — flag it so the caller classifies from app docs instead.
        const hasDockerfile = exists(path.join(root, "Dockerfile"));
        const hasAnyEnvFile = envFiles.length > 0;
        const configModel =
          (hasDockerfile || composeFile !== undefined) && !hasAnyEnvFile && hasSettingsDirConfig(root)
            ? "non-env (json/settings dir) — classify from app docs"
            : "env";

        const bySource = new Map<string, string[]>();
        for (const [src, keys] of Object.entries(sources)) {
          for (const k of keys) {
            const cur = bySource.get(k) ?? [];
            cur.push(src);
            bySource.set(k, cur);
          }
        }

        const keys = [...bySource.keys()].sort().map((key) => ({
          key,
          class: classifyKey(key, compiled),
          sources: bySource.get(key) ?? [],
        }));

        const summary: Record<string, number> = {};
        for (const k of keys) summary[k.class] = (summary[k.class] ?? 0) + 1;

        audit.write({
          tool: "detect_env",
          privilege: "none",
          outcome: "ok",
          detail: { repo_path: root, key_count: keys.length, summary, config_model: configModel },
        });

        return ok({
          repo_path: root,
          sources_scanned: Object.keys(sources),
          config_model: configModel,
          key_count: keys.length,
          summary,
          keys,
          contract: "key names and classes only; no values are read out of this tool",
        });
      } catch (err) {
        audit.write({
          tool: "detect_env",
          privilege: "none",
          outcome: "error",
          detail: { reason: (err as Error).name },
        });
        return fail(`ERROR: ${(err as Error).message}`);
      }
    },
  );
}
