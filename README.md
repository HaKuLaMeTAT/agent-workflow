# Agent Workflow

以 Codex App / Codex CLI 为主入口，默认承担基础和日常主力开发；按需调用本地 AI CLI 完成攻坚升级、专项执行、方案设计、独立审查和交叉分析。辅助任务拥有独立上下文，主任务先读取摘要，再按需读取证据。

Agent Workflow（`aw`）参考 Paseo 的角色与 provider 分离方式，复用 ai-cli-mcp 的后台执行层。当前为 **v0.4.5**，支持 Linux / WSL 和原生 Windows 10/11。仓库可放在任意可读写目录，安装后 Codex 自动发现 Skill，并通过登记的入口定位仓库。

## 功能

- **跨平台部署**：Windows 支持 `.exe` / npm `.cmd` 入口、用户配置目录、文件锁及后台任务树清理。
- **任意安装路径**：支持空格、中文目录；Codex 入口不依赖 PATH 或手动设置 `AW_ROOT`，移动仓库后可重新登记。
- **按主机配置角色**：职责与 CLI、模型、推理档位分离，可在不同电脑使用不同绑定。
- **本地配置界面**：`aw ui` 查看职责、编辑绑定、预览差异并保存；新任务读取更新后的配置。
- **多 CLI 适配**：Claude Code、Codex、OpenCode，以及 ACP 兼容 CLI（包括 DSH）。
- **完整执行任务**：Claude、Codex、OpenCode、DSH / ACP 在 Git worktree 或明确目录中读写，AW 运行声明的检查，并在预算内续用原会话修复。
- **任务交接与接收**：携带当前状态、失败尝试和验收条件；检查实际差异与测试记录后接收，工作区单独清理。
- **主控调度**：日常开发默认由主入口承担；按任务或失败证据选择已配置的升级/专项角色，尊重项目工作流。
- **调度说明**：调用前说明角色、CLI/模型和任务；最终交付说明实际参与者、贡献、修复和验收，执行记录提供依据。
- **可恢复任务**：后台执行、状态查询、取消、原生会话续接和幂等请求。
- **有界结果**：默认摘要包含审计结论、阻塞项、未验证项及证据引用，详细结果分页读取。

工具使用 Node.js 与 `cross-spawn`，没有独立的常驻 daemon、relay 或数据库。`aw ui` 仅在命令运行期间开放本机回环端口。

## v0.4.5：网页模型与档位选择

模型和推理档位改为可编辑选择框：点击箭头显示完整目录，输入文字筛选候选或填写自定义值，不再被当前值过滤到只剩自己。支持鼠标、方向键、回车、Escape 和“不指定”档位，选择结果仍经预览后保存。更新后需重启 `aw ui` 并打开新链接。

## v0.4.4：修复 OpenCode 受限目录写入

- OpenCode 权限按实际项目根目录生成，覆盖 Windows 非 Git 临时目录、Git 子目录和 linked worktree；仍只授权声明路径。
- 范围内尚未创建的文件记录为 `read_target_missing`，不误报读取越界；遇到原生权限拒绝立即停止后续重试，保留首个原因和已报告用量。
- OpenCode restricted 模式使用 `read` 读取声明文件/目录；关闭无法按目录约束的 `glob/grep/list`。模型、档位及 full-access 配置保持可选。

