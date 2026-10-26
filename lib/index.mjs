/**
 * dsh-auto-workspace · 新建工作区免选文件夹（Host 半边）
 *
 * 机制：
 *   - 本插件提供替代的 `ctx.directoryPicker` 服务（`capability()` 返回
 *     `kind: "native"`），由第一方 DirectoryPickerController 消费：
 *     `requireCapability("native", "pick")` 只要求该形状，不需要继承任何类。
 *   - `pick()` 不弹任何系统对话框：每次调用在容器目录下分配一个
 *     **可回收的**工作区目录名并（递归）创建，返回该路径：
 *       `<Documents>\deepseek-harness\<workspaceName>`
 *       `<Documents>\deepseek-harness\<workspaceName>-2`
 *       `<Documents>\deepseek-harness\<workspaceName>-3` …
 *     编号按「空闲」回收：`<workspaceName>-2` 已删除（目录仍在、注册已移除）
 *     时，下一次分配优先拿回 2，而不是顺延到 3。
 *   - **分区名前缀可自定义**：settings 命名空间 `auto-workspace` 的
 *     `workspaceName` 键（默认 `default-workspace`）。插件管理页的配置卡片
 *     （client 半边经 `plugins.bundle.config` 槽位注册）写入该键，持久化到
 *     profile 的 cordis.patch.yml；Loader 触发 `loader/volatile-update`，
 *     本插件热更新 `currentBaseName`，下一次新建分区立即用新名字。
 *     （与 dsh-unrestricted 的 settings 面板完全同一套官方机制。）
 *   - 官方「删除分区」只删除注册项、**保留磁盘目录**（`workspaceRegistry.delete`，
 *     dsh-workspace lib/index.js L705-741 注释：“without deleting its directory or
 *     Sessions”）。所以分配器不能只靠目录是否存在判断：
 *     注册中的分区（`workspaceRegistry.resolveByPath` 命中）目录保留 → 跳过该编号；
 *     已删除（目录还在但不再注册）→ 视为空闲编号 → 复用。
 *   - 本插件同时包装 `workspaceRegistry.delete`：注册删除成功后，
 *     把该分区自己的容器目录物理删除（只限 deepseek-harness 容器内、
 *     目录名匹配本插件使用过的前缀；手动注册的任意目录不受影响）。
 *   - 运行时依赖仅 @deepseek-ai/schemastery（Config schema，DSH 标配，
 *     同 dsh-unrestricted）；其余只用 node: 内置模块。
 *
 * 目录解析（与第一方 defaultWorkspaceDirectory 一致）：
 *   1) 配置了 DSH_AUTO_WORKSPACE_DIR 环境变量时作为容器目录直接使用；
 *   2) win32 用 powershell.exe 查询 MyDocuments(DoNotVerify)；
 *   3) 失败时回退到 os.homedir()/Documents；
 *   4) 拼上 deepseek-harness 作为容器，分区在其下逐一分配。
 *
 * 禁用方式：`disabled: true`（本插件行）或 DSH_AUTO_WORKSPACE_DISABLED=1。
 * 修改后重启 Harness 生效。
 */

