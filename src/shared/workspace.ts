// 多工作区（多用户档案）纯逻辑：指针文件读写形态、注册表增删、路径展示名。
// 本文件禁止 import electron / node:* —— 单测在纯 node 环境覆盖，主进程 glue 只做文件与对话框薄封装

/** 一个已记住的工作区 = 一份完整用户档案（config.json + 牌组 + 卡片 + 复习记录） */
export interface WorkspaceEntry {
  /** 工作区绝对路径（注册表主键） */
  path: string
  /** 展示名 = 文件夹名（落盘冗余，方便人工查看指针文件） */
  name: string
  /** 最近一次使用时间（ms epoch），列表按此降序 */
  lastOpenedAt: number
}

export interface WorkspaceRegistry {
  /** 当前生效的工作区；null = 尚未选择（首次启动） */
  current: string | null
  /** 已记住的工作区（含当前），按 lastOpenedAt 降序 */
  workspaces: WorkspaceEntry[]
}

/** 渲染层查询的工作区状态（IPC workspaceStatus / 引导确认后返回） */
export interface WorkspaceStatus {
  /** 尚未选定有效工作区（首次启动/指针失效），渲染层应显示引导页 */
  needsOnboarding: boolean
  current: string | null
  workspaces: WorkspaceEntry[]
  /** 引导页输入框预填的建议路径 */
  defaultSuggestion: string
}

/**
 * 加载期数据损坏摘要（IPC dataDamageReport）。
 * 坏行一旦存在，app 仍能启动、但被跳过的行会悄悄影响内容与统计数字；之前完全没有出口，
 * 用户只会觉得「数字对不上」而不知道有数据坏了——这个结构就是那个出口。
 */
export interface DamageReport {
  /** 无法 JSON.parse 的非空行总数（这些行的效果已丢失） */
  damagedLines: number
  /** 末尾缺换行的文件（相对工作区路径）：多半是追加写被中断，最后一条可能只写了一半 */
  truncatedFiles: string[]
  /** 含坏行的文件（相对工作区路径，最多 5 个，按发现顺序） */
  files: string[]
}

/** 没有损坏时的空报告（渲染层判断要不要显示提示只看 damagedLines/truncatedFiles） */
export const NO_DAMAGE: DamageReport = { damagedLines: 0, truncatedFiles: [], files: [] }

/** 展示名 = 末段文件夹名；兼容 / 与 \ 分隔 */
export function workspaceName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}
/** 首次启动引导的默认建议路径（纯字符串拼接，不探测存在性） */
export function defaultWorkspaceSuggestion(home: string, sep: string): string {
  return home.endsWith(sep) ? `${home}miki-base` : `${home}${sep}miki-base`
}

/** 原地登记工作区：已有条目只刷新时间戳（取较大值），没有则追加 */
function upsertInPlace(reg: WorkspaceRegistry, p: string, lastOpenedAt: number): void {
  const existing = reg.workspaces.find((w) => w.path === p)
  if (existing) {
    if (lastOpenedAt > existing.lastOpenedAt) existing.lastOpenedAt = lastOpenedAt
    return
  }
  reg.workspaces.push({ path: p, name: workspaceName(p), lastOpenedAt })
}

function sortByRecency(reg: WorkspaceRegistry): void {
  reg.workspaces.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.path.localeCompare(b.path))
}

/** 指针文件原文 → 注册表：信任边界校验，坏字段一律丢弃。兼容旧格式 {workspacePath}（升级为一条记录 + current） */
export function normalizeRegistry(raw: unknown): WorkspaceRegistry {
  const reg: WorkspaceRegistry = { current: null, workspaces: [] }
  if (typeof raw !== 'object' || raw === null) return reg
  const o = raw as Record<string, unknown>
  if (typeof o.workspacePath === 'string' && o.workspacePath) {
    upsertInPlace(reg, o.workspacePath, 0)
    reg.current = o.workspacePath
  }
  if (typeof o.current === 'string' && o.current) reg.current = o.current
  if (Array.isArray(o.workspaces)) {
    for (const it of o.workspaces) {
      if (typeof it !== 'object' || it === null) continue
      const e = it as Record<string, unknown>
      if (typeof e.path !== 'string' || !e.path) continue
      upsertInPlace(
        reg,
        e.path,
        typeof e.lastOpenedAt === 'number' && Number.isFinite(e.lastOpenedAt) ? e.lastOpenedAt : 0
      )
    }
  }
  // 指针指向的工作区丢失记录时自愈补一条（旧版本升级 / 手工编辑残缺）
  if (reg.current && !reg.workspaces.some((w) => w.path === reg.current)) {
    upsertInPlace(reg, reg.current, 0)
  }
  sortByRecency(reg)
  return reg
}

/** 登记或刷新使用时间；返回新注册表（不改入参），并保持按最近使用降序 */
export function upsertWorkspace(reg: WorkspaceRegistry, p: string, now: number): WorkspaceRegistry {
  const next: WorkspaceRegistry = {
    current: reg.current,
    workspaces: reg.workspaces.map((w) => ({ ...w }))
  }
  upsertInPlace(next, p, now)
  sortByRecency(next)
  return next
}

/** 从列表移除工作区；移除的是 current 时 current 一并置空（调用方需保证不产生无主状态） */
export function removeWorkspace(reg: WorkspaceRegistry, p: string): WorkspaceRegistry {
  return {
    current: reg.current === p ? null : reg.current,
    workspaces: reg.workspaces.filter((w) => w.path !== p)
  }
}
