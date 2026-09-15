# Implementation delegation

Use this mode when the user, automatic routing or project workflow selects an enabled `workspace-write` worker. v0.4.2 supports Claude, Codex, OpenCode, DSH and ACP on Linux/WSL and native Windows, subject to installed CLI capabilities. Basic/main development normally stays with the Codex host; this path serves external escalation and specialist execution.

Choose the workspace explicitly from the task: `git-worktree` (default) for project development with patch integration, or `directory` for file/document/data work without Git. Git preflight failures never switch modes automatically.

## Prepare one complete work package

For Git use `prepare --role ROLE --cwd PROJECT` or an established workflow. Start from a clean, committed Git source; AW does not stash or silently omit uncommitted/untracked files. Keep the request file outside the source or in an ignored directory. Git execution excludes repositories with tracked symlinks/submodules. AW's state directory must be outside the target repository.

Write an implementation request:

```json
{
  "goal": "Fix the sum implementation and preserve its public API.",
  "acceptance": ["Existing sum checks pass without weakening verification."],
  "read_paths": ["src/sum.mjs", "tests/sum.test.mjs"],
  "handoff": {
    "current_state": ["The zero-input case currently fails."],
    "attempted": ["Changing the caller did not fix the underlying calculation."],
    "constraints": ["Preserve the exported function signature."]
  },
  "execution": {
    "write_paths": ["src/sum.mjs"],
    "verification": [
      {"command": "node", "args": ["--test", "tests/sum.test.mjs"], "cwd": ".", "timeout_seconds": 120}
    ],
    "max_attempts": 2
  },
  "source": "sum-fix",
  "timeout_seconds": 600
}
```

`write_paths` are literal file/directory paths relative to the supplied cwd. Use `/` on both platforms; no wildcards, `..`, absolute paths, or `.git`. A directory includes descendants. AW remaps read paths into the worktree and carries ancestor AGENTS.md/CLAUDE.md plus configured project instructions. The worker must read applicable nested instructions before editing.

Verification names an installed PATH command or absolute executable outside the source project, with an argv array and optional relative cwd. Project scripts are arguments, for example `node tests/check.mjs` or `npm test`. A worktree has its own dependency/build directories; ignored node_modules are not copied from the source. If dependencies are needed, supply `execution.setup`, an optional list using the same command shape, such as `npm ci --ignore-scripts --no-audit --no-fund` with a suitable timeout. These explicit commands run once before the first model turn, and are reused on follow-up. No dependency installation is added implicitly. A failed setup stops before a model task is submitted. Setup and checks must finish in the foreground and must not modify deliverable source files.

Permissions come from the host binding and cannot be widened by a request. Inspect `prepare` for effective `access`, `permissions` and `guarantee`:

- `restricted` (default): Claude/OpenCode use scoped file tools; ACP supplies scoped file read/write and denies terminal calls. DSH native file tools are classified using their preceding tool metadata. Codex uses its native workspace-write sandbox with network disabled and validates the resulting diff against write_paths. AW runs declared setup/checks as the current OS user outside any CLI sandbox.
- `full-access` (explicit host configuration): the worker can use native file and command tools; ACP also supplies terminal lifecycle methods. Commands can access the host and network. The worktree is not an OS sandbox, and write_paths only limits accepted deliverable changes; it cannot contain or undo external side effects. DSH unknown plugin tools remain denied. CLI-managed policy still applies.

Use the configured policy within the user's authorized scope. A native test run can help the worker repair its code, but AW must still record the declared verification against the final snapshot. Dependency installation is never added implicitly; specify authorized setup commands or include explicit task authorization when a full-access worker needs to install dependencies. Do not loosen permissions automatically after a failure. A task and its follow-ups retain their original permission snapshot.

`max_attempts` is the total number of model editing turns (1–5; default 2), not extra retries. Test assertion failures can trigger an automatic continuation of the same native session. Quota/authentication failures, permission errors, command launch failures/timeouts, malformed results, and scope violations stop the task. The outer task deadline includes all edits, checks and continuations. This budget authorizes those bounded verification repairs as part of the submitted task.

## Receive and integrate

Use the task lifecycle and user-visible collaboration account described in SKILL.md. `workspace TASK` returns the workspace, latest task and execution report. A successful report includes `outcome: verified`, changed files, snapshot hash, and supervisor-recorded command/file checks, exit codes and log paths for every attempt. Git includes a patch; directory mode includes artifact paths, status, byte sizes and SHA-256 hashes (deleted files have no current hash). Checks prove only the declared conditions on that snapshot. Review the original acceptance, including document content or data semantics when appropriate.