import { spawn } from 'node:child_process'
import { access, mkdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名（Loader 诊断使用）。 */
export const name = 'auto-workspace'

/**
 * 需要的注入服务：settings（配置面板写回）与 loader（volatile 更新）。
 * root 上下文由 dsh-base 提供这两个服务（dsh-unrestricted 同款注入）。
 */
export const inject = ['settings', 'loader']

/** 分区目录名的默认前缀（第一个分区保持旧路径兼容）。 */
const DEFAULT_WORKSPACE_DIRECTORY = 'default-workspace'

/**
 * 插件配置：分区名前缀。settings 面板（插件管理页）写入 `workspaceName`，
 * 持久化到 profile cordis.patch.yml 的本 entry config。volatile() 允许
 * 运行时更新：写回后 Loader 触发 `loader/volatile-update`，apply 内的
 * 监听器重读 `config.get().workspaceName` 并热切换。
 */
export const Config = z.object({
  workspaceName: z.string().default(DEFAULT_WORKSPACE_DIRECTORY),
}).default({ workspaceName: DEFAULT_WORKSPACE_DIRECTORY }).volatile()

/**
 * 清理用户输入的目录名：去掉 Windows 非法字符、路径分隔符与点号，
 * 空串回退默认前缀。client 面板保存前也做同样清理，这里是最终防线。
 * @param {unknown} input - 面板提交的原始字符串。
 * @returns {string} 可直接用作目录名的前缀。
 */
function sanitizeWorkspaceName(input) {
  const cleaned = String(input ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\./g, '')
    .trim()
  return cleaned === '' ? DEFAULT_WORKSPACE_DIRECTORY : cleaned
}

/** 转义正则特殊字符（目录名安全匹配用）。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 当前生效的分区名前缀（apply 时从 config 读取，随面板保存热更新）。 */
let currentBaseName = DEFAULT_WORKSPACE_DIRECTORY

/**
 * 本进程使用过的所有前缀 + 永久默认名。删除分区时的目录清理白名单：
 * 用户改名后删除「旧名字」的分区，只要发生在同一进程内仍会被正确清理；
 * 跨重启后的旧名字目录会残留（等价于旧版行为，README 有说明）。
 */
const nameHistory = new Set([DEFAULT_WORKSPACE_DIRECTORY])

/**
 * 在 win32 上查询「文档」目录（与第一方 defaultWorkspaceDirectory 相同的
 * powershell 调用）。失败时返回 null，由调用方回退。
 * @returns {Promise<string | null>}
 */
function queryDocumentsFolder() {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolvePromise) => {
    let stdout = ''
    let settled = false
    const finish = (value) => {
      if (!settled) {
        settled = true
        resolvePromise(value)
      }
    }
    let child
    try {
      child = spawn('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, [Environment+SpecialFolderOption]::DoNotVerify)"
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return finish(null)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(null)
    }, 10000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const directory = stdout.replace(/[\r\n]+$/, '').trim()
      finish(directory === '' ? null : directory)
    })
  })
}

/**
 * 解析分区容器目录（不创建）。分区在该目录下逐一分配。
 * @returns {Promise<string>}
 */
async function resolveContainerDirectory() {
  const configured = process.env.DSH_AUTO_WORKSPACE_DIR
  if (configured !== undefined && configured.trim() !== '') {
    return resolve(configured.trim())
  }
  const documents = await queryDocumentsFolder()
  const base = documents ?? join(homedir(), 'Documents')
  return join(base, 'deepseek-harness')
}

/**
 * 一个编号是否已被“活”分区占用。
 *
 * 官方「删除分区」只删注册、保留磁盘目录，所以判断顺序是：
 *   1) `registry` 可用且 `resolveByPath` 命中 → 该目录仍是注册中的分区
 *      （即使没有注册的目录还留在磁盘上，也视为空闲）。
 *   2) `registry` 可用但 `resolveByPath` 报 ENOENT（目录不存在）→ 空闲。
 *   3) `registry` 可用但 `resolveByPath` 因其他原因失败 → 保守：用磁盘探测兜底。
 *   4) `registry` 不可用 → 只靠磁盘探测（目录存在即占用）。
 * @param {string} candidate - 候选目录路径。
 * @param {unknown} registry - ctx.get('workspaceRegistry') 的结果，可能 undefined。
 * @returns {Promise<boolean>} true 表示占用，false 表示可分配。
 */
async function isWorkspacePathTaken(candidate, registry) {
  if (registry !== undefined && registry !== null) {
    try {
      const existing = await registry.resolveByPath(candidate)
      if (existing !== undefined) return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // 目录不存在：既不会注册也没有磁盘占用。
        return false
      }
      // 其他失败（权限、服务尚未启动等）：保守退回磁盘探测。
    }
  }
  // 兜底：磁盘上已存在目录即视为占用（registry 不可用或 resolveByPath 失败时）。
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * 分配流水线：串行化「探测 + 创建」，同一时刻的并发 pick 也不会拿到
 * 同一个目录名（UI 侧还有 directoryBusy 兜底，此处双保险）。
 */
let allocationChain = Promise.resolve()

/**
 * 在容器下分配一个空闲的分区目录路径。
 * 命名：<workspaceName>、<workspaceName>-2、<workspaceName>-3 …
 * 编号回收：某编号目录仍存在但已不再注册（已删除）时，该编号空闲可用。
 * @param {string} container - 容器目录（已存在）。
 * @param {unknown} registry - 可选的 workspaceRegistry 服务。
 * @returns {Promise<string>}
 */
