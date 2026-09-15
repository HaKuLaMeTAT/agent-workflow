# Agent Workflow

以 Codex App / Codex CLI 为主入口，调用可配置的本地 AI CLI 完成方案设计、独立审查和交叉分析。辅助任务拥有独立上下文，主任务先读取摘要，再按需读取证据。

Agent Workflow（`aw`）参考 Paseo 的角色与 provider 分离方式，复用 ai-cli-mcp 的后台执行层。当前为 **v0.3**，支持 Linux / WSL 和原生 Windows 10/11。仓库可放在任意可读写目录，安装后 Codex 自动发现 Skill，并通过登记的入口定位仓库。

## 功能

- **跨平台部署**：Windows 支持 `.exe` / npm `.cmd` 入口、用户配置目录、文件锁及后台任务树清理。
- **任意安装路径**：支持空格、中文目录；Codex 入口不依赖 PATH 或手动设置 `AW_ROOT`，移动仓库后可重新登记。
- **按主机配置角色**：职责与 CLI、模型、推理档位分离，可在不同电脑使用不同绑定。
- **本地配置界面**：`aw ui` 查看职责、编辑绑定、预览差异并保存；新任务读取更新后的配置。
- **多 CLI 适配**：Claude Code、Codex、OpenCode，以及 ACP 兼容 CLI（包括 DSH）。
- **显式协作**：按角色或项目工作流分派只读辅助任务；不自动切换模型、重试付费调用或递归委派。
- **可恢复任务**：后台执行、状态查询、取消、原生会话续接和幂等请求。
- **有界结果**：默认摘要包含审计结论、阻塞项、未验证项及证据引用，详细结果分页读取。

工具使用 Node.js 与 `cross-spawn`，没有独立的常驻 daemon、relay 或数据库。`aw ui` 仅在命令运行期间开放本机回环端口。

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

在本机浏览器打开命令输出的完整链接，可修改已有角色的 CLI、模型、推理档位、执行位置及启停状态，并查看职责文本。支持多角色草稿、保存前差异预览、配置校验与版本冲突保护。

页面首先显示配置中的模型；“读取模型目录”调用目标 CLI 的目录探测。无草稿时自动读取外部配置变化，有草稿时保留修改并提示冲突。新增角色、CLI、模型允许列表和职责文本继续通过配置文件维护。

界面仅监听 `127.0.0.1`，默认选择空闲端口，`Ctrl+C` 关闭。访问链接包含本次启动的凭据，不应分享。没有远程访问或自启；其他电脑不能直接使用这个回环地址。

## 角色与配置

配置分为三层：

| 层级 | 内容 | 示例 |
| --- | --- | --- |
| 共享角色 | 职责、权限上限、默认执行位置和结果格式 | [roles.json](config/roles.json)、[角色文件](roles/) |
| 主机绑定 | CLI、模型、推理档位、执行位置与启停状态 | [home 模板](config/home.example.json)、[office 模板](config/office.example.json) |
| 项目工作流 | 允许使用的角色、项目指令和工作流名称映射 | [project.example.json](config/project.example.json) |

预设名称 `home` 和 `office` 分别提供 Codex / Claude 与 OpenCode / ACP 的配置示例。模型名称和档位仅作示例，使用前应按自己的 CLI 目录核对。实际配置不要提交到版本库。

默认主机配置在 Linux / WSL 上是 `~/.config/agent-workflow/host.json`，Windows 上是 `%LOCALAPPDATA%/agent-workflow/host.json`，可用 `AW_HOST_CONFIG` 或 `--host-config FILE` 覆盖。命令行也可编辑绑定：

```bash
aw configure --role reviewer --provider claude-local \
  --model claude-sonnet-5 --effort high --execution worker
# 核对预览后，在同一命令末尾加 --write 保存。
```

`configure` 默认只输出预览。没有推理档位时使用 `--no-effort`；`--effort none` 表示后端真正的 `none` 选项。`providers[].models` 可省略以使用发现目录；填写时作为主机允许列表，不能冒充服务端验证。

`host` 角色由当前主对话承担，**aw 不会改变当前 Codex App / CLI 的模型设置**。`worker` 角色启动只读辅助任务，交付分析或建议；即使角色名称包含“开发”，也不能写入文件。修改和最终整合由主任务完成。

保存后，新任务读取新绑定。已有任务保持原生会话及创建时的模型、档位；切换 provider 后，旧会话可能不能继续追问。

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

项目角色限制按祖先目录逐层收紧，子目录不能扩大权限。请求文件不能覆盖 executable、认证或权限参数。辅助任务仅使用允许的只读工具，不执行测试、写入、交易或递归委派；主任务负责必要的运行验证。

各 adapter 的 CLI 工具限制不等于统一的操作系统沙箱。目录探测、协议测试和格式正确的结果不能证明所有后端的真实权限行为或回答质量。登录、额度、管理员策略及模型可用性需在目标环境中核对。

任务与原始日志在 Linux / WSL 上留在 `~/.local/state/agent-workflow/<host-id>/`，Windows 上留在 `%LOCALAPPDATA%/agent-workflow/state/<host-id>/`，凭据由各 CLI 管理。模型元数据缓存 10 分钟，可通过 `--refresh` 刷新。任务记录上限为 2,000 个，单份 transcript 上限为 16 MiB；超过时显式报错并保留记录，不自动批量清理。

```bash
npm run check
npm test
# 使用未修改的上游包执行核心进程集成：
AW_TEST_UPSTREAM=/path/to/unmodified/ai-cli-mcp-2.25.0 npm test
```

测试覆盖关键配置/请求/结果合同、本地 HTTP 保存与冲突处理、跨平台安装与移动后登记，以及真实 runner、文件系统和进程锁。外部 AI CLI 用可控协议进程隔离；没有提供上游包时，相关进程测试会明确标为 skipped。可选的真实模型验收见安装说明，执行会使用对应模型额度。

这些测试使用可控 CLI 验证 Windows 与 Linux 的执行链；真实模型质量、不同主机的连续使用及额度节省效果不由这些测试保证。此版本的 UI 已验证 HTTP 接口和启停行为，浏览器交互与视觉验收尚未完成。

## 引用与许可证

| 项目 | 参考版本 | 使用方式 |
| --- | --- | --- |
| [Paseo](https://github.com/getpaseo/paseo) | v0.8.0 | 参考角色/provider 分离、能力目录和会话生命周期；未复制源码，不依赖 daemon/relay |
| [ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp) | v2.25.0 | 复用后台执行服务，分发派生 runner 和最小服务补丁 |
| [Sub-Agents Skills](https://github.com/shinpr/sub-agents-skills) | 角色文件组织方式 | 仅作工作流参考，未复制 Skill/prompt |
| [DSH ACP 指南](https://gist.github.com/robbin/b0b3cc024d88235b1ebeecce5499b5e8) | ACP 接入示例 | 参考协议接入方式，未复制指南代码 |

版本、文件摘要及派生文件说明见 [UPSTREAM.md](docs/UPSTREAM.md)。上游 MIT 版权声明完整保留于 [LICENSE.ai-cli-mcp](patches/LICENSE.ai-cli-mcp)。自有代码采用 [MIT License](LICENSE)；本工具非上述项目、OpenAI 或 Anthropic 官方产品。
