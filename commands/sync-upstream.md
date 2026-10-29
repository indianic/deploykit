---
description: Sync latest source from the GitHub upstream into our GitLab deploy branch, preserving our environment files, then push to trigger redeploy.
argument-hint: "[branch=indianic/main] [--dry-run] [--no-deploy]"
allowed-tools: Bash, Read, Edit
---

# sync-upstream — pull GitHub -> keep our changes -> redeploy via GitLab

Bring our deploy branch up to date with the GitHub source WITHOUT losing any
IndiaNIC-specific files or leaking secrets. Our env-specific files live OUTSIDE
upstream's tree, so they survive a merge cleanly; conflicts can only occur in
source files WE actually edited.

Inputs (parse from "$ARGUMENTS"):
  branch      = our deploy branch            (default: indianic/main)
  --dry-run   = show what WOULD change, touch nothing, do not push
  --no-deploy = merge + commit locally, but DO NOT push (no pipeline)

## Files that are OURS (must never be clobbered by upstream)
  docker-compose.override.yml
  .gitlab-ci.yml
  .gitignore                (our volume/.env excludes)
  profiles/                 (only if vendored into this repo)
  CLAUDE.md                 (only our sections — see step 5)
These are not in upstream, so a normal merge leaves them intact. Verify anyway.

--------------------------------------------------------------------
## PHASE 0 — Preconditions (abort early if unsafe)
1. Confirm remotes exist and point where expected:
   `git remote -v`
   - upstream -> the GitHub source
   - origin   -> https://github.com/... or your GitLab host/... (the deploy repo)
   If either is missing/wrong, STOP and tell me — do not guess.
2. Working tree must be clean:
   `git status --porcelain`  -> if non-empty, STOP and show me the dirty files.
   Never merge over uncommitted work.
3. `git checkout <branch>` and record the current SHA (for rollback):
   `git rev-parse HEAD`  -> save as PRE_SYNC_SHA, print it.

--------------------------------------------------------------------
## PHASE 1 — Fetch & preview the delta
1. `git fetch upstream`
2. Show what's incoming:
   `git log --oneline --no-merges HEAD..upstream/HEAD | head -50`
   `git diff --stat HEAD..upstream/HEAD`
3. Predict conflicts BEFORE merging (read-only):
   `git merge-tree $(git merge-base HEAD upstream/HEAD) HEAD upstream/HEAD \
      | grep -E '^(changed in both|<<<<<<<|CONFLICT)' || echo "no conflicts predicted"`
4. Flag high-risk overlaps — any incoming change touching a file we own or a
   file the diff shows we've modified vs upstream:
   `git diff --name-only upstream/HEAD...HEAD`  (files WE changed)
   Intersect with incoming changed files; print the intersection as "REVIEW".
5. If --dry-run: print the summary (incoming commits, stat, predicted conflicts,
   REVIEW list) and STOP here. Change nothing.

--------------------------------------------------------------------
## PHASE 2 — Merge (safe, reversible)
1. Merge upstream into our branch, no fast-forward so the sync is one clear point:
   `git merge --no-ff --no-commit upstream/HEAD`
2. If conflicts:
   - List them: `git diff --name-only --diff-filter=U`
   - Resolve ONLY within source files. For any conflict inside a file WE own
     (should be rare), KEEP OUR version by default and tell me.
   - Show me each resolved hunk before finalizing. Do NOT auto-resolve blindly.
3. Sanity-guard our files survived the merge intact:
   `git diff --cached --name-only | grep -E \
     '^(docker-compose.override.yml|.gitlab-ci.yml|.gitignore)$' \
     && echo "OUR FILE CHANGED — review before commit"`
   If any of our files appear changed by the merge, show the diff and pause.
4. Secret guard — never let a merge stage a real .env:
   `git diff --cached --name-only | grep -E '(^|/)\.env$' \
     && { echo "REFUSING: .env staged"; git reset .env; }`
5. Commit the merge:
   `git commit -m "chore: sync upstream $(git rev-parse --short upstream/HEAD)"`

--------------------------------------------------------------------
## PHASE 3 — Prove locally BEFORE deploy (reuse the engine's gate)
Re-run the local-up health gate from bootstrap-deploy Phase 4b so we never push
unproven code:
1. Write a TEMP local `.env` (gitignored) — reuse existing server values if I
   have them handy, else minimal env sufficient to boot.
2. `docker compose up -d --build`
3. Health-check the profile's path (load profiles/<stack>.yml for port + path);
   wait healthcheck_grace, curl 127.0.0.1:<internal_port><healthcheck_path>.
4. On failure: tail logs, report, and STOP — do NOT push a broken sync.
   Offer rollback: `git reset --hard <PRE_SYNC_SHA>`.
5. On success: `docker compose down`, delete temp `.env`. Print "LOCAL OK".

--------------------------------------------------------------------
## PHASE 4 — Push & watch (unless --no-deploy)
1. If --no-deploy: stop here; print "merged locally, not pushed. PRE_SYNC_SHA=<..>".
2. Else: `git push origin <branch>`
3. Monitor the pipeline (same loop as bootstrap-deploy Phase 7):
   `glab ci status -R <origin> --branch <branch>`; on failure `glab ci trace`.
   Auto-fix up to 3 cycles for known failures, else STOP and show the trace.
4. On green + healthy environment URL, print the one-line result and, on its own
   final line, exactly:
     https://<domain>

--------------------------------------------------------------------
## ROLLBACK (if a synced deploy goes bad)
  git reset --hard <PRE_SYNC_SHA>
  git push --force-with-lease origin <branch>   # redeploys the previous good state
Server .env and volumes are untouched by rollback (excluded from rsync), so data
and secrets are preserved.
