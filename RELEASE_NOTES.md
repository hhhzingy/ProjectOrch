# ProjectOrch 0.1.0-alpha.2

此版本取消 Codex、ZCode 的版本及历史程序哈希运行白名单。启动和 doctor 仅展示已测试通过的版本；未列入记录的版本可使用已实现的适配器能力，不冒称已通过历史测试。

权限、预算、用户暂停、原生会话 ID、绑定身份和未知结果处理继续生效。运行中官方程序被替换时正常重启 ProjectOrch，重启后无需登记新版本。实际 CLI/RPC 不兼容会如实报错。

历史测试记录：ZCode 0.17.0、Codex 0.164.0-alpha.11.1 的 textInput/resume/historyRead/roleTools；历史模型协作证据保留原源码依据。本次当前 Codex 0.165.0-alpha.1.2 和 ZCode 0.17.0 仅进行无模型启动/生产工厂检查，未重跑真实模型项目。不能推断所有未来版本都兼容。

Apache-2.0，维护者 hhhzingy。认证、密钥、数据库、真实聊天、内部报告及本机配置不随源码或Windows包公开。Windows ZIP解压到独立安装目录，数据目录单独保留；升级前关闭旧实例，勿覆盖数据目录。首次使用见 docs/user/ALPHA_FIRST_USE.md。

最终公开提交、云CI、ZIP哈希及下载复验结果以GitHub Release记录为准。完整原85任务、多平台和长期稳定性未完成；本次仅Alpha增量修订。
