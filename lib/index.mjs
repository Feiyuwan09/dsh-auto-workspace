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
 *   - 运行时依赖：@deepseek-ai/schemastery（Config schema）、
 *     @deepseek-ai/dsh-session-format（当前代日志文件名）、
 *     @deepseek-ai/dsh-typert-protocol（Remote 服务基类与 RemoteError）。
 *     三者都在 app.asar 的安装依赖闭包里，DSH 启动时的 runtime
 *     interception 把它们路由到安装目录，profile node_modules 里无需
 *     （也不会有）拷贝；zstd 帧扫描/路径编码用 node: 内置模块逐行复刻
 *     官方实现，不引入 @deepseek-ai/dsh-session-persistence-jsonl。
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
import { access, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { constants as zstdConstants, zstdCompress, zstdDecompress } from 'node:zlib'
import { sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
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

//#region lib/types/host/session-move.js
/**
 * 「把旧工作区的会话移动到新工作区」的 Host 半边。
 *
 * 会话归属是三件必须一起改的东西（只改其一必坏）：
 *   1) 日志首行 header.cwd（会话格式 v4 的 immutable 元数据，写入后无 setter）；
 *   2) 物理日志目录 `<root>/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl[.zstd]`；
 *   3) workspace.json 中两个分区的 sessionIds 记账。
 * 本服务把三者按顺序原子推进：先改写 header 帧（落盘到新目录），再移动目录，
 * 最后改注册表（旧分区 detach + 新分区 attach）。任何一步失败都会在进入
 * 下一步之前抛错，保证不会出现「header 指向新 cwd 但目录还在旧位置」的
 * 半吊子状态（改写是在临时目录里完成、原子 rename 进新目录，旧目录在
 * rename 之前原封不动）。
 *
 * 与第一方 archiveSession 相同的活跃检查：`workspace/session-activity`
 * waterfall 有任何一个 provider 报告活跃（正在跑的回合/子代理/后台任务），
 * 一律拒绝移动 —— 活跃会话的日志正在被追加，改 cwd 会造成写锁与损坏。
 * 只有「冷」会话（关掉的对话）可以移动。
 *
 * 只支持当前代的 zstd 物理日志（`session.v4.jsonl.zstd`）：重写第一个帧
 * （header 行）并把后续帧原样拼回。会话目录里若没有当前代文件则报
 * UNSUPPORTED（旧代 v0-v3 或 plaintext 压缩不移动），绝不猜测。
 *
 * RPC 面：`autoWorkspace/move` 与 `autoWorkspace/listWorkspaces`。
 * 本服务不用 ES 装饰器（Node 22 / 插件内无编译步骤），而是手写
 * typert-protocol 的 Remote 方法描述符 —— 与 `@Remote` 生成的标记
 * 逐字节同构（version: 1 + methods + invocation: { kind: "direct" }）。
 * @module dsh-auto-workspace/session-move
 */

/** 当前会话格式代：只有 v4 的 zstd 日志会被移动（与官方 logPath 一致）。 */
const SESSION_FORMAT_VERSION = 4
/** 官方当前代文件名（zstd 压缩）：`session.v4.jsonl.zstd`。 */
const CURRENT_GENERATION_FILENAME = `${sessionFormatLogFilename(SESSION_FORMAT_VERSION)}.zstd`
/** Zstandard 帧魔数（0xFD2FB528 小端读取）。 */
const ZSTD_MAGIC = 4247762216

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
/** 官方 CHECKSUM_OPTIONS：帧校验和开启（与官方 compressZstdFrame 一致）。 */
const ZSTD_CHECKSUM_OPTIONS = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }

/**
 * 官方 encodeSegment 的逐行复刻（dsh-session-persistence-jsonl format L858）：
 * 会话 id → 单个安全路径段。`.`/`..` 特判、`~` 与不安全单元 → `~XXXX`。
 * @param {string} raw - 会话 id（非空）。
 * @returns {string} 可直接拼入路径的单段名。
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 官方 projectKey 的逐行复刻（L880）：cwd → 可读的项目目录名。
 * 分隔符 `/`、`\`、`:` → `-`（连续折叠）；不安全单元 → `~XXXX`；
 * 结果 `--…--`（去掉前导 `-`，空则 "root"，截断到 251）。
 * @param {string} cwd - 绝对路径。
 * @returns {string} 会话日志根下的项目目录名。
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 官方 scanZstdFrames 的逐行复刻（L1305）：不解压块，只按帧结构走到
 * 帧边界。完整帧返回 { start, end }；帧尾残缺返回 tornStart。
 * @param {Buffer} buffer - 完整会话文件字节。
 * @param {number} maxFrames - 完整帧数上限（元数据读取只需第 1 帧）。
 * @returns {{frames: Array<{start: number, end: number}>, tornStart?: number}}
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * 校验一个移动后的 header 对象仍满足官方 isHeaderLine 的约束
 * （required 键、键白名单、各字段类型）。移动只改 cwd 的值，这里做
 * 落盘前的最终保险。
 * @param {Record<string, unknown>} line - 解析出的 header 行。
 * @returns {boolean}
 */
function isHeaderLine(line) {
  const HEADER_REQUIRED_KEYS = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth']
  const HEADER_OPTIONAL_KEYS = ['cwd', 'parentSession', 'origin', 'agentPreset']
  const HEADER_KEYS = new Set([...HEADER_REQUIRED_KEYS, ...HEADER_OPTIONAL_KEYS])
  return (
    typeof line === 'object' && line !== null && !Array.isArray(line)
    && HEADER_REQUIRED_KEYS.every((key) => Object.hasOwn(line, key))
    && Object.keys(line).every((key) => HEADER_KEYS.has(key))
    && line.type === 'session'
    && typeof line.version === 'number'
    && typeof line.id === 'string'
    && typeof line.createdAt === 'number' && Number.isSafeInteger(line.createdAt) && line.createdAt >= 0 && !Object.is(line.createdAt, -0)
    && typeof line.delegationDepth === 'number' && Number.isSafeInteger(line.delegationDepth) && line.delegationDepth >= 0 && !Object.is(line.delegationDepth, -0)
    && (line.cwd === undefined || typeof line.cwd === 'string' && isAbsolute(line.cwd))
    && (line.parentSession === undefined || typeof line.parentSession === 'string')
    && typeof line.isSeeded === 'boolean'
    && (line.origin === undefined || line.origin === 'subagent')
    && (line.agentPreset === undefined || typeof line.agentPreset === 'string')
  )
}

/**
 * 只读校验当前代日志的 header 帧，返回解析出的 header 对象。
 * 不解压事件帧（第 2 帧起全部原样搬运，逐字节不变）。
 * 解压后必须「以唯一 \n 结尾、前面没有其它换行」（官方
 * parseHeaderRecord 的约束：header 帧 = 一条 JSONL 行 + \n）。
 * @param {Buffer} bytes - 完整日志文件字节。
 * @returns {Promise<Record<string, unknown>>}
 */
async function readCurrentHeader(bytes) {
  const { frames } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('session log has no complete frames')
  const first = frames[0]
  const plaintext = await zstdDecompressAsync(bytes.subarray(first.start, first.end))
  if (plaintext.length === 0 || plaintext[plaintext.length - 1] !== 10) throw new Error('session log header does not end with a newline')
  if (plaintext.indexOf(10) !== plaintext.length - 1) throw new Error('session log header line is not a single record')
  const text = plaintext.subarray(0, -1).toString('utf8')
  let line
  try {
    line = JSON.parse(text)
  } catch (error) {
    throw new Error(`session log header is not valid JSON: ${String(error)}`)
  }
  if (!isHeaderLine(line)) throw new Error('session log header failed validation')
  if (line.version !== SESSION_FORMAT_VERSION) throw new Error(`session log header is v${String(line.version)}, expected v${SESSION_FORMAT_VERSION}`)
  return line
}

/**
 * 重写 header 帧：只把 cwd 的值换成目标分区路径，其余字段与键序
 * 全部保留（JSON.parse 保留插入序，重新 stringify 后字节级稳定），
 * 再用与官方完全相同的压缩参数（校验和开启）压回一个帧。
 * @param {Record<string, unknown>} header - 校验过的 header 对象。
 * @param {string} targetPath - 目标分区的 canonical 路径。
 * @returns {Promise<Buffer>} 新 header 帧。
 */
async function rewriteHeaderFrame(header, targetPath) {
  const line = { ...header, cwd: targetPath }
  const text = `${JSON.stringify(line)}\n`
  return zstdCompressAsync(Buffer.from(text, 'utf8'), ZSTD_CHECKSUM_OPTIONS)
}

/** 远端错误码前缀（全部挂在 autoWorkspace/ 下，客户端可稳定判别）。 */
const ERR = {
  active: 'autoWorkspace/session-active',
  unknown: 'autoWorkspace/session-unknown',
  workspace: 'autoWorkspace/workspace-unknown',
  same: 'autoWorkspace/same-workspace',
  unsupported: 'autoWorkspace/unsupported-log',
  io: 'autoWorkspace/io-failure'
}

/**
 * 「移动会话到另一分区」的 Remote 服务。
 *
 * 服务键 `autoWorkspaceSessionMove`（cordis 内部名字），wire namespace
 * `autoWorkspace`：客户端经 `connection.rpc.call("/api", "autoWorkspace/move",
 * { args: { sessionId, workspaceId } })` 调用（SRC 模式没有 strict 编解码
 * contribution，客户端无法 $mount 生成的面，只能直连 rpc 通道）。
 *
 * 参数必须全部是普通标识符且 signal 在最后 —— 网关用
 * Function.prototype.toString 解析参数名做 src-json 编解码。
 */
class SessionMoveService extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'sessionPersistence']

  constructor(ctx) {
    super(ctx, 'autoWorkspaceSessionMove', { namespace: 'autoWorkspace' })
  }

  /**
   * 把会话的物理日志与注册记账从旧分区迁到目标分区。
   * 步骤（见模块注释）：活跃检查 → 校验会话与目标分区 → 读 header →
   * 在目标分区项目目录下写临时文件（重写 cwd 的 header 帧 + 原事件帧）→
   * 原子 rename 到目标会话目录 → 删除旧目录 → 更新注册表缓存 →
   * 旧分区 detach、目标分区 attach（或 mutate 置顶）。
   * @param {string} sessionId - 会话 id。
   * @param {string} workspaceId - 目标分区 id。
   * @param {AbortSignal | undefined} signal - 网关自动注入的调用生命周期。
   * @returns {Promise<{sessionId: string, workspaceId: string, path: string}>}
   */
  async move(sessionId, workspaceId, signal) {
    signal?.throwIfAborted()
    if (typeof sessionId !== 'string' || sessionId === '') throw new RemoteError(ERR.unknown, 'sessionId must be a non-empty string')
    if (typeof workspaceId !== 'string' || workspaceId === '') throw new RemoteError(ERR.workspace, 'workspaceId must be a non-empty string')
    const registry = this.ctx.get('workspaceRegistry')
    const persistence = this.ctx.get('sessionPersistence')
    if (registry === undefined || registry === null) throw new RemoteError(ERR.io, 'workspaceRegistry service is unavailable')
    if (persistence === undefined || persistence === null) throw new RemoteError(ERR.io, 'sessionPersistence service is unavailable')

    // 0) 活跃会话（当前打开在 UI 里、日志还在被追加）直接拒绝：
    //    移动会改 header.cwd，与活跃写入者竞争同一文件必然损坏。
    const sessions = this.ctx.get('sessions')
    if (sessions?.get(sessionId) !== undefined) {
      throw new RemoteError(ERR.active, `cannot move session '${sessionId}': the session is open in this runtime; close it before moving`)
    }

    // 1) 活跃检查：与官方 archiveSession 同一个 waterfall。
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    if (activity.length > 0) {
      throw new RemoteError(
        ERR.active,
        `cannot move session '${sessionId}': the session is active (${activity.map((entry) => entry.kind).join(', ')})`,
        { activity },
      )
    }

    // 2) 会话必须存在且是「冷」会话；目标分区必须存在且不是当前分区。
    //    （header.cwd 是创建时经 realpath 正规化的绝对路径；官方索引在
    //    indexHeader 里又对会话路径做了 realpathNormalize 后再对比。）
    const header = await registry.readSessionHeader(sessionId).catch((error) => {
      throw new RemoteError(ERR.unknown, `cannot move session '${sessionId}': ${String(error)}`)
    })
    if (header.cwd === undefined) throw new RemoteError(ERR.unsupported, `cannot move session '${sessionId}': its stored header carries no cwd`)
    const target = registry.get(workspaceId)
    if (target === undefined) throw new RemoteError(ERR.workspace, `workspace '${workspaceId}' does not exist`)
    // 会话自己记录的 canonical cwd（header.cwd 不是绝对路径时直接拒绝）。
    if (!isAbsolute(header.cwd)) throw new RemoteError(ERR.unsupported, `cannot move session '${sessionId}': its header cwd '${header.cwd}' is not absolute`)
    const targetCanonical = await realpath(target.path).catch((error) => {
      throw new RemoteError(ERR.workspace, `workspace '${workspaceId}' path does not resolve: ${String(error)}`)
    })
    if (header.cwd === targetCanonical) throw new RemoteError(ERR.same, `session '${sessionId}' already lives in workspace '${workspaceId}'`)

    // 3) 解析物理路径。旧路径由 header.cwd 拼出（正是官方 logPath /
    //    assertStoredIdentity 的键）；新路径由目标 canonical 路径拼出。
    //    移动前旧路径必须 realpath 可解析（文件在磁盘上）。
    const root = resolve(persistence.root ?? '')
    const oldDir = join(root, projectKey(header.cwd), encodeSegment(sessionId))
    const targetDir = join(root, projectKey(targetCanonical), encodeSegment(sessionId))
    const sourcePath = join(oldDir, CURRENT_GENERATION_FILENAME)
    const finalPath = join(targetDir, CURRENT_GENERATION_FILENAME)
    const targetProjectDir = join(root, projectKey(targetCanonical))

    // 4) 读旧文件（只支持当前代 zstd；目标若已存在则冲突拒绝）。
    let bytes
    try {
      bytes = await readFile(sourcePath)
    } catch (error) {
      throw new RemoteError(
        ERR.unsupported,
        `cannot move session '${sessionId}': reading its current generation failed (${String(error)}). Only current-generation zstd logs can be moved`,
      )
    }
    try {
      await access(targetDir)
      throw new RemoteError(ERR.io, `cannot move session '${sessionId}': the target session directory already exists at ${targetDir}`)
    } catch (error) {
      if (error instanceof RemoteError) throw error
      // 只吞 ENOENT；其它 errno（EACCES 等）一律转成 io-failure。
      if (error?.code !== 'ENOENT') {
        throw new RemoteError(ERR.io, `cannot move session '${sessionId}': probing the target directory failed: ${String(error)}`)
      }
    }

    // 5) 重写 header 帧并把事件帧原样拼回。
    //    只扫描 1 帧（maxFrames=1）：只拿 header 帧边界，不解压其余帧，
    //    大日志也不会被线性扫描。
    const line = await readCurrentHeader(bytes).catch((error) => {
      throw new RemoteError(ERR.unsupported, `cannot move session '${sessionId}': ${String(error)}`)
    })
    if (line.cwd === undefined) throw new RemoteError(ERR.unsupported, `cannot move session '${sessionId}': its header carries no cwd`)
    if (line.id !== sessionId) throw new RemoteError(ERR.unsupported, `cannot move session '${sessionId}': its header records a different session id ('${String(line.id)}')`)
    if (line.cwd !== header.cwd) {
      throw new RemoteError(ERR.unsupported, `cannot move session '${sessionId}': its header line cwd ('${String(line.cwd)}') disagrees with the registry index ('${String(header.cwd)}')`)
    }
    const newHeaderFrame = await rewriteHeaderFrame(line, targetCanonical).catch((error) => {
      throw new RemoteError(ERR.io, `cannot move session '${sessionId}': header rewrite failed: ${String(error)}`)
    })
    const { frames } = scanZstdFrames(bytes, 1)
    if (frames.length < 1) throw new RemoteError(ERR.unsupported, `cannot move session '${sessionId}': the log has no complete header frame`)
    const eventBytes = bytes.subarray(frames[0].end)
    const output = Buffer.concat([newHeaderFrame, eventBytes])

    // 6) 落盘：mkdir -p 目标项目目录，写临时文件，原子 rename 进目标会话目录。
    const tmpName = `.${CURRENT_GENERATION_FILENAME}.move-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    const tmpPath = join(targetProjectDir, tmpName)
    try {
      await mkdir(targetProjectDir, { recursive: true })
      await writeFile(tmpPath, output)
      await mkdir(targetDir, { recursive: true })
      await rename(tmpPath, finalPath)
    } catch (error) {
      await unlink(tmpPath).catch(() => {})
      throw new RemoteError(ERR.io, `cannot move session '${sessionId}': writing the rewritten log failed: ${String(error)}`)
    }

    // 7) 删除旧会话目录（当前代文件已迁走；旧代文件与残留一并移除）。
    //    旧项目目录就是 oldDir 的父目录，顺手清理（best-effort）。
    const oldProjectDir = join(root, projectKey(header.cwd))
    try {
      await rm(oldDir, { recursive: true, force: true })
      const entries = await readdir(oldProjectDir).catch(() => [])
      if (entries.length === 0) await rmdir(oldProjectDir).catch(() => {})
    } catch (error) {
      this.ctx.logger.warn(`auto-workspace: session '${sessionId}' moved, but removing its old directory failed: ${String(error)}`)
    }

    // 8) 记账准备：oldEntity 必须在缓存更新**之前**解析 —— entity.sessionIds
    //    getter 按 candidateMatches(sessionPaths) 过滤，rememberSessionPath
    //    指向新路径后旧 entity 会立刻「看不见」该会话，detach 就落空了。
    const oldEntity = [...registry.entities.values()].find((entity) => entity.sessionIds.includes(sessionId))

    // 9) 注册表缓存：headers/sessionPaths 指向新位置。
    //    headers 是 readSessionHeader 的二级缓存：目标分区注册里的
    //    sessionIds 仍含本会话（旧分区 detach 前），readSessionHeader
    //    的 live→headers 短路会返回旧 cwd header —— 必须清掉。
    //    rememberSessionPath 挂在 registry.host 上（WorkspaceEntity 的
    //    宿主面），不是 registry 实例方法。
    registry.headers.delete(sessionId)
    registry.sessionPaths.delete(sessionId)
    registry.missingSessionPaths.delete(sessionId)
    registry.invalidSessionPaths.delete(sessionId)
    registry.host.rememberSessionPath(sessionId, targetCanonical)

    // 10) 记账：旧分区 detach，目标分区 attach（读取新 header 校验后置顶）。
    if (oldEntity !== undefined && oldEntity.id !== workspaceId) {
      await oldEntity.detachSession(sessionId).catch((error) => {
        throw new RemoteError(ERR.io, `cannot move session '${sessionId}': detaching from the old workspace failed: ${String(error)}`)
      })
    }
    await target.attachSession(sessionId).catch((error) => {
      throw new RemoteError(ERR.io, `cannot move session '${sessionId}': attaching to workspace '${workspaceId}' failed: ${String(error)}`)
    })

    this.ctx.logger.info(`auto-workspace: moved session '${sessionId}' from '${header.cwd}' to workspace '${workspaceId}' ('${targetCanonical}')`)
    return { sessionId, workspaceId, path: targetCanonical }
  }

  /**
   * 列出全部分区（供客户端弹窗渲染目标列表）。
   * @param {AbortSignal | undefined} signal - 调用生命周期。
   * @returns {Promise<Array<{workspaceId: string, title: string, path: string}>>}
   */
  async listWorkspaces(signal) {
    signal?.throwIfAborted()
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined || registry === null) return []
    return registry.list().map((entity) => ({
      workspaceId: entity.id,
      title: entity.title,
      path: entity.path
    }))
  }
}

// 手写 Remote 方法描述符（与 `@Remote` 生成的标记同构）。ES 装饰器语法
// 需要编译步骤，插件里直接用 defineProperty 挂在原型上，gateway 的
// remoteMethods() 读取的就是这个自有属性。
Object.defineProperty(SessionMoveService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'move', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'listWorkspaces', invocation: Object.freeze({ kind: 'direct' }) })
    ])
  })
})
//#endregion

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

  // 注册「会话移动到新分区」的 Remote 服务。ctx.plugin(Class) 返回 fiber：
  // 同步段完成 inject 检查与 _reload 启动；SessionMoveService 在下一个微任务
  // 里构造（super(ctx, key) → provide → internal/service → gateway 重置
  // srcClaims）。inject 缺服务时 fiber 保持待激活，等服务 provider 出现后
  // cordis 自动 notify → _reload → 构造。两边都不用等待。
  ctx.plugin(SessionMoveService)

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