`apply TASK` checks the latest verified patch and previews its file list. When integration is within the user's existing authorization, `apply TASK --write` applies it to the original source without staging or committing. It rejects a dirty source, changed source HEAD, a changed tested snapshot, a modified patch, active workers, or an older task. Resolve the reported condition without overwriting user changes or weakening checks. Use another explicit task if the baseline must change.

`followup TASK` reuses the same worktree, model and native session. A follow-up may omit `execution` to inherit the existing write scope and verification; it still supplies goal, acceptance and read_paths. The scope and verification cannot change within that workspace session. Include only changed evidence or a concrete remaining issue. Follow-ups are unavailable after the workspace is applied or discarded.

Cancel retains work and logs. `discard TASK` previews cleanup; `discard TASK --write` removes only AW's owned worktree once all its tasks are terminal. Apply does not delete the worktree. Discard unapplied work only when authorized or clearly disposable under the task. Never remove a project directory or another task's workspace to clean up this task.

## Directory execution: no Git required

Prepare with `prepare --role executor --cwd INPUT_DIR --workspace-mode directory`. The request's `execution.workspace.mode` must also be `directory`; prepare alone does not change a run's mode. Submit `run` using the same cwd and request:

```json
{
  "goal": "Read input.txt and generate a short report and a JSON summary.",
  "acceptance": ["The report and JSON accurately reflect the supplied input."],
  "read_paths": ["input.txt"],
  "execution": {
    "workspace": {"mode": "directory", "target": "temporary"},
    "write_paths": ["out"],
    "checks": [
      {"type": "text", "path": "out/report.md", "contains": ["Summary"]},
      {"type": "json", "path": "out/summary.json"}
    ],
    "max_attempts": 2
  },
  "timeout_seconds": 600
}
```

`target: temporary` is the directory default. AW creates a task-owned output directory under its state directory, copies only `read_paths` preserving their relative layout, and runs the worker there. Source inputs are untouched. Empty `read_paths` is valid when no input files are needed. Select all files required to execute a copied script; AW does not copy the entire project implicitly. Input copies may be edited within write_paths.

For a user-selected existing directory use `run --cwd OUTPUT_DIR` and `workspace: {"mode":"directory","target":"cwd"}`. Its real path is the execution root; no input copy is made and no arbitrary request path can expand it. Existing files inside write_paths cause a preflight stop unless `overwrite: "allow"` is explicitly set. Choose that only when the user's request authorizes those replacements; back up valuable existing content when warranted. Narrow write_paths for new files instead of allowing unnecessary overwrites. AW rejects overlapping active direct-directory tasks within the same host state; it cannot coordinate unrelated programs or separate host state directories.

Directory mode requires at least one `checks` entry or `verification` command. File checks support `file` (exists, regular file, size), `text` (also contains every listed substring) and `json` (also parses). `min_bytes` defaults to 1; text/JSON checks are limited to 16 MiB. These are structural checks, not a substitute for reviewing content. Scripts should have a meaningful run/check command where appropriate. The same-session repair budget applies to failed file checks. Setup/verification argv rules and permissions are shared with Git mode.

Optional `scratch_paths`, e.g. `["node_modules", ".cache"]`, declares disposable dependency/build directories excluded from artifact snapshots. They must be disjoint from write_paths; checks cannot target them. Use them only for task-required scratch output and explicitly authorized setup, never to hide deliverable changes. Directory scanning supports at most 10,000 entries outside scratch/Git metadata; temporary input copies are limited to 128 MiB. Symlinks and special files are rejected. Prefer a small task-specific directory for large inputs.

`result TASK` / `workspace TASK` provides absolute artifact paths. Directory files are already in the reported location: **there is no `apply` step**. Deliver links to the files; transfer them to a project only within the user's task scope. The workspace mode, write/scratch paths, setup and checks stay fixed across follow-ups. AW rejects external changes detected after a verified turn; reconcile before starting another task.

Direct writing has **no automatic rollback**, including failed, cancelled or out-of-scope writes. AW checks deliverable differences; it does not make the directory an OS sandbox or undo command side effects. Cancel retains files/logs. `discard --write` deletes an owned temporary output directory; save accepted deliverables first. For `target: cwd`, discard only closes AW's task and keeps the user directory and its files, without reverting anything. Never describe this as Git-style rollback.
