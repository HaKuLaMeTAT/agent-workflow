# 安装与本机配置（v0.4.1）

支持 Linux / WSL 和原生 Windows 10/11。需要 Node.js 22.12+、npm，以及已安装、登录的目标 AI CLI。Linux / WSL 需要 `flock`；Windows 使用系统自带的 Windows PowerShell 5.1，不需要管理员权限或 WSL。Windows PowerShell 的进程锁与 Job Object 脚本仅在命令运行时启动，不修改系统执行策略；受组织策略限制时会返回诊断。

## 1. 选择任意安装目录

克隆或解压本项目到自己选择的可读写目录，例如 Linux 的 `~/tools/agent-workflow` 或 Windows 的 `D:\AI 工具\agent-workflow`。支持空格、中文路径，不依赖固定盘符或项目位置。以下命令均从仓库根目录运行；Windows 使用 PowerShell，路径有空格时加引号。

```powershell
# Windows 示例；改成自己的目录
Set-Location 'D:\AI 工具\agent-workflow'
node --version
npm --version
```

Linux / WSL 先 `cd` 到仓库。两种平台都执行：

```text
npm ci --ignore-scripts --no-audit --no-fund
npm install --prefix .runtime --save-exact --ignore-scripts --no-audit --no-fund ai-cli-mcp@2.25.0
node scripts/patch-upstream.mjs .runtime/node_modules/ai-cli-mcp
```

根目录依赖用于跨平台 CLI 启动；后台执行依赖和 lockfile 留在 `.runtime/`，不全局安装 npm 包，不运行 npm lifecycle scripts。补丁核验固定版本及文件摘要，不匹配时停止。上游来源见 [UPSTREAM.md](UPSTREAM.md)。

## 2. 创建本机配置

```text
node bin/aw.mjs init --preset home --output config/home.local.json
node bin/aw.mjs roles --host-config config/home.local.json
node bin/aw.mjs ui --host-config config/home.local.json
```

`home` 提供 Codex / Claude 示例；`office` 提供 OpenCode / ACP / Codex 示例，角色初始禁用。`init` 自动定位 PATH 中的 CLI（Windows 包含 PATHEXT 中的 `.exe`、`.cmd` 等入口），找不到时禁用相应绑定，并拒绝覆盖已有文件。模型与档位仅为示例，需按本机 CLI 目录确认。

UI 可修改已有角色的绑定。也可先读取目录，再预览、保存：

```text
node bin/aw.mjs models claude-local --host-config config/home.local.json --refresh
node bin/aw.mjs configure --host-config config/home.local.json --role reviewer --provider claude-local --model claude-sonnet-5 --effort high --execution worker
```

核对预览后，在同一命令末尾加 `--write`。新增 provider 通过 JSON 文件维护；模型和档位允许列表可通过 `configure --allow-model` 或 UI 勾选显式扩充。Windows JSON 路径可写 `D:/Tools/cli.cmd`，或将反斜杠写成 `D:\\Tools\\cli.cmd`。DSH 的 ACP profile 需提前在对应 CLI 中初始化。

## 3. 登记用户入口，让 Codex 自动识别

```text
node scripts/install-local.mjs --apply config/home.local.json
```

安装器先验证配置和 patched runtime，再写入：

| 内容 | Linux / WSL 默认位置 | Windows 默认位置 |
| --- | --- | --- |
| 主机配置 | `~/.config/agent-workflow/host.json` | `%LOCALAPPDATA%/agent-workflow/host.json` |
| 终端命令 | `~/.local/bin/aw` | `%LOCALAPPDATA%/agent-workflow/bin/aw.cmd` |
| Codex Skill | `~/.agents/skills/agent-workflow/` | `%USERPROFILE%/.agents/skills/agent-workflow/` |
| 任务状态与日志 | `~/.local/state/agent-workflow/<host-id>/` | `%LOCALAPPDATA%/agent-workflow/state/<host-id>/` |

