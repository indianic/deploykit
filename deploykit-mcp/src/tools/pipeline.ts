/**
 * Pipeline + health tools.
 *
 * glab wrappers and a thin curl wrapper. No credentials pass through here: glab
 * uses its own configured auth, and CI variable VALUES are never read or
 * printed (SKILL.md §5).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { AuditLog } from "../audit.js";
import { run, ExecError } from "../exec.js";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

const BRANCH = /^[A-Za-z0-9._\/-]{1,128}$/;
// A fully-qualified project ref for a SELF-HOSTED GitLab: a full URL
// (https://gitlab.example.com/group/project or git@host:group/project.git) or a
// host/group/project path. A BARE owner/repo makes `glab -R` default to
// gitlab.com → 404 on a self-hosted box, so the ref must carry the host. Passed
// as a discrete argv element (no shell), so this charset is hygiene, not a gate.
const REPO_REF = /^[A-Za-z0-9._:@/~-]{3,200}$/;
/** True when the ref names the host (so glab targets the right instance). */
function refCarriesHost(ref: string): boolean {
  return /^https?:\/\//.test(ref) || /@[^:]+:/.test(ref) || ref.split("/").length >= 3;
}
const HTTPS_URL = /^https?:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]{1,2000}$/;
// One token is either an explicit 3-digit code ("307") or a status class
// ("2xx"). `expect` is a `|`-joined list of these, e.g. "2xx|3xx".
const EXPECT_TOKEN = /(?:\d{3}|[1-5]xx)/i.source;
const EXPECT_SPEC = new RegExp(`^${EXPECT_TOKEN}(?:\\|${EXPECT_TOKEN})*$`, "i");
// Auth-gated apps 307 -> /login and are perfectly healthy; a bare "2xx only"
// default would flag every such app as down. Accept both unless told otherwise.
const DEFAULT_EXPECT = "2xx|3xx";

/** True when `code` (a 3-digit HTTP status string) satisfies any token in `expect`. */
function isHealthyForExpect(code: string, expect: string): boolean {
  return expect
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean)
    .some((tok) => {
      if (/^\d{3}$/.test(tok)) return code === tok;
      const m = tok.match(/^([1-5])xx$/i);
      return m ? code[0] === m[1] : false;
    });
}

