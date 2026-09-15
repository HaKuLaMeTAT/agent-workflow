# Implementation delegation

Use this mode when the user or project workflow calls for implementation delegation and an enabled `workspace-write` worker is available. v0.4 implements this with Claude file tools and AW-supervised commands on Linux/WSL and native Windows. Other adapters retain their existing read-only capability.

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

These commands run project code with the current OS user's permissions. The worktree and file-tool restrictions are not an OS/network sandbox. Include only commands appropriate to the authorized task; do not use this mode to run untrusted code requiring OS isolation. The worker cannot choose arbitrary shell commands: it has Read/Glob/Grep and scoped Edit/Write; AW runs the declared verification after each editing turn. Authentication and managed CLI policies continue to apply.

`max_attempts` is the total number of model editing turns (1–5; default 2), not extra retries. Test assertion failures can trigger an automatic continuation of the same native session. Quota/authentication failures, permission errors, command launch failures/timeouts, malformed results, and scope violations stop the task. The outer task deadline includes all edits, checks and continuations. This budget authorizes those bounded verification repairs as part of the submitted task.

## Receive and integrate

Use the task lifecycle described in SKILL.md. `workspace TASK` returns the owned workspace, latest task and execution report. A successful execution report includes `outcome: verified`, changed files, patch, snapshot hash, and supervisor-recorded commands, exit codes and log paths for every attempt. This proves those commands passed on that snapshot, not that every product requirement is satisfied. Review the change and the original acceptance conditions.

`apply TASK` checks the latest verified patch and previews its file list. When integration is within the user's existing authorization, `apply TASK --write` applies it to the original source without staging or committing. It rejects a dirty source, changed source HEAD, a changed tested snapshot, a modified patch, active workers, or an older task. Resolve the reported condition without overwriting user changes or weakening checks. Use another explicit task if the baseline must change.

`followup TASK` reuses the same worktree, model and native session. A follow-up may omit `execution` to inherit the existing write scope and verification; it still supplies goal, acceptance and read_paths. The scope and verification cannot change within that workspace session. Include only changed evidence or a concrete remaining issue. Follow-ups are unavailable after the workspace is applied or discarded.

Cancel retains work and logs. `discard TASK` previews cleanup; `discard TASK --write` removes only AW's owned worktree once all its tasks are terminal. Apply does not delete the worktree. Discard unapplied work only when authorized or clearly disposable under the task. Never remove a project directory or another task's workspace to clean up this task.