详见 [升级与验收](docs/INSTALL.md#v044-升级) 和 [读取边界](docs/WORKER_LIMITS.md#opencode-受限路径v044)。

## v0.4.3：控制 worker 消耗

- 所有后端使用统一的单层交付契约；AW 本地恢复明确的 JSON 外包装，保留严格验收。
- 模型步骤、工具、输出、CLI 次数、执行时长和读取量共用工作包预算，续接不能重置。
- 只读任务默认提供限定文本证据，可选行范围；可写任务保留原生执行。需要自主读取时显式选 native，并核对后端的约束能力。
- 失败、超时、取消和修正过程保留已报告用量；未报告的 token 是未知。

详见 [预算、读取范围与恢复](docs/WORKER_LIMITS.md)。模型和 effort 仍自由配置；本轮未用真实模型对照宣称节省比例。

## 安装与起步

需要 Node.js **22.12+**、npm，以及已安装并登录的目标 AI CLI。Linux / WSL 需要 `flock`；Windows 使用系统自带的 Windows PowerShell 5.1，不需要 WSL 或管理员权限。

先按 [安装说明](docs/INSTALL.md) 准备固定版本的运行时和本机配置。安装完成后：

```bash
aw roles
aw ui
aw models claude-local --refresh
aw prepare --role reviewer --cwd /absolute/project
```

`roles` 和 `ui` 不启动模型任务。`prepare` 检查有效绑定与运行能力，但不提交分析任务。CLI 版本、登录状态、模型目录或主机策略不兼容时会返回明确诊断；配置存在不等于模型实际可用。

## 本地配置界面

```bash
aw ui
# 可选：指定本机端口或另一份主机配置
aw ui --port 43121 --host-config /absolute/private/host.json
```

在本机浏览器打开命令输出的完整链接，可修改已有角色的 CLI、模型、推理档位、执行位置、写入能力、权限策略及启停状态，并查看职责文本。支持多角色草稿、保存前差异预览、配置校验与版本冲突保护。

建议优先配置攻坚升级、设计、审查、复核分析和专项执行。主入口角色不需要模型绑定，页面隐藏其外部模型字段；可显式切换为 worker 再配置。自动调度开关也支持预览、保存与冲突保护。

外部角色首先显示配置中的模型；“读取模型目录”调用目标 CLI 的目录探测。无草稿时自动读取外部配置变化，有草稿时保留修改并提示冲突。可手动输入模型 ID 与档位，勾选“将所选模型与档位加入允许列表”后一起预览、保存。新增角色、CLI 和职责文本通过配置文件维护。

界面仅监听 `127.0.0.1`，默认选择空闲端口，`Ctrl+C` 关闭。访问链接包含本次启动的凭据，不应分享。没有远程访问或自启；其他电脑不能直接使用这个回环地址。

## 角色与配置

配置分为三层：

| 层级 | 内容 | 示例 |
| --- | --- | --- |
| 共享角色 | 职责、权限上限、默认执行位置和结果格式 | [roles.json](config/roles.json)、[角色文件](roles/) |
| 主机绑定 | CLI、模型、推理档位、执行位置与启停状态 | [home 模板](config/home.example.json)、[office 模板](config/office.example.json) |
| 项目工作流 | 允许使用的角色、项目指令和工作流名称映射 | [project.example.json](config/project.example.json) |

预设名称 `home` 和 `office` 分别提供 Codex / Claude 与 OpenCode / ACP / Codex 的配置示例。模型名称和档位仅作示例，使用前应按自己的 CLI 目录核对。实际配置不要提交到版本库。

默认主机配置在 Linux / WSL 上是 `~/.config/agent-workflow/host.json`，Windows 上是 `%LOCALAPPDATA%/agent-workflow/host.json`，可用 `AW_HOST_CONFIG` 或 `--host-config FILE` 覆盖。命令行也可编辑绑定：

```bash
aw configure --role reviewer --provider claude-local \
  --model claude-sonnet-5 --effort high --execution worker
# 核对预览后，在同一命令末尾加 --write 保存。
```

`configure` 默认只输出预览。没有推理档位时使用 `--no-effort`；`--effort none` 表示后端真正的 `none` 选项。`providers[].models` 可省略以使用发现目录；填写时作为主机允许列表。`configure --allow-model` 会将本次所选模型与档位加入该列表，保留其他条目；这不代表服务端已验证可用。

`host` 角色由当前主对话承担，**不需要另绑 CLI、模型或档位**；AW 无法识别或切换当前会话的模型，解析时返回 null，不将旧配置当作实际主入口模型。`developer-basic` 和 `developer-main` 默认都是 host。`worker` 的权限由角色和绑定决定；顾问/审查保持只读，攻坚与专项执行可写。将旧 host 开发角色显式改为 worker 时仍默认只读；同时配置 `--access workspace-write` 可启用完整执行路径。

保存后，新任务读取新绑定。已有任务保持原生会话及创建时的模型、档位；切换 provider 后，旧会话可能不能继续追问。

### 自选模型与执行权限

Codex 和其他 CLI 一样可在 UI 中选择模型或手动输入 ID，推理档位随所选模型更新。Codex 默认模板不设置模型允许列表，不固定为 Luna；旧配置中的允许列表可显式扩充，或删除 provider 的 `models` 字段以取消该列表。CLI 缓存只是候选目录，缓存外手填的 Codex 模型会交给实际调用验证。

例如将 executor 绑定到一个 Codex 快速模型（Luna 仅为示例）：

```text
aw configure --role executor --provider codex-local --model gpt-5.6-luna --effort low --access workspace-write --permissions full-access --allow-model
```

检查输出后加 `--write` 保存；也可在 `aw ui` 中完成。要保留限制，选择 `--permissions restricted`。`gpt-5.6-luna` 是模型 ID；是否可用由本机 CLI 和账户决定。Codex worker 使用同一账户时仍会消耗 Codex 额度，此功能不承诺总 token 节省。

| adapter | `restricted`（默认） | `full-access`（显式配置） |
| --- | --- | --- |
| Claude | 限定读写工具及写入路径 | 文件、Bash / PowerShell、网页工具，跳过 CLI 权限询问 |
| Codex | 原生 workspace-write 沙箱，禁用网络；交付后校验写入范围 | danger-full-access，允许本机命令与网络 |
| OpenCode | 限定 edit 路径，禁止终端及外部目录 | 原生工具与命令；禁用 task、question、skill |
| DSH / ACP | 客户端文件读写与路径权限；DSH 关联工具元数据 | 文件与终端能力、原生命令；未知 DSH 插件仍拒绝 |

两档都执行声明的验收命令、保留会话续接预算，并检查可接收的改动。完整权限仅适用于可写 implementation 角色；配置和权限在任务创建时固定，已有会话不会被重新配置扩大权限。CLI 管理员策略仍然适用，AW 不会在受限模式失败时自动放开权限。

## 主入口自动调度

新 `home` 模板启用调度，基础/主力开发和主分析由当前会话承担，外部配置集中在攻坚、专项执行、设计、审查和复核。`office` 的外部角色与调度初始关闭，按本机 CLI 目录配置后开启。已有安装升级保留绑定和开关；没有 `routing` 的旧配置默认关闭。

```text
aw routing
aw routing --enable --write
aw route --kind code --complexity standard --cwd "项目目录"
aw route --kind code --complexity standard --failed-attempts 2 --cwd "项目目录"
aw route --kind artifact --cwd "输入目录"
```

`route` 根据主控给出的任务类型、难度和实际失败次数查本地规则，不另花模型额度分类，也不直接启动任务。普通开发留在 host；明确难点或达到失败阈值时转向已配置攻坚角色。主控再 prepare/run 并解释分工。用户明确指定的角色、项目 Skill 和工作流优先；不会因认证、额度或权限错误自动换模型。映射、升级阈值和单个工作包委派上限可配置，详见 [主控规则](skills/agent-workflow/references/routing.md)。

这依赖 Codex 加载安装后的 Skill 并遵循规则，不是拦截所有消息的后台服务。更新登记后，旧 Codex 会话建议重新打开。

`run/status/result` 的 `dispatch` 提供角色、CLI、请求模型/档位、CLI 报告模型/档位、任务目的和已知执行轮次。未报告字段为 null；执行轮次不等于 API 请求数或 token 用量。Skill 要求最终回复说明实际调用与主控验收，不能只报执行结果。

## 完整执行任务

启用 executor 后，参考 [执行交接格式](skills/agent-workflow/references/execution.md) 提交 `execution.write_paths`、验证命令和轮次预算。支持干净 Git 基线、可选的显式依赖准备、同会话修复、测试快照核对，以及新文件/删除/二进制补丁。源目录、安装目录和任务状态目录可以各自独立。

```text
aw configure --role executor --provider claude-local --model claude-sonnet-5 --effort high --write
aw prepare --role executor --cwd "项目目录"
aw run --role executor --cwd "项目目录" --request-file "请求文件" --request-id implementation-001
aw wait TASK_ID --timeout 45
aw workspace TASK_ID
aw apply TASK_ID
aw apply TASK_ID --write
aw discard TASK_ID --write
```

`apply` 默认检查并预览；`--write` 才应用，不暂存或提交。`discard --write` 删除已无活动任务的自有 worktree，应在变更已接收或明确放弃后执行。准备步骤只运行一次；断言失败可以在 `max_attempts` 内续用对应 CLI 原会话修复，认证、额度、权限、超时和范围错误直接停止。

### 非 Git 的文件任务

| 模式 | 适用范围 | 交付方式 |
| --- | --- | --- |
| `git-worktree`（默认） | 正式项目开发、修复 | 检查补丁，再 apply 到原项目 |
| `directory` | 临时脚本、文档、数据整理 | 直接交付已验证文件，不走 apply |

目录模式默认创建任务专属临时目录，只复制指定输入；也可显式 `target: cwd` 在指定目录写入。原目录覆盖需显式 `overwrite: allow`。支持存在性、文本与 JSON 检查，或脚本运行命令，不强制文档任务跑代码测试。没有 Git 前提，也不会在 Git 出错时静默改用原目录。

目录写入没有自动回滚，取消保留文件；discard 只删除任务自有临时目录，对用户目录只关闭任务。目录和完整权限命令不构成操作系统沙箱。请求样例、产物路径和清理规则见 [执行交接格式](skills/agent-workflow/references/execution.md)。

Windows 迁移及已有安装升级见 [安装说明](docs/INSTALL.md)。两种模式覆盖全部五种 adapter，并保留只读模式。用量统计、反馈精简和 token 节省对照评估留待后续阶段；执行结果中的现有 usage 只代表最后一次 provider 调用。

## 提交与恢复任务

在项目根目录添加 `agent-workflow.json`，按示例映射角色，然后准备请求文件：

```json
{
  "goal": "独立核对指定接口的输入合同。",
  "acceptance": ["缺失输入返回明确错误。", "现有调用方保持兼容。"],
  "read_paths": ["src/input.mjs"],
  "evidence": ["必要的验证记录位置"],
  "stage": "independent",
  "source": "manual-review",
  "timeout_seconds": 600
}
```

```bash
aw prepare --workflow review --cwd /absolute/project
aw run --workflow review --cwd /absolute/project \
  --request-file /absolute/private/review.json --request-id review-001
aw wait TASK_ID --timeout 45
aw result TASK_ID
aw result TASK_ID --cursor 0
aw followup TASK_ID --request-file /absolute/private/followup.json --request-id review-002
aw recover TASK_ID
aw cancel TASK_ID
```

相同 `source + request-id` 和输入返回同一任务，输入不同则报冲突。调用端退出或等待超时不会取消后台任务。续接使用新 request ID，同一原生会话不会并发执行或自动分叉。

`completed` 表示进程与结果合同完成，不代表审计通过。审计结果有关键未验证项或 blocker 时不能判为 `pass`。失败、超时或取消后，仅在保留可恢复会话时支持显式续接；`unknown` 仍占并发槽位，不会自动重复提交或判为失败。

[调用 Skill](skills/agent-workflow/SKILL.md) 可指导主任务使用已配置工作流。普通小改不自动触发全套设计和审查；其他项目需自己的工作流映射。

## 权限、数据与验证范围

项目角色限制按祖先目录逐层收紧，子目录不能扩大权限。请求文件不能覆盖 executable、认证或权限参数。只读辅助任务交付分析与建议。executor 默认使用受限权限，AW 运行请求声明的准备/验证命令；可显式选择完整权限以开放 CLI 的文件、命令和网络能力。角色仍作为叶子任务运行。完整权限下命令以当前用户权限执行，worktree 不提供操作系统或网络沙箱，`write_paths` 仅约束可接收的交付差异，不能阻止工作区外的副作用。

各 adapter 的 CLI 工具限制不等于统一的操作系统沙箱。目录探测、协议测试和格式正确的结果不能证明所有后端的真实权限行为或回答质量。登录、额度、管理员策略及模型可用性需在目标环境中核对。

任务与原始日志在 Linux / WSL 上留在 `~/.local/state/agent-workflow/<host-id>/`，Windows 上留在 `%LOCALAPPDATA%/agent-workflow/state/<host-id>/`，凭据由各 CLI 管理。模型元数据缓存 10 分钟，可通过 `--refresh` 刷新。任务记录上限为 2,000 个，单份 transcript 上限为 16 MiB；超过时显式报错并保留记录，不自动批量清理。

```bash
npm run check
npm test
# 使用未修改的上游包执行核心进程集成：
AW_TEST_UPSTREAM=/path/to/unmodified/ai-cli-mcp-2.25.0 npm test
```

测试覆盖关键配置/请求/结果合同、本地 HTTP 保存与冲突处理、跨平台安装与移动后登记，以及真实 runner、文件系统和进程锁。外部 AI CLI 用可控协议进程隔离；没有提供上游包时，相关进程测试会明确标为 skipped。可选的真实模型验收见安装说明，执行会使用对应模型额度。

这些测试使用可控 CLI 验证 Windows 与 Linux 的执行链；真实模型质量、不同主机的连续使用及额度节省效果不由这些测试保证。本轮 UI 已验证 HTTP 合同和原生 Windows Edge 的保存交互、主入口字段及窄屏布局。

## 引用与许可证

| 项目 | 参考版本 | 使用方式 |
| --- | --- | --- |
| [Paseo](https://github.com/getpaseo/paseo) | v0.8.0 | 参考角色/provider 分离、能力目录和会话生命周期；未复制源码，不依赖 daemon/relay |
| [ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp) | v2.25.0 | 复用后台执行服务，分发派生 runner 和最小服务补丁 |
| [Sub-Agents Skills](https://github.com/shinpr/sub-agents-skills) | 角色文件组织方式 | 仅作工作流参考，未复制 Skill/prompt |
| [DSH ACP 指南](https://gist.github.com/robbin/b0b3cc024d88235b1ebeecce5499b5e8) | ACP 接入示例 | 参考协议接入方式，未复制指南代码 |

版本、文件摘要及派生文件说明见 [UPSTREAM.md](docs/UPSTREAM.md)。上游 MIT 版权声明完整保留于 [LICENSE.ai-cli-mcp](patches/LICENSE.ai-cli-mcp)。自有代码采用 [MIT License](LICENSE)；本工具非上述项目、OpenAI 或 Anthropic 官方产品。
