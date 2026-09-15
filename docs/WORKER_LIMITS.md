# v0.4.3：交付、预算与读取范围

这些控制适用于 AW 启动的 Claude、Codex、OpenCode、DSH / ACP worker，独立于所选模型。当前主对话不经过 AW worker 进程，AW 不限制或切换主对话的模型。

## 结构化交付

模型按单层 JSON 契约生成报告，AW 在本地转换为原有 `summary/findings/evidence_refs/uncertainties/payload` 结果格式。Claude、Codex 使用原生 schema，OpenCode、ACP 在提示中收到同一契约。验收语义保持严格：存在 blocker 或未验证项的审查不能标为 pass。

对明确的单一 `parameter`、`parameters`、`result`、`payload` 外包装，AW 可以在本地解包并校验；歧义、冲突或缺失内容不能自动补造。Claude 的 StructuredOutput 被拒绝时，如果工具参数可在本地恢复且通过校验，AW 停止该 CLI 并接收报告；无法恢复则停止并保留失败证据。不会新增一个格式修复模型任务。CLI 已经发出的在途请求仍可能产生消耗。

`result.delivery.local_repairs` 记录本地恢复，`aw_model_retries: 0` 只表示 AW 没有为了格式重发模型任务，不代表上游 CLI/服务没有内部重试。`completed` 仍须结合审查 verdict 和验证结果判断是否验收通过。

## 共用执行预算

默认值如下；所有数值都可以配置，不绑定某个模型或 effort。

| 字段 | 默认值 | 范围 |
|---|---:|---|
| `max_model_turns` | 24 | 已报告的模型步骤；各 CLI 观测口径不同 |
| `max_tool_calls` | 48 | 已报告的工具调用，按调用 ID 去重 |
| `max_output_tokens` | 32,000 | 已报告输出 token；不是订阅额度百分比 |
| `max_provider_calls` | 4 | 真正启动的 CLI 次数，包含修正和 followup |
| `max_duration_seconds` | 1,200 | CLI 执行时长累计，单位秒 |
| `max_read_bytes` | 131,072 | 单份证据或可观测工具返回上限，单位字节 |
| `max_total_read_bytes` | 262,144 | 工作包累计提供/观测到的读取量，单位字节 |

主机 `budget` 设置默认值，`bindings.<role>.budget` 覆盖角色值；请求中的 `budget` 可以进一步降低限制。初次提交形成工作包，同一原生会话的显式 followup 和可写 worker 内部修正共同扣减预算。followup 不得提高或重置已固定的限制；不得用换 request ID 的方式绕过已耗尽的同一工作包。

`execution.max_attempts` 仍限制一项可写任务的“修改→验证→修正”次数。它与工作包预算同时生效，不等于 CLI 内部模型步骤上限。任务 `timeout_seconds` 仍限制当前任务，包括准备及验证；工作包时长预算累计的是 worker CLI 执行时间。

### 配置入口

`aw ui` 中展开角色的“执行预算与读取范围”，可以预览并保存。也可以使用 CLI：

```bash
# worker-budget.json 是预算覆盖对象，例如 {"max_model_turns":12,"max_output_tokens":16000}
aw configure --role reviewer --budget-file worker-budget.json --read-mode evidence
# 核对预览后保存
aw configure --role reviewer --budget-file worker-budget.json --read-mode evidence --write
```

角色配置不改变模型和 effort 的选择方式，Codex 的自定义模型 ID 仍可使用。

### 实际强制能力

| 后端 | 模型步骤限制 | 读取范围 |
|---|---|---|
| Claude | 原生 `--max-turns` + AW 事件监控 | 证据模式关闭文件工具；原生模式越界在工具事件到达后停止 |
| Codex | AW 监控可见回复、工具输出和时长；隐藏模型轮数无法完整统计 | 证据模式关闭 shell、统一执行、图片读取和隐式项目文档加载；原生 shell 的 `read_paths` 不构成文件白名单 |
| OpenCode | 原生 agent `steps` + AW 事件监控 | 证据模式拒绝工具；原生模式按路径配置读取权限，并监控事件 |
| DSH / ACP | AW 监控响应块、工具调用和时长；服务未报告的 token 保持未知 | 客户端按路径检查文件请求；证据模式禁用文件能力并拒绝工具权限；agent 原生工具必须遵守 ACP 协议 |

`prepare.controls` 明确显示这些差异。AW 不能拦截供应商所有内部请求；事件式上限可能在一条回复完成后才被发现，因此可能超过阈值。达到上限时终止后续工作、保留日志和部分结果，不承诺精确计费硬上限。目录、worktree、事件监控均不等于 OS 沙箱。

