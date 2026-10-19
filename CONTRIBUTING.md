# 贡献指南

欢迎反馈问题、完善文档和提交小范围修复。较大的功能或架构改动请先开 Issue 讨论使用场景和方案。

## 提交 Pull Request

1. 从 `main` 建立自己的功能分支，将 PR 的目标分支设为 `main`。
2. 代码注释和说明文档使用中文；修改功能时同步相关文档，避免无关格式化。
3. 运行 `npm run check`、`npm run build` 和 `npm run build:server`。涉及画布行为时运行 `npm run test:e2e:ci`，涉及 Node 认证/同步时运行 `npm run test:node`；草图变化运行 `npm run test:prototype`。
4. PR 中说明问题、改动、验证结果和用户可见变化；没有执行的检查如实注明。
5. 不提交私人脑图、真实配置、Cookie、恢复码、数据库、环境密钥或包含这些信息的测试附件。

测试应验证行为和实际风险，不要求为纯文案变化编写测试。CI 只做自动检查，不负责生产部署。

## 反馈与安全

Issues 提供“问题反馈”和“功能建议”中文模板。请使用最小演示数据复现问题。安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告。

项目使用 [MIT](LICENSE) 许可证。贡献需有权授权并保持第三方许可通知。首版不要求签署 CLA。