function allocateWorkspaceDirectory(container, registry) {
  const run = allocationChain.then(async () => {
    const baseName = currentBaseName
    for (let index = 1; ; index += 1) {
      const name = index === 1
        ? baseName
        : `${baseName}-${index}`
      const candidate = join(container, name)
      if (!(await isWorkspacePathTaken(candidate, registry))) return candidate
    }
  })
  allocationChain = run.catch(() => {})
  return run
}

/**
 * pick 的实现：分配空闲分区目录、创建并返回规范化路径。
 * @param {AbortSignal | undefined} signal - 调用方生命周期（丢弃：本实现不挂起）。
 * @param {unknown} registry - 可选的 workspaceRegistry 服务。
 * @returns {Promise<string>}
 */
async function pickDefaultDirectory(signal, registry) {
  signal?.throwIfAborted()
  const container = await resolveContainerDirectory()
  await mkdir(container, { recursive: true })
  const directory = await allocateWorkspaceDirectory(container, registry)
  await mkdir(directory, { recursive: true })
  return await realpath(directory)
}

/**
 * 判断一个目录是否允许随分区删除而被物理移除。
 *
 * 安全网（双重保险）：
 *   1) 必须是绝对路径且位于容器目录之内（解析真实容器目录后比较）；
 *   2) 目录名必须匹配「本进程使用过的前缀」或默认 default-workspace
 *      （含 -N 编号形式）。
 * 只有本插件自己创建的分区目录会被删除；用户手动注册的任意目录
 * （例如桌面上的某个项目文件夹）永远不会被触碰。
 * @param {string} directory - 待删除的目录路径。
 * @returns {Promise<boolean>}
 */
async function isDeletableWorkspaceDirectory(directory) {
  if (!isAbsolute(directory)) return false
  const container = await resolveContainerDirectory()
  const base = await realpath(container).catch(() => resolve(container))
  const dir = await realpath(directory).catch(() => null)
  if (dir === null) return false
  const rel = relative(base, dir)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) return false
  for (const allowed of nameHistory) {
    if (new RegExp(`^${escapeRegExp(allowed)}(-\\d+)?$`).test(rel)) return true
  }
  return false
}

/**
 * 包装 workspaceRegistry.delete：官方删除只移除注册、保留磁盘目录。
 * 本插件在注册删除成功后，把该分区自己的容器目录物理删除。
 *
 * 已知顺序问题：加载器可能先挂载本插件行，后挂载提供 workspaceRegistry
 * 的行。所以：
 *   - apply 时先尝试拿一次；
 *   - 拿不到就监听 cordis 的服务变更事件（lazyGet 也会兜底重试）。
 * 若 registry 始终不可用，包装退化为纯透传，删除仍正常（只是不清磁盘）。
 * @param {unknown} ctx - cordis 根上下文。
 * @param {unknown} registry - ctx.get('workspaceRegistry') 的结果。
 * @param {Function} attempt - 包装注册函数（可能被重试调用）。
 */
function wrapRegistryDelete(ctx, registry, attempt) {
  if (registry === undefined || registry === null) return
  const original = registry.delete
  if (original === undefined || original[WRAP_MARK] === true) return
  const removeDirectory = (id, directory) => {
    if (directory === undefined) {
      ctx.logger.warn(`auto-workspace: workspace '${id}' was deleted from the registry but its directory is unknown (cleanup skipped)`)
      return
    }
    // 清理任务串入分配链：删除尚未完成时，下一次「新建分区」的 mkdir
    // 会排队等待，避免 rm 与新目录创建竞态。
    const cleanup = isDeletableWorkspaceDirectory(directory).then(async (allowed) => {
      if (!allowed) return
      try {
        await rm(directory, { recursive: true, force: true })
        ctx.logger.info(`auto-workspace: removed workspace directory ${directory}`)
      } catch (error) {
        ctx.logger.warn(`auto-workspace: failed to remove workspace directory ${directory}: ${String(error)}`)
      }
    }, (error) => {
      ctx.logger.warn(`auto-workspace: cleanup check failed for '${directory}': ${String(error)}`)
    })
    allocationChain = allocationChain.then(() => cleanup, () => cleanup)
  }
  const wrapped = async function (id) {
    // 必须在删除前捕获路径：deleteKnown 会先移除实体再落盘。
    const directory = registry.get?.(id)?.path
    const result = await Reflect.apply(original, this, [id])
    if (result === true) removeDirectory(id, directory)
    return result
  }
  Object.defineProperty(wrapped, WRAP_MARK, { value: true })
  registry.delete = wrapped
  ctx.logger.info('auto-workspace: workspace deletion now also removes the workspace directory (container-only)')
  // 兜底：服务变更后若 registry 被重建（新实例），由 lazyGet 重新包装。
  ctx.events.on('internal/service', (name, value) => {
    if (name !== 'workspaceRegistry' || value === undefined || value === null) return
    if (value === registry) return
    if (value.delete === undefined || value.delete[WRAP_MARK] === true) return
    wrapRegistryDelete(ctx, value, attempt)
  })
  // 标记本次已尝试（lazyGet 后续仍可重试以捕捉新实例）。
  attempt.registry = registry
}

