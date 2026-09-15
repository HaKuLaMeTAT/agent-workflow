# 上游来源与版权说明

本文件记录分发代码的来源、固定版本和许可证。安装步骤见 [INSTALL.md](INSTALL.md)。

## ai-cli-mcp

- 仓库：[mkXultra/ai-cli-mcp](https://github.com/mkXultra/ai-cli-mcp)。
- 固定版本：`2.25.0`，commit `da45d7c516408344d664c5e0cf6bc7847bd97faf`。
- 发布包 integrity、修改前后文件的 SHA-256：[patches/upstream.json](../patches/upstream.json)。
- 许可证：MIT；完整原始声明保留于 [patches/LICENSE.ai-cli-mcp](../patches/LICENSE.ai-cli-mcp)，包括 Peter Steinberger 和 mkXultra 的版权声明。

[patches/detached-runner.cjs](../patches/detached-runner.cjs) 派生自该版本发布包的 `dist/detached-runner.cjs`。[scripts/patch-upstream.mjs](../scripts/patch-upstream.mjs) 包含应用到 `dist/cli-process-service.js` 的小范围补丁及必要上下文。

修改用于接收 adapter 提供的显式命令、stdin、环境、启动回执、超时和进程组取消参数。原生 builder 未作为安全默认入口使用；这些扩展是本工具的修改，不是上游公开 API 的原生承诺。

补丁应用前检查版本和原始文件摘要；已经应用的副本也必须符合固定补丁摘要。安装会在局部运行时目录产生 `aw-patch.json`。上游其余文件和依赖由使用者按安装说明获取，不随本仓库复制分发。

上游包声明的运行依赖包括 `@modelcontextprotocol/sdk`、`cross-spawn` 和 `zod`。这些依赖沿用各自许可证；安装产生的运行时 lockfile 留在本机。升级上游时必须核对补丁位置、摘要和受影响的进程测试。

## 参考项目

| 来源 | 参考范围 | 是否复制代码 |
| --- | --- | --- |
| [Paseo v0.8.0](https://github.com/getpaseo/paseo/tree/v0.8.0) | provider、角色绑定、能力目录、原生会话和 ACP 接入方式 | 否 |
| [Sub-Agents Skills](https://github.com/shinpr/sub-agents-skills) | 职责文件与协作说明的组织方式 | 否 |
| [DSH ACP 接入指南](https://gist.github.com/robbin/b0b3cc024d88235b1ebeecce5499b5e8) | 标准 ACP profile、模型目录和 thought-level 选项 | 否 |
| [OpenCode CLI 文档](https://dev.opencode.ai/docs/cli/) 与 [run 源码](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/run.ts) | 启动参数、stdin、事件输出与权限配置 | 否 |

除上文明确列出的 ai-cli-mcp 派生文件和补丁上下文外，包装层、协议适配、配置 UI 和测试为本项目实现。源码引用不表示项目关联或官方背书。
