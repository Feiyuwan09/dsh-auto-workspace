# dsh-auto-workspace

DSH（DeepSeek Harness）插件：新建工作区时**跳过文件夹选择对话框**，自动分配并创建新分区。

点「新建分区」（或 Ctrl+O / Cmd+O）后不再弹出任何选择器，直接在「文档」下依次创建：

```
<文档>\deepseek-harness\default-workspace
<文档>\deepseek-harness\default-workspace-2
<文档>\deepseek-harness\default-workspace-3
…
```

**每次点击都会产生一个真正的新分区**（命名探测到第一个不存在的编号即创建）。
官方「添加工作区」的固有流程会在创建分区后自动在其中新建一个会话，所以你会看到
「新分区 + 其中一个新的对话」同时出现——这是官方行为，不是 bug。

## 分区名可自定义（插件后台）

打开 DSH 插件管理页（插件 → dsh-auto-workspace → 配置），在卡片里修改
「目录名前缀」并点保存：

- 默认 `default-workspace`：第一个分区 `default-workspace`，其后 `-2`、`-3`…
- 改成 `my-proj`：第一个分区 `my-proj`，其后 `my-proj-2`、`my-proj-3`…
- **保存后立即生效**（下一次新建分区用新名字），并持久化到 profile 的
  `cordis.patch.yml`（entry id `auto-workspace` 的 `workspaceName` 键）。
- 改名只影响**之后**新建的分区；已有分区不受影响。删除「旧名字」分区时
  目录清理仍正常工作（同一进程内的历史名字都被记录）；跨重启后残留的
  旧名字目录不会被自动清理（等价于官方行为，需要时可手动删除）。
- 与 dsh-unrestricted 的设置面板同一套官方机制（settings 命名空间 +
  `loader/volatile-update` 热更新），无需重启 Harness。

## 删除分区 = 连磁盘文件夹一起删

官方「删除分区」只移除注册、**保留磁盘文件夹和会话日志**。本插件改变了这一点：

- **删除分区时，其磁盘文件夹（及里面全部文件、会话日志）会被一并永久删除。**
- 删除确认弹窗已被替换为醒目警告文案（明确写明文件夹会被永久删除、无法恢复）。
- 安全网：只有容器目录（`<文档>\deepseek-harness`，或 `DSH_AUTO_WORKSPACE_DIR`）
  之下的 `default-workspace` / `default-workspace-N` 会被删除；你手动注册的其他
  任意目录（例如桌面上的项目文件夹）删除分区时**永远不会**被触碰。
- 编号回收因此变得更直接：删除分区后目录也消失，下次新建必然拿回最小空闲编号。

## 安装

### 一键安装

**Windows**（PowerShell / CMD）：

```powershell
irm https://raw.githubusercontent.com/Feiyuwan09/dsh-auto-workspace/main/install.ps1 | iex
```

**macOS / Linux**：

```bash
curl -fsSL https://raw.githubusercontent.com/Feiyuwan09/dsh-auto-workspace/main/install.sh | bash
```

或克隆仓库后本地运行：

```powershell
.\install.ps1   # Windows（install.bat 是它的薄包装，双击即可）
```

```bash
./install.sh    # macOS / Linux
```

脚本会完成全部步骤：定位 profile → 备份 package.json → 拷贝插件到
`~/.dsh/plugins/dsh-auto-workspace` → 注册 dependencies 与 bundles → 运行包管理器
链接依赖。**只重启 Harness 即可使用。** 修改前会生成
`package.json.bak-auto-workspace-<时间戳>` 备份，重复运行安全（覆盖更新、跳过重复注册）。

- 多个 profile 时显式指定：`.\install.ps1 desktop` / `.\install.ps1 C:\path\to\profile`
- 依赖需要 pnpm / corepack / npm 其中之一（按此顺序探测）；macOS / Linux 修改
  package.json 还依赖 `jq`。

### 手动安装

1. 把本目录放到你的插件目录（通常 `~/.dsh/plugins/dsh-auto-workspace`）
2. 在 profile 的 `package.json` 的 `dependencies` 里加入：
   ```json
   "dsh-auto-workspace": "file:../../plugins/dsh-auto-workspace"
   ```
3. 在 profile 的 `dsh.profile.bundles` 里加入 `"dsh-auto-workspace"`
4. 安装依赖（让 profile 的 `node_modules` 出现该包；DSH 启动时从那里解析插件）
5. 重启 Harness

> 插件同时带有 `dsh.bundle.patch`（cordis.patch.yml）：它会禁用第一方的
> `directory-picker` 行并插入本插件。如果 profile 的 `package.json` 未把本插件
> 加入 bundles 列表，该 patch 不会生效。

## 工作原理

- **Host 半边**（`lib/index.mjs`）：提供替代的 `ctx.directoryPicker` 服务，
  `capability()` 返回 `{ kind: "native", pick }`；`pick()` 不弹任何系统对话框，
  在容器目录下分配一个尚不存在的 `<workspaceName>[-N]` 目录名，创建后返回
  其规范化路径。分配过程串行化，并发点击也不会拿到同名目录。
  同时包装 `workspaceRegistry.delete`：注册删除成功后，把该分区自己的
  容器目录物理删除（清理任务与分配链串行，避免竞态）。
  分区名前缀来自 settings 命名空间 `auto-workspace` 的 `workspaceName`
  （Config schema + `loader/volatile-update` 热更新）。
- **Client 半边**（`lib/client.js`）：向两个 directory-flow 槽位
  （`conversation.hero.workspace.directoryFlow`、`sidebar.workspaces.directoryFlow`）
  注册渲染为空的占位者；`open` 上升沿触发一次 `pick()` → `onPicked(path)`，
  由第一方 WorkspacePicker 走 `workspaces.create({path})` 完成注册，随后官方
  流程会在新分区里开一个新会话。另外直接改写官方 `workspace` 字典的
  `delete.*` 词条，把删除确认弹窗换成「文件夹将被永久删除」的醒目警告。
  还通过 `plugins.bundle.config` 槽位注册插件管理页的「分区名前缀」配置卡片
  （configForms 写入 settings，与 dsh-unrestricted 同款模式）。

第一方链路保持不变：`uiWorkspace.pickDirectory()` → Typert Remote
`directoryPicker/pick` → `DirectoryPickerController` → 本插件的 `directoryPicker`。

## 配置

| 配置项 | 说明 |
| --- | --- |
| 插件管理页 → 配置卡片 | 修改分区目录名前缀（`workspaceName`），保存即热更新并持久化 |
| `DSH_AUTO_WORKSPACE_DIR` | 环境变量：指定分区容器目录（绝对路径）；不设置时自动探测「文档」目录下的 `deepseek-harness` |
| `DSH_AUTO_WORKSPACE_DISABLED` | 环境变量：设为 `1` 时禁用本插件（host 半边不注册替代服务） |

## 卸载

1. 从 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 中移除本包
2. 重新安装依赖
3. 删除插件目录
4. 重启 Harness（第一方 `directory-picker` 恢复弹窗行为）

## 许可

[MIT](./LICENSE)