原生参数依据：[Claude CLI](https://code.claude.com/docs/en/cli-reference)、[OpenCode agent steps](https://opencode.ai/docs/agents/#max-steps)、[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。各安装版本仍应通过 `prepare` 检查；协议回归不能代替真实模型的质量对照。

## 读取证据

### 默认只读：evidence

AW 在发起模型任务前读取明确列出的 UTF-8 文件，将内容与来源、行范围、SHA-256 一起提供给 worker，并保存 `evidence.json`。模型不能继续自行扫描仓库；材料不足时应报告缺口。

```json
{
  "goal": "复核本次接口修复，指出仍有证据支持的问题",
  "acceptance": ["覆盖已修改接口和给出的运行记录"],
  "read_paths": ["src/api.mjs", "verification.txt"],
  "read_ranges": [{"path":"src/api.mjs","start_line":20,"end_line":100}],
  "budget": {"max_output_tokens":12000},
  "source": "interface-review"
}
```

`read_ranges` 为包含首尾的、从 1 开始的行号；每个文件最多一个范围。未指定范围时提供整个文件。文件或证据包超限会在模型启动前报错，不静默截断；目录和二进制文件需要明确选择文件/片段，或使用原生模式。行范围扫描的源文件最大为 64 MiB；更大的日志应先生成有界片段。

提供准确 diff、必要源码片段和已有验证记录。续接只提供变化的证据和实质分歧，避免再次提交同一批完整文件。

### 自主探索与可写任务：native

确需自主检索或读取二进制证据时，在任务中显式设置 `"read_mode":"native"`，或配置角色默认值。AW 不因证据包失败而自动切换。native 在各 CLI 上的强制能力不同，参见上表。

可写任务继续使用原生文件工具，`git-worktree` / `directory`、验证、补丁应用机制保持原用途。声明需要读取的输入和允许修改的路径；需要再次读取旧输入的 followup 也应声明它。写入范围可供读取新产物。ACP 文件接口在返回内容前检查路径；原生 CLI/agent 工具仍有各自权限边界。

同一原生会话固定读取模式。旧版本会话按 native 处理，续接时显式传 `read_mode: native`，以免把已接触原生工具和其他文件的会话当成全新的证据模式任务。

## 失败用量和恢复

`status`、`result` 在成功、失败、超时和取消时都返回可用的 `usage`、`usage_complete` 和 telemetry。任务目录内：

- `usage.json`：当前任务各次 CLI 执行的已报告用量合计，包含预算停止原因；工作包剩余预算还扣除了此前 followup。
- `telemetry.json` / `attempt-N/telemetry.json`：单次 CLI 的持续记录，主控退出后仍由 guard 写入。
- `observation.json`：AW 验收之前的原始观察，包括已解析的部分报告；明确标记 `accepted: false`，不能直接应用。
- `stdout.log` 等原始日志继续保留；仅通过完整验收的任务写成功 `result.json`。

Claude 按消息 ID 合并流式重复项，有最终 usage 时采用最终值，否则标记 partial；OpenCode 累加各步骤用量；可写任务汇总所有修正次数；ACP 未报告时返回 null，context usage 不冒充计费 token。

思考 token 单独展示；Claude 的思考 token 已包含在输出中，不再相加。缓存输入分别保留。计数器是可观测量的下界，剩余 token 预算也是基于已报告量计算；`usage_complete: false` 时不能将它解释为精确剩余额度。Claude quota 事件保留窗口标识，账号其他入口也会影响这些读数。

新任务开始使用上述留存机制；历史中断日志不保证有完整 token 记录。预算耗尽、权限、认证、额度、超时及无法恢复的交付错误都不触发自动换模型或付费重提。检查已有结果后，由主控决定缩小范围、收尾，或依据用户意图调整后续工作预算。

## 本版验证

Linux / WSL 与原生 Windows 的 55 项回归覆盖安装迁移、角色配置、各 CLI 协议、目录/worktree 执行、会话续接和预算控制。安装版本断言与末尾无换行事件修正后，对两平台的安装和 worker policy 测试进行了复测，均通过。Windows Edge 另行验证主入口表单、自由模型 ID、调度开关、预算/读取模式预览保存，以及移动端布局。

上述执行测试使用本地协议样例，没有提交真实模型任务。它们验证控制与记录机制；交付质量、供应商实际内部调用行为和订阅额度节省比例仍需后续真实任务对照。
