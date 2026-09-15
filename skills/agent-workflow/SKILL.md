---
name: agent-workflow
description: Delegate a bounded design, independent review, or peer analysis to a configured local AI CLI through Agent Workflow when the user requests collaboration or an established project workflow calls for it. Ordinary development does not automatically start workers.
---

<!-- installation -->

Use the installed entrypoint above when present. Otherwise run `node` with the absolute path to [aw.mjs](aw.mjs) beside this SKILL.md; locate it relative to this skill's path, not the current working directory. It resolves the registered checkout and host file. `AW_ROOT` overrides the checkout; `AW_HOST_CONFIG` or `--host-config FILE` overrides the host file. Defaults are `~/.config/agent-workflow/host.json` on Linux/WSL and `%LOCALAPPDATA%/agent-workflow/host.json` on Windows. Do not install or enable providers implicitly.

Use `prepare --workflow NAME --cwd PROJECT` when the project has an established workflow mapping; otherwise use `prepare --role ROLE --cwd PROJECT`. It returns the effective binding and only that role's instructions plus applicable project instructions. Follow the returned instructions in the current task for a host role; for a runnable worker role, submit with the same workflow or role. Do not reread every role or the design documents. `roles` gives compact choices when selection is needed.

Bindings determine execution location. A host role stays in the current agent and does not change its model setting; a worker role uses its configured CLI and native session. A worker is read-only and cannot implement file changes, even if its display name contains developer. `providers` and `models PROVIDER --refresh` diagnose a missing capability or stale catalog. Configured model names are not proof of server support. Do not change bindings, install a profile, loosen permissions, or switch a paid provider merely to make a task runnable.

Submit a JSON request file in the project's existing run/cache directory or a private temporary directory. Required fields: `goal`, `acceptance` (nonempty string array), `read_paths` (paths within cwd). Optional: `evidence` (reference strings), `stage` (`independent` or `cross-review`), `source`, `timeout_seconds`. Send bounded evidence, not full chat history. Use a stable request ID for retries of the same intent.

`run --role ROLE` or `run --workflow NAME`, together with `--cwd PROJECT --request-file FILE --request-id ID`, returns a task ID. Persist it with the current task. `wait TASK --timeout 45` is bounded; a wait timeout does not cancel the worker. Continue independent work when appropriate. `result TASK` returns a summary, verdict, unverified checks, counts and a report reference; use `--cursor 0` and subsequent cursors only for relevant missing detail. A completed task with verdict incomplete/fail is not an approving review. Blockers, unverified checks and uncertainty counts must affect acceptance.

`followup TASK --request-file FILE --request-id NEW_ID` explicitly continues the stored provider session, role and model, including a failed turn that retained a resumable handle. Send only changed evidence or specific disputes. Use `recover TASK` for an unknown/interrupted attempt. Unknown still occupies a worker slot; do not submit the same intent under a new ID automatically. `cancel TASK` retains artifacts and can record cancellation before a late launch receipt arrives. No automatic quota retries or session forks.

For complex design, request constraints, tradeoffs and acceptance conditions, then implement in the host. Reviewers independently check those conditions; read-only workers cannot run tests, so the host performs required execution checks and supplies their evidence. Ordinary small changes do not require a design/review round.

For an established dual-analysis workflow, freeze the host's initial judgment, send the peer only common evidence first, then make one focused cross-review of material premises. The host produces the final conclusion under the original project skill. No trading authority is introduced.
