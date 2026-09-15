# 安装与本机配置

支持 Linux / WSL，要求 Node.js 22.12+、npm 和系统 `flock`。目标 AI CLI 需自行安装和登录；Agent Workflow 不提供账号、API key 或订阅。

## 准备运行时

在本仓库根目录执行：

```bash
npm install --prefix .runtime --save-exact --ignore-scripts --no-audit --no-fund ai-cli-mcp@2.25.0
node scripts/patch-upstream.mjs .runtime/node_modules/ai-cli-mcp
```

依赖和 lockfile 仅写入本仓库的 `.runtime/`，不全局安装 npm 包，不运行 npm lifecycle scripts。补丁核验固定版本及上游文件摘要；不匹配时停止，不应绕过检查。上游来源见 [UPSTREAM.md](UPSTREAM.md)。

## 创建配置

```bash
node bin/aw.mjs init --preset home --output config/home.local.json
node bin/aw.mjs roles --host-config config/home.local.json
node bin/aw.mjs ui --host-config config/home.local.json
```

`home` 提供 Codex / Claude 示例；`office` 提供 OpenCode / ACP 示例，角色初始禁用。模板模型与档位仅为配置示例，使用前按实际目录调整。`init` 自动定位已安装 CLI，找不到程序时禁用相应绑定，并拒绝覆盖已有文件。

在 UI 中检查已有角色，或先读取 CLI 目录，再用命令行预览、保存绑定：

```bash
node bin/aw.mjs models claude-local --host-config config/home.local.json --refresh
node bin/aw.mjs configure --host-config config/home.local.json \
  --role reviewer --provider claude-local \
  --model claude-sonnet-5 --effort high --execution worker
# 核对预览后，在同一命令末尾加 --write。
```

UI 只能编辑已配置 provider 的角色绑定。新增 provider 或修改允许列表需要编辑本机 JSON；示例配置和 host schema 以 `config/`、`src/config.mjs` 为准。DSH 的 ACP profile 需在其 CLI 中事先初始化。

## 安装用户入口（可选）

不安装入口也能持续使用 `node bin/aw.mjs ... --host-config FILE`。需要 `aw` 命令和 Codex Skill 时执行：

```bash
node scripts/install-local.mjs --apply config/home.local.json
```

该脚本检查 patched runtime，然后新增以下位置；任一已存在都会拒绝覆盖：

| 位置 | 内容 |
| --- | --- |
| `~/.config/agent-workflow/host.json` | 本机配置，使用当前 checkout 的绝对路径 |
| `~/.local/bin/aw` | 指向当前 Node 与 checkout 的 shell 入口 |
| `~/.codex/skills/agent-workflow` | 指向仓库 Skill 的符号链接 |

确保 `~/.local/bin` 位于 PATH。仓库和 Node 的安装位置应保持稳定；移动后需要显式更新入口及配置引用。脚本不会启动服务、模型任务或设置自启。

已有安装通过 `aw ui` 或 `aw configure` 调整配置，无需再次运行安装脚本。凭据由各 CLI 管理，不复制认证文件。

## 接入项目与核验

将 `config/project.example.json` 的内容保存为目标项目的 `agent-workflow.json`，按项目需要限制角色和工作流。然后检查：

```bash
aw prepare --workflow review --cwd /absolute/project
```

配置不足、CLI 参数不兼容或模型不可用时，按诊断修复配置。此命令不运行模型任务。真实模型验收是额外的可选操作，**会调用已配置的模型并消耗对应额度**：

```bash
node scripts/live-smoke.mjs --run reviewer
```

验收要求 worker 实际读取临时证据、识别已知缺陷，并区分静态检查与运行验证。失败会保留记录，不自动重试或放宽权限；这项有界验收不代表所有模型质量或系统级隔离已经证明。

## 本机数据与打包

运行时、真实 host 配置、凭据、任务日志、交接和内部设计记录不属于公开源码。Git 仅收录允许的源码目录、示例和两份公共文档；`package.json` 的 `files` 同样限定 npm 打包内容。

`private: true` 用于防止意外发布到 npm，不限制 GitHub 源码分发。可用 `npm pack --dry-run` 核对包内容；打包本身不会安装目标 AI CLI 或调用模型。
