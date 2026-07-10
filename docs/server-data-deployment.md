# Evidence Agent 服务器数据部署

## 数据边界

`myml-evidence-agent` 的代码可以进入私有 Git 仓库，但以下内容不得进入 Git：

- `.env`、任何 API key、数据库密码和共享 token
- `server/data/` 中的公司图库、词库和品类资料
- `server/runtime/` 中的项目 run、拆分素材图和最终生成图
- 设计知识库及其元素图库索引
- 日志、用户素材和迁移清单

当前运行依赖分为三组：

| 数据组 | 推荐服务器目录 | 是否必须 | 内容 |
| --- | --- | --- | --- |
| Evidence 静态/维护数据 | `/srv/myml/data/evidence-static` | 是 | `element-terms.json`、`category-candidates.json`、`category-catalog-overrides.json`、`category-images/` |
| Evidence 运行数据 | `/srv/myml/data/evidence-runtime` | 是 | `project-runs.json`、`project-run-assets/`；新环境可从空目录开始，但迁移最新运行结果时必须复制 |
| 设计知识库 | `/srv/myml/data/design-knowledge-base` | 是 | `data/indexes/element-source-gallery-index.json` 及索引实际依赖的图片/文件 |

`category-image-migration-backups/` 只属于迁移备份，不是服务启动必需项。可单独加密归档到备份目录，不必挂载到生产容器。

## 安全传输

先停止新 Evidence 项目任务并等待正在运行的项目完成，再生成清单和复制数据。不要在运行数据持续写入时制作最终清单。

在源机器分别生成 SHA-256 清单，清单必须放在待校验目录之外：

```powershell
node server\scripts\dataManifest.js create server\data C:\secure-transfer\evidence-static.migration-manifest.json
node server\scripts\dataManifest.js create server\runtime C:\secure-transfer\evidence-runtime.migration-manifest.json
node server\scripts\dataManifest.js create C:\path\to\design-knowledge-base C:\secure-transfer\design-knowledge.migration-manifest.json
```

通过公司批准的 SFTP、SCP、受控共享盘或离线介质传输目录和清单。不要使用 GitHub Release、Git LFS、聊天附件或公开网盘传公司数据。

在服务器解压到最终目录后校验：

```bash
node server/scripts/dataManifest.js verify /srv/myml/data/evidence-static /secure-transfer/evidence-static.migration-manifest.json
node server/scripts/dataManifest.js verify /srv/myml/data/evidence-runtime /secure-transfer/evidence-runtime.migration-manifest.json
node server/scripts/dataManifest.js verify /srv/myml/data/design-knowledge-base /secure-transfer/design-knowledge.migration-manifest.json
```

清单包含相对文件名和哈希，也属于内部资料；校验后保存在受控备份区，不要提交到 Git。

## 容器挂载

生产环境使用独立目录，避免代码更新覆盖数据：

```text
EVIDENCE_DATA_DIR=/app/server/data
EVIDENCE_RUNTIME_DIR=/app/server/runtime
MYML_DESIGN_KNOWLEDGE_BASE_PATH=/data/design-knowledge-base
ELEMENT_SOURCE_GALLERY_INDEX_PATH=/data/design-knowledge-base/data/indexes/element-source-gallery-index.json
```

静态数据和运行数据不要挂载到同一个宿主机目录。设计知识库在 Compose 中按只读方式挂载。

## 启动前检查

容器拿到真实环境变量和数据挂载后运行：

```bash
node server/scripts/checkDeploymentReadiness.js
```

该命令只输出变量名和通过/失败状态，不输出变量值，不连接数据库，也不调用 AI provider。它会检查：

- Evidence 共享 token 是否已配置且长度足够
- 公司只读数据库连接字段是否齐全
- 公司参考图地址是否合法
- 公司 AI 映射和生图配置是否齐全
- 词库、品类表、历史设计图库是否存在且可解析
- 运行目录是否可读写
- 元素图库索引是否存在且可解析

检查通过不代表数据库、图片服务器和 provider 一定可达；网络连通性需要在受控 smoke test 中验证。

## 权限建议

- 公司数据库账号仅授予批准视图的 `SELECT` 权限。
- Evidence 容器不要对公司网络公开端口，只允许 Canvas 服务在内部 Docker 网络访问。
- Evidence 静态数据目录仅授予服务账号所需权限；运行目录必须可写。
- 设计知识库挂载为只读。
- 备份、清单和 `.env` 权限设为仅部署管理员可读。
