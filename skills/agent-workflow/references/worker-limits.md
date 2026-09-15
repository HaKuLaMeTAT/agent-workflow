# Worker evidence, budget and recovery

`prepare` exposes the selected role's budget, read mode and actual control limitations. The model/effort remains the user's selection. Host roles do not enter this worker control path.

Read-only workers default to a bounded evidence bundle. `read_paths` names individual UTF-8 files. Use `read_ranges: [{path: "src/api.mjs", start_line: 20, end_line: 100}]` for a large file; line numbers are inclusive and start at 1. Provide only required evidence and verification. No file tools are available in this mode; an evidence gap is a legitimate incomplete result. The task stores a manifest and hashes in `evidence.json`.

For required autonomous exploration or binary input, explicitly use `read_mode: native`. Writable workers always use native tools. Native file enforcement is strongest in AW-served ACP file requests; other tools may only be observed after execution. Codex native shell reads do not have a strict read_paths allowlist. Never claim that cwd, worktree or monitoring is an OS sandbox. A native continuation keeps its read mode; pre-v0.4.3 sessions require explicit native mode.

Optional request `budget` lowers any configured limit: `max_model_turns`, `max_tool_calls`, `max_output_tokens`, `max_provider_calls`, `max_duration_seconds`, `max_read_bytes`, `max_total_read_bytes`. Defaults are 24 steps, 48 tool calls, 32,000 output tokens, 4 CLI calls, 1,200 seconds, 131,072 bytes per read and 262,144 total read bytes. The same work package shares them across explicit followups and automatic verification repairs. Role/host configuration can set different defaults. Requests and followups cannot raise their fixed work-package limits.

On `budget_exhausted`, inspect `usage.json`, `observation.json` and already generated artifacts. `observation.json` is unaccepted provider output; a stopped implementation cannot be applied. Do not reset the budget by renaming the same work. Narrow subsequent scope or discuss a material budget change with the user in context; do not repeatedly seek permission already granted.

Tokens and cost may be unreported or partial, especially after interruption. Use `usage_complete` and `usage_source`; internal counters are observed lower bounds. CLI-internal rounds are not fully visible on every backend, and an in-flight request can exceed a threshold. Report the actual roles/models, attempted work, local format recovery and any budget/permission/format stop. Do not claim a measured percentage saving without a task-matched comparison.
