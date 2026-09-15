# Main-entry routing

The current Codex conversation is both coordinator and the default basic/main developer. Routine development stays here. Configure external roles mainly for escalation and specialist work. AW's `route` command applies local rules without running a model, launching a worker or changing the conversation model. The installed skill tells the host when/how to call it; there is no background interceptor of every Codex message. Refresh the installed skill and reopen an existing Codex session after upgrading.

## Select one work package

Apply the user's explicit task scope, named role/provider, project skill and established workflow first. Otherwise, when `routing.enabled` is true:

| Task kind / complexity | Default role | Execution workspace |
| --- | --- | --- |
| Reply, one obvious tiny edit | host | Current authorized task |
| Code / simple: localized fix with clear acceptance | developer-basic (host) | Current authorized project |
| Code / standard: several related modules or integration | developer-main (host) | Current authorized project |
| Code / complex: demonstrated difficult failure, unclear root cause | developer-hard | git-worktree |
| Artifact: temporary script, document, file or data output | executor | directory, temporary by default |
| Explicit design / review / analysis | designer / reviewer / analyst-primary | Binding determines host/read-only worker |

The role map is editable under `routing.roles`; role bindings independently choose provider, model, effort, worker/host, access and permissions. Codex, Claude and OpenCode models remain selectable; DSH uses its CLI model IDs. No model name is mandatory. Host bindings need only `enabled: true, execution: host`; no CLI/model/effort is needed. Old host model fields are ignored during resolution and never describe the actual host model. Existing configurations without routing default to disabled. `routing --enable --write` enables it; UI has the same toggle. Configuration changes require the user's setup intent; routine routing never edits bindings.

Call, for example, `route --kind code --complexity simple --cwd DIR`. An `action: worker` selection must still pass `prepare`; `route` is not a capability or account check. For a host selection perform the role in the existing conversation; AW returns null provider/model/effort because it cannot discover or switch this conversation’s model. For `blocked`, explain the missing role/policy condition and continue authorized host work if feasible. Do not quietly choose an unrelated provider or expand permissions.

Workspace choice follows the task, not an error. Use Git isolation for project changes and directory mode for explicitly bounded artifact work. If Git preconditions fail, report why. Do not silently retry against the original directory. A user can explicitly choose direct directory writing to a project; describe overwrite and recovery behavior first and stay within existing authorization.

## Bound the work and escalation

Hand off the relevant files, expected output, acceptance and known failed attempts. Let a writable worker read, edit and receive AW checks in one native session. Do useful independent coordination while it runs; do not solve the same package in parallel. No routine design/review committee or recursive worker delegation. Reuse existing evidence and only open detailed result pages for material missing information.

`execution.max_attempts` bounds model turns within a submitted writable task (default 2). On correctable assertion/file-check failure AW resumes that session automatically. The host must announce this budget before dispatch or include it in the assignment description, then report actual turns from the execution report.

After exhausted implementation/verification failures, pass the actual count using `route --failed-attempts N` and the currently assigned complexity. At `routing.escalate_after` (default 2), simple code moves to the configured standard role (skipping to complex when standard is the same host), standard moves to complex, and complex/artifact work returns to host judgment. Announce the specific failure and newly selected role before submitting. Quota/authentication/permission failures, launch errors, timeouts, malformed results and scope violations are operational stops, **not** a reason for automatic model/provider escalation. Investigate without paid retries; use an explicit recovery/follow-up when authorized.

Pass `--delegations N` with the actual number of submitted task turns for this work package (including explicit follow-ups). Default `routing.max_delegations` is 3. At the limit inspect existing evidence and resolve or report the blocker; do not re-label the same package to reset the budget. This is a host routing rule, not a global server-side spending limit. Independent `run` and explicit user work can still submit tasks. Do not claim measured token savings; usage accounting and feedback compaction are separate work.

For Git escalation, keep earlier changes/logs for diagnosis and give the next worker relevant evidence against an explicit baseline. AW does not transfer a native session between providers or automatically stack worktrees. For direct directory escalation, inspect partially written files first and explicitly decide the next scope/overwrite policy. Never discard another task's work to unblock a new worker.

## User-visible record

Follow SKILL.md's pre-call announcement, escalation explanation and final collaboration account. Use stored `dispatch` snapshots even if live bindings changed later. `provider_turns` counts launched CLI execution attempts when known; it is not an API request count or token total. A null observation means unreported, not a confirmed configured value. State incomplete/failed contributions accurately; the host owns acceptance and integration.