export function registerPipelineTools(server: McpServer, cfg: Config, audit: AuditLog): void {
  server.registerTool(
    "pipeline_run",
    {
      title: "Trigger a GitLab CI pipeline",
      description:
        "Wraps `glab ci run` for a branch. Never reads or prints CI variable values. For a " +
        "SELF-HOSTED instance pass `repo` as a full URL or host/group/project so glab targets the " +
        "right host (a bare owner/repo defaults to gitlab.com → 404).",
      inputSchema: {
        repo_path: z.string().min(1).describe("local path to the GitLab working copy"),
        branch: z.string().regex(BRANCH).describe("branch to run, e.g. indianic/main"),
        repo: z
          .string()
          .regex(REPO_REF)
          .optional()
          .describe("self-hosted project ref (full URL or host/group/project); omit to auto-detect from repo_path"),
      },
    },
    async ({ repo_path, branch, repo }) => {
      try {
        if (repo && !refCarriesHost(repo)) {
          return fail(
            `repo "${repo}" is a bare owner/repo — glab would default to gitlab.com. ` +
              `Pass a full URL or host/group/project for the self-hosted instance.`,
          );
        }
        const args = ["ci", "run", ...(repo ? ["-R", repo] : []), "-b", branch];
        const res = await run("glab", args, {
          timeoutMs: cfg.execTimeoutMs,
          cwd: repo_path,
        });
        audit.write({
          tool: "pipeline_run",
          privilege: "none",
          outcome: "ok",
          detail: { branch, repo_path, repo: repo ?? null },
        });
        return ok({ branch, stdout: res.stdout, stderr: res.stderr });
      } catch (err) {
        audit.write({
          tool: "pipeline_run",
          privilege: "none",
          outcome: "error",
          detail: { branch, reason: (err as Error).name },
        });
        return fail(`ERROR: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "pipeline_status",
    {
      title: "Get GitLab CI pipeline status",
      description: "Wraps `glab ci status`. Pass `repo` (full URL / host/group/project) for a self-hosted instance.",
      inputSchema: {
        repo_path: z.string().min(1),
        branch: z.string().regex(BRANCH),
        repo: z.string().regex(REPO_REF).optional().describe("self-hosted project ref; omit to auto-detect"),
      },
    },
    async ({ repo_path, branch, repo }) => {
      try {
        if (repo && !refCarriesHost(repo)) return fail(`repo "${repo}" must carry the host for a self-hosted instance`);
        const res = await run("glab", ["ci", "status", ...(repo ? ["-R", repo] : []), "-b", branch], {
          timeoutMs: cfg.execTimeoutMs,
          cwd: repo_path,
        });
        audit.write({ tool: "pipeline_status", privilege: "none", outcome: "ok", detail: { branch, repo: repo ?? null } });
        return ok({ branch, stdout: res.stdout, stderr: res.stderr });
      } catch (err) {
        const result = err instanceof ExecError ? err.result : undefined;
        audit.write({ tool: "pipeline_status", privilege: "none", outcome: "error", detail: { branch } });
        return ok({ branch, exit_code: result?.code ?? 1, stdout: result?.stdout ?? "", stderr: result?.stderr ?? (err as Error).message });
      }
    },
  );

  server.registerTool(
    "pipeline_trace",
    {
      title: "Fetch a GitLab CI job trace",
      description: "Wraps `glab ci trace`. Use this to read a failure before applying the §6 fix map.",
      inputSchema: {
        repo_path: z.string().min(1),
        branch: z.string().regex(BRANCH),
        job: z.string().regex(/^[A-Za-z0-9._: -]{1,128}$/).optional().describe("job name; omit for the failing job"),
        repo: z.string().regex(REPO_REF).optional().describe("self-hosted project ref; omit to auto-detect"),
      },
    },
    async ({ repo_path, branch, job, repo }) => {
      try {
        if (repo && !refCarriesHost(repo)) return fail(`repo "${repo}" must carry the host for a self-hosted instance`);
        const args = ["ci", "trace", ...(repo ? ["-R", repo] : []), "-b", branch];
        if (job) args.push(job);
        const res = await run("glab", args, { timeoutMs: cfg.execTimeoutMs, cwd: repo_path });
        audit.write({ tool: "pipeline_trace", privilege: "none", outcome: "ok", detail: { branch, job: job ?? null } });
        return ok({ branch, job: job ?? null, trace: res.stdout, stderr: res.stderr });
      } catch (err) {
        const result = err instanceof ExecError ? err.result : undefined;
        audit.write({ tool: "pipeline_trace", privilege: "none", outcome: "error", detail: { branch } });
        return ok({ branch, exit_code: result?.code ?? 1, trace: result?.stdout ?? "", stderr: result?.stderr ?? (err as Error).message });
      }
    },
  );

  server.registerTool(
    "health_check",
    {
      title: "HTTP health check (thin curl wrapper)",
      description:
        "Returns the HTTP status code for a URL. Thin wrapper over curl -o /dev/null -w '%{http_code}'. " +
        "Code 000 means connection failed/timed out.",
      inputSchema: {
        url: z.string().regex(HTTPS_URL).describe("full URL, e.g. https://example.com/up"),
        timeout_s: z.number().int().min(1).max(120).optional().describe("per-attempt timeout, default 10"),
        expect: z
          .string()
          .regex(EXPECT_SPEC)
          .optional()
          .describe(
            'status code(s) that count as healthy: "2xx", "3xx", "2xx|3xx", or an explicit ' +
              'code like "307". Default "2xx|3xx" — auth-gated apps that 307 -> /login are healthy, not down.',
          ),
      },
    },
    async ({ url, timeout_s, expect }) => {
      const t = String(timeout_s ?? 10);
      const expectSpec = expect ?? DEFAULT_EXPECT;
      // Fixed argv; url is regex-validated and passed as one element. No shell.
      const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", t, "-L", url];
      try {
        const res = await run("curl", args, { timeoutMs: (Number(t) + 5) * 1000 });
        const code = res.stdout.trim();
        const healthy = isHealthyForExpect(code, expectSpec);
        audit.write({ tool: "health_check", privilege: "none", outcome: "ok", detail: { url, http_code: code, expect: expectSpec } });
        return ok({ url, http_code: code, expect: expectSpec, healthy, argv: `curl ${args.join(" ")}` });
      } catch (err) {
        const result = err instanceof ExecError ? err.result : undefined;
        const code = (result?.stdout ?? "").trim() || "000";
        // curl exits non-zero on things other than "no connection" too — e.g. a
        // redirect loop hits --max-redirs and curl exits 47, but %{http_code}
        // still carries the real last status (307 for the auth-gated case this
        // whole change exists for). Only a genuine 000 means "actually down";
        // any other code is still evaluated against `expect` like the success path.
        const healthy = isHealthyForExpect(code, expectSpec);
        audit.write({ tool: "health_check", privilege: "none", outcome: "error", detail: { url, http_code: code, expect: expectSpec } });
        return ok({
          url,
          http_code: code,
          expect: expectSpec,
          healthy,
          note: code === "000" ? "000 = connection failed or timed out" : "curl exited non-zero (e.g. redirect limit) but returned a status code",
        });
      }
    },
  );
}
