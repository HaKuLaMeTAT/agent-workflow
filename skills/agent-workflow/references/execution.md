# Implementation delegation

Use this mode when the user or project workflow calls for implementation delegation and an enabled `workspace-write` worker is available. v0.4.1 supports Claude, Codex, OpenCode, DSH and ACP on Linux/WSL and native Windows, subject to the installed CLI capabilities. Existing read-only modes remain available.

## Prepare one complete work package

Use `prepare --role executor --cwd PROJECT` or an established workflow. Start from a clean, committed Git source; AW does not stash or silently omit uncommitted/untracked files. Keep the request file outside the source or in an ignored directory. Execution currently excludes repositories with tracked symlinks/submodules. AW's state directory must be outside the target repository.

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

Use the task lifecycle described in SKILL.md. `workspace TASK` returns the owned workspace, latest task and execution report. A successful execution report includes `outcome: verified`, changed files, patch, snapshot hash, and supervisor-recorded commands, exit codes and log paths for every attempt. This proves those commands passed on that snapshot, not that every product requirement is satisfied. Review the change and the original acceptance conditions.

`apply TASK` checks the latest verified patch and previews its file list. When integration is within the user's existing authorization, `apply TASK --write` applies it to the original source without staging or committing. It rejects a dirty source, changed source HEAD, a changed tested snapshot, a modified patch, active workers, or an older task. Resolve the reported condition without overwriting user changes or weakening checks. Use another explicit task if the baseline must change.

`followup TASK` reuses the same worktree, model and native session. A follow-up may omit `execution` to inherit the existing write scope and verification; it still supplies goal, acceptance and read_paths. The scope and verification cannot change within that workspace session. Include only changed evidence or a concrete remaining issue. Follow-ups are unavailable after the workspace is applied or discarded.

Cancel retains work and logs. `discard TASK` previews cleanup; `discard TASK --write` removes only AW's owned worktree once all its tasks are terminal. Apply does not delete the worktree. Discard unapplied work only when authorized or clearly disposable under the task. Never remove a project directory or another task's workspace to clean up this task.
