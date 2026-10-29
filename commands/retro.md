---
description: After a deploy session, capture what the agent had to solve that the MCP didn't already know — append append-only learnings and propose (never auto-apply) deeper patches so the next project starts smarter.
argument-hint: "[--since=<iso8601>] [--dry-run] [--no-propose]"
allowed-tools: Bash, Read, Edit, Write
---

# retro — turn this session's hard-won fixes into durable memory

Run this at the END of a deploy session. It reads what actually happened, finds
every lesson the MCP did NOT already know, appends those to
`knowledge/learnings.yml` (append-only), and emits a REVIEW-ONLY patch proposal
for deeper fixes. It never auto-edits the skill or the tools, and it never prints
a secret value.

Inputs (parse from "$ARGUMENTS"):
  --since=<iso>   = only consider audit entries at/after this time (default: this
                    session's start; fall back to the last 24h if unknown)
  --dry-run       = compute and print, but do NOT write learnings.yml
  --no-propose    = skip the deeper-fix patch proposal (step D)

The knowledge lives in DATA, not in this command: entries go in
`knowledge/learnings.yml`, which the deploy-engine loads at the start of every
deploy (SKILL.md §8). This command only feeds that file.

--------------------------------------------------------------------
## A — Gather the evidence (read-only)

1. **Audit trail.** Read `~/.deploykit/audit.jsonl` (honour `DEPLOYKIT_AUDIT_PATH`
   if set). Take entries since `--since`. These already carry NO secrets — but
   still never echo a `detail` field without re-checking it. Summarise: which
   verbs ran, which were `rejected`, which tools `error`ed. A rejection or error
   is a signal that the agent hit something the allowlist/profile didn't cover.
2. **Deploy diff.** In the deploy repo, `git diff` and `git log` for this
   session's commits. What files did we have to touch by hand?
3. **Out-of-band interventions — the gold.** List every step the agent did
   OUTSIDE the MCP tools: a command it ran over a raw shell because no verb
   existed, a config file it hand-edited on the server, a workaround for a host
   quirk, a question it had to ask you that a profile should have answered. These
   are what the MCP is missing. Nothing in the audit log captures them, so
   reconstruct them from the session.

--------------------------------------------------------------------
## B — Classify each surprise: did the MCP already know it?

For every intervention and every surprise from step A, check all four knowledge
surfaces:
  - an allowlisted **verb** (config.ts `VERB_ALLOWLIST`)?
  - a **profile** field (`profiles/*.yml`) that should have supplied it?
  - a **SKILL.md §6** failure→fix entry?
  - an existing **`knowledge/learnings.yml`** entry?

If it is covered by NONE of them, it is a **candidate learning**. If it IS
covered but the coverage failed to fire, that is a candidate DEEPER FIX (step D),
not a new learning.

--------------------------------------------------------------------
## C — Append candidate learnings (append-only)

For each candidate learning, append an entry to `knowledge/learnings.yml` using
the exact schema already in that file:

```yaml
  - id: <kebab-case-unique>
    symptom: '<what the operator/agent observed>'
    root_cause: '<why it happened>'
    detect: '<cheap check that identifies it up front — a command or heuristic>'
    fix: '<the concrete remedy>'
    applies_when: '<predicate — stack, host type (ispconfig), config model, etc>'
    source_session: '<short, non-client-identifying tag for this session — describe the stack/host, not the customer>'
    added: '<YYYY-MM-DD>'
```

Rules:
- **Append only.** Never rewrite or delete an existing entry.
- **Dedupe.** Before appending, compare against existing entries by `symptom`
  and `root_cause` (case-insensitive, whitespace-normalised). If a match exists,
  skip it — do not append the same lesson twice. This makes re-running the retro
  safe.
- **Unique `id`.** If your kebab-case id collides with an existing one, suffix it.
- **No secrets.** `detect`/`fix` may name files and commands but never a
  credential value. Mirror the MCP's redaction contract.
- Under `--dry-run`, print what you WOULD append and stop before writing.
- After writing, validate: `python3 -c "import yaml; yaml.safe_load(open('knowledge/learnings.yml'))"`.

--------------------------------------------------------------------
## D — Propose deeper fixes (REVIEW ONLY — never applied) [skip if --no-propose]

Some learnings deserve more than a memory entry — they should become a real
capability. For those, emit a **patch proposal as a diff, printed to the screen,
NOT applied**. Candidates:
  - a new allowlisted **verb** (fixed argv + validated params) so next time the
    agent doesn't need a raw shell — never propose a generic "run anything" verb;
  - a new or extended **profile** field;
  - a new **SKILL.md §6** failure→fix entry;
  - **tool hardening** in the MCP.

Each proposed hunk must be traced to the learning that motivated it (`# motivated
by: <learning id>`). Present them as a unified diff the operator can review and
apply deliberately. You MUST NOT edit `skills/deploy-engine/SKILL.md`,
`deploykit-mcp/src/**`, or `config.ts` from this command — proposals only.

--------------------------------------------------------------------
## E — Summary

Print exactly:
  - `learnings added: N` (and the ids), `duplicates skipped: K`
  - `patches proposed: M` (and a one-line label each), or `patch proposals: skipped`
  - a one-line reminder: review the proposals, then apply the ones you want by hand.

Never claim a deeper fix is DONE — this command only remembers and proposes. The
apply step is a human decision.