新安装采用 Codex 的用户级 `.agents/skills` 发现目录。若设置 `CODEX_HOME`，使用其 `skills/agent-workflow`；若已有 v0.2 的 `~/.codex/skills/agent-workflow`，优先在原位置升级，避免重复 Skill。当前 Codex 的用户级发现规则见 [官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。

Skill 使用普通文件复制，**无需符号链接权限**。其中 `installation.json` 登记当前仓库、Node 和主机配置的绝对路径；`SKILL.md` 包含可直接执行的本机命令，`aw.mjs` 负责定位入口。因此 **Codex 不需要 PATH 中有 `aw` 或 `node`，也不需要手动设置 `AW_ROOT`**。安装不会启动模型任务或设置自启。

在 Codex 中可用 `$agent-workflow` 检查是否已发现 Skill。若现有任务未刷新，重新打开 Codex。终端手动输入 `aw` 则需将上表的命令目录加入用户 PATH，也可直接使用安装输出的完整命令；安装器不修改全局 PATH。

位置也可自定义，以下参数在两种平台都可用：

```text
node scripts/install-local.mjs --apply config/home.local.json --host-config "自选配置目录/host.json" --bin-dir "自选命令目录" --skill-dir "Codex已扫描的skills目录/agent-workflow"
```

自定义 Skill 目录需在当前 Codex 的扫描范围内。主机配置、命令目录和仓库目录可各自独立。`--host-config FILE` 与 `AW_HOST_CONFIG` 可在运行时覆盖登记的主机配置，`AW_ROOT` 可显式覆盖仓库位置。

## 从 v0.2 / v0.3 升级 / 移动安装目录

先结束正在执行的旧任务，再更新源码。从更新后的仓库运行：

```text
npm ci --ignore-scripts --no-audit --no-fund
node scripts/patch-upstream.mjs .runtime/node_modules/ai-cli-mcp
node scripts/install-local.mjs --apply --update
```

补丁脚本可将摘要完全匹配的 `aw-prepared-v1` 升级到 v0.3 的 `aw-prepared-v2`。如果上游放在其他目录，给补丁脚本传入实际目录。

`--update` 默认保留**已安装配置**中的角色绑定和 UI 修改，刷新生成的入口、Skill 与按需读取的 references。新增 executor 不会自动启用；旧配置未包含它时，可直接用 UI 或 configure 添加绑定。可识别并转换 v0.2 指向当前仓库的 Skill 符号链接；未知安装或自定义过的旧入口不会被覆盖。需要主动替换配置时，在 `--apply` 后显式传入配置文件。

v0.3 仓库移动后，在新位置重新运行 `node scripts/install-local.mjs --apply --update`。安装器从旧登记信息找到原引用，更新仓库内部的 catalog/runtime 路径，保留外部配置和状态路径。无需手改 Skill 或设置 `AW_ROOT`。如果 Node 的位置改变，也用新 Node 重跑这条命令。自定义过用户安装位置时，升级应再次传入同样的 `--host-config`、`--bin-dir`、`--skill-dir`。

移动 v0.2 仓库时，建议先在原位置升级至 v0.3，再移动并重新登记。

## v0.4.1：Windows 执行任务迁移

原生 Windows 的完整执行路径需要 Git for Windows 和已安装、登录的目标 CLI，并能从启动 AW 的环境定位 Git。executor 支持 Claude、Codex、OpenCode、DSH / ACP。`home` 和 `office` 模板都含 Codex provider，executor 初始禁用；按自己的账户与模型目录启用。

在 Windows 上重新生成本机配置和登记 Skill，不直接复制 WSL 的 host.json；其中 Linux 的 executable、catalog、state_dir 等绝对路径不适用于 Windows。迁移源码和项目文件，登录目标 CLI 后按本机目录绑定角色。已有 Windows v0.3 安装则使用上一节的 `--update` 保留本机配置。

```powershell
Get-Command node, git, codex
node bin/aw.mjs models codex-local --host-config config/home.local.json --refresh
node bin/aw.mjs configure --host-config config/home.local.json --role executor --provider codex-local --model gpt-5.6-luna --effort low --access workspace-write --permissions restricted --allow-model --write
node scripts/install-local.mjs --apply config/home.local.json
```

如已登记安装，使用 `aw configure` 修改已安装 host，不用另一份旧源配置覆盖它。Codex 的模型支持目录选择和手动输入，默认模板不设置固定的模型允许列表；Luna 只是示例。旧 host 若有 `providers[ID].models`，可显式扩充或删除该字段。模型和档位以本机目录及实际调用为准，示例命令不是所有账户的模型可用性保证。

执行请求见 [交接与命令格式](../skills/agent-workflow/references/execution.md)。源项目需为干净且已有提交的 Git 仓库；不含 tracked symlink/submodule。请求放在项目外或忽略目录；AW state_dir 放在目标仓库外。所有请求内的相对路径使用 `/`，支持空格和中文目录。

验证使用命令加 argv 数组，不拼接 shell 字符串。Node 项目可显式声明一次性的 `execution.setup`：

```json
{
  "command": "npm",
  "args": ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  "cwd": ".",
  "timeout_seconds": 600
}
```

仅在项目适用时使用此命令。worktree 不复制源目录中忽略的 node_modules；`setup` 需按真实项目定义，之后再运行 `verification`。总任务 timeout_seconds 应覆盖准备、修改、验证及修复。准备或验证不得更改交付源码。Git 应用补丁时遵循项目换行策略，包括 Windows 的 CRLF 转换。

默认 `permissions: restricted`：Claude / OpenCode / ACP 使用文件权限限制；Codex 使用原生 workspace-write 沙箱，网络关闭。AW 的 setup / verification 在 CLI 沙箱外以当前用户权限执行。Codex 沙箱须在本机可用；失败时 AW 返回诊断，不会自动改为完整权限。

需要 worker 自行运行命令时，显式配置完整权限：

```text
aw configure --role executor --permissions full-access --write
```

UI 中对应“写入能力：可修改文件”和“权限策略：完整权限”。这会开放原生命令、文件及网络访问，worktree 不提供系统隔离；`write_paths` 约束交付差异，无法撤销工作区外的命令副作用。顾问/审查角色不能用这个选项扩大写入权限。基础、主力、攻坚开发角色可以显式设置 `--execution worker --access workspace-write`。

OpenCode 可用 `opencode-go` provider；DSH 使用预先初始化的 ACP profile，支持 `DSH_HOME` 和 `--profile NAME`，不会由探测自动安装。DSH 模型 ID 可能是形如 `["deepseek-official","deepseek-v4-flash"]` 的 JSON 字符串，请从 `models dsh-local` 输出复制，或在 UI 中选择，避免 PowerShell 多层引号传输出错。

权限依据：[Codex 配置](https://developers.openai.com/codex/config-reference)、[OpenCode 权限](https://opencode.ai/docs/permissions/)、[ACP 文件协议](https://agentclientprotocol.com/protocol/v1/file-system)、[ACP 终端协议](https://agentclientprotocol.com/protocol/v1/terminals)、[Claude CLI 参数](https://code.claude.com/docs/en/cli-reference)。

可以在启用 executor 后显式运行一次真实模型验收：

```text
node scripts/live-execution-smoke.mjs --run
```

它在独立临时项目和任务状态目录中验证读文件、修改、测试、应用与清理，最多两次模型编辑调用，会消耗配置模型的额度。它不修改原有 host 配置，保留测试日志和 acceptance.json。也可指定一份临时 host：`node scripts/live-execution-smoke.mjs --run HOST_CONFIG`；启用完整权限后，加 `--native-tools` 会要求 worker 实际调用命令工具，并检查调用事件。

### v0.4.1 验收记录

自动用例共 30 项，Linux/WSL 与原生 Windows 均已覆盖并通过（完整回归后，对最后修改追加定向复测）。覆盖模型自选、允许列表扩充、权限切换、各 adapter 的读写/测试失败续接/应用，以及进程树清理。Windows 使用可控 CLI 协议进程验证 AW 执行链。

真实 CLI 验收在 WSL 完成：Codex `gpt-5.6-luna`、OpenCode `opencode-go/deepseek-v4-flash`、DSH 的 DeepSeek V4 Flash 均通过受限与完整权限模式；Claude Sonnet 5 通过完整权限模式。完整权限验收均观测到原生命令工具调用，并通过 AW 的独立验证、应用和清理。Luna 只是其中一个验收模型；另有缓存外任意模型 ID 的可控 CLI 回归，AW 不内置固定的 Codex 模型列表。

这不等于已验证每个 CLI 在原生 Windows 上的真实账户调用，也不证明复杂任务质量或 token 节省。迁移到目标 Windows 后，按上面的 `prepare` 与可选真实模型验收检查当地环境。

## 接入项目与核验

将 `config/project.example.json` 保存为目标项目的 `agent-workflow.json`，按需限制角色和工作流。使用 `aw` 或安装输出的完整命令前缀：

```text
aw roles
aw prepare --workflow review --cwd "项目的绝对路径"
```

`roles` 不探测模型；`prepare` 检查有效绑定与 CLI 能力，不提交分析任务。不同 CLI 的原生 Windows 支持、登录方式和模型可用性需在目标环境确认。Windows 取消通过任务目录中的请求文件传达给 runner，runner 用 Job Object 清理 provider 及其子进程；Linux 保留进程组清理机制。

自动验证：

```text
npm run check
npm test
```

完整进程和安装测试需一份**未修改**的上游包；没有提供时会明确 skipped：

```text
npm install --prefix .runtime/pristine --save-exact --ignore-scripts --no-audit --no-fund ai-cli-mcp@2.25.0
```

```bash
# Linux / WSL
AW_TEST_UPSTREAM="$PWD/.runtime/pristine/node_modules/ai-cli-mcp" npm test
```

```powershell
# Windows PowerShell
$env:AW_TEST_UPSTREAM = (Resolve-Path '.runtime/pristine/node_modules/ai-cli-mcp').Path
npm test
```

这些测试隔离外部模型调用，使用可控协议 CLI 验证安装、含空格/中文路径、目录迁移、五种 adapter、会话续接、取消、超时、并发锁与 UI 保存冲突。可选真实模型验收会使用对应模型额度：

```text
node scripts/live-smoke.mjs --run reviewer
```

## 本机数据与打包

运行时、真实配置、凭据和任务日志不属于公开源码。凭据由目标 CLI 管理；Windows 子进程继承必要的用户配置目录与系统环境，不转发 API key。

`private: true` 防止意外发布到 npm，不限制源码分发。`npm pack --dry-run` 可核对包内容；打包不会安装 AI CLI 或调用模型。