/** 包装标记（避免重复包装 / 识别已包装方法）。 */
const WRAP_MARK = Symbol.for('dsh-auto-workspace.wrappedDelete')

/**
 * 懒获取 registry 并安装包装；拿不到时在 pick 时继续重试。
 * @param {unknown} ctx - cordis 根上下文。
 * @returns {unknown} 当前（可能刚包装好的）registry。
 */
function installDeleteCleanup(ctx, attempt) {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && registry !== null) {
    if (registry.delete !== undefined && registry.delete[WRAP_MARK] !== true) {
      wrapRegistryDelete(ctx, registry, attempt)
    }
  }
  return registry
}

/**
 * @param ctx - 插件上下文（root 作用域）。
 * @param config - cordis config 对象（Config schema 构建，含 get()）。
 */
export function apply(ctx, config) {
  if (process.env.DSH_AUTO_WORKSPACE_DISABLED === '1') return

  // 声明 settings 命名空间（默认 = entry id "auto-workspace"）：插件管理页的
  // 配置卡片经 client 端 configForms 写入，持久化到 profile cordis.patch.yml。
  ctx.effect(
    () => ctx.settings.configure({ auto: false }, ctx.fiber),
    'dsh-auto-workspace: settings scope',
  )

  // 从 cordis config 读取分区名前缀；面板保存后 Loader 触发 volatile-update。
  const applyConfiguredName = () => {
    let name = DEFAULT_WORKSPACE_DIRECTORY
    try {
      name = sanitizeWorkspaceName(config.get().workspaceName)
    } catch {
      name = DEFAULT_WORKSPACE_DIRECTORY
    }
    if (name !== currentBaseName) {
      currentBaseName = name
      nameHistory.add(name)
      ctx.logger.info(`auto-workspace: workspace base name set to "${name}"`)
    }
  }
  applyConfiguredName()
  ctx.on('loader/volatile-update', applyConfiguredName)

  // 包装注册表的 delete：分区删除时连同其容器目录一起移除。
  const attempt = {}
  installDeleteCleanup(ctx, attempt)

  // 能力对象在服务生命周期内保持稳定（消费者可能跨调用捕获）。
  // workspaceRegistry 在 pick 调用时懒获取：无论 Loader 挂载顺序如何，
  // 用户点击时所有行都已挂载完毕，总能拿到（拿不到则退化为磁盘探测）。
  const capability = {
    kind: 'native',
    pick: (signal) => {
      const registry = installDeleteCleanup(ctx, attempt) ?? attempt.registry ?? ctx.get('workspaceRegistry')
      return pickDefaultDirectory(signal, registry)
    }
  }

  // 注册替代的 directoryPicker。第一方 DirectoryPickerController 通过
  // `this.ctx.directoryPicker.capability()` 读取它；`requireCapability("native", "pick")`
  // 校验 kind === "native" 且 pick 存在 —— 本对象满足。
  ctx.provide('directoryPicker', { capability: () => capability })

  ctx.logger.info(
    `auto-workspace: replaced directory picker (native) — each add allocates a free ${currentBaseName}-N under ${process.env.DSH_AUTO_WORKSPACE_DIR ?? '<Documents>\\deepseek-harness'} (base name configurable in the plugin panel; registry-aware number recycling; falls back to directory-existence if the registry is unavailable)`
  )
}
