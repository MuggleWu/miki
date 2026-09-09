// 多工作区（多用户档案）管理器：userData 指针文件的注册表维护 + 启动解析。
// 不 import electron —— 文件系统通过依赖注入，单测用临时目录覆盖全链路；
// 真实接线在 index.ts（fs / dialog / relaunch 薄封装）
import {
  normalizeRegistry,
  removeWorkspace,
  upsertWorkspace,
  type WorkspaceRegistry,
  type WorkspaceStatus
} from '../shared/workspace'

export interface WorkspaceManagerDeps {
  /** 指针文件原文（缺失/损坏 → null，normalize 兜底） */
  readPointer(): unknown
  /** 注册表原子写回指针文件 */
  writePointer(reg: WorkspaceRegistry): void
  /** 目录是否存在 */
  isDirectory(p: string): boolean
  /** 创建目录（mkdir -p，新建工作区/首次引导用） */
  makeDirectory(p: string): void
  /** 默认建议路径（home/miki-base，首次引导预填） */
  defaultSuggestion(): string
  now(): number
}

export type WorkspaceResult = { ok: boolean; error?: string }

export class WorkspaceManager {
  private reg: WorkspaceRegistry

  constructor(private deps: WorkspaceManagerDeps) {
    this.reg = normalizeRegistry(deps.readPointer())
  }

  private save(): void {
    this.deps.writePointer(this.reg)
  }

  private status(needsOnboarding: boolean): WorkspaceStatus {
    return {
      needsOnboarding,
      current: this.reg.current,
      workspaces: this.reg.workspaces.map((w) => ({ ...w })),
      defaultSuggestion: this.deps.defaultSuggestion()
    }
  }

  /** 启动解析：环境变量覆盖 > 有效指针 > 需要引导。返回 null 时调用方不初始化 WorkspaceService，
   * 渲染层经 workspaceStatus 看到引导页。环境变量覆盖只影响当次运行（临时/开发用途），不写入指针文件 */
  resolveInitial(envOverride: string | null): string | null {
    if (envOverride) return envOverride
    if (this.reg.current && this.deps.isDirectory(this.reg.current)) {
      const p = this.reg.current
      this.reg = upsertWorkspace(this.reg, p, this.deps.now())
      this.save()
      return p
    }
    return null
  }

  /** 当前状态；needsOnboarding 由调用方给出（= 主进程尚未初始化工作区服务） */
  getStatus(needsOnboarding: boolean): WorkspaceStatus {
    return this.status(needsOnboarding)
  }

  /** 首次引导确认：创建（或复用）文件夹并设为当前 */
  confirmOnboarding(p: string): WorkspaceResult {
    if (!p) return { ok: false, error: '路径为空' }
    try {
      this.deps.makeDirectory(p)
    } catch (e) {
      return { ok: false, error: `无法创建文件夹：${String(e)}` }
    }
    this.reg = upsertWorkspace(this.reg, p, this.deps.now())
    this.reg.current = p
    this.save()
    return { ok: true }
  }

  /** 登记工作区：文件夹不存在则创建（mkdir -p）；不改变 current（切换走 switchTo） */
  add(p: string): WorkspaceResult {
    if (!p) return { ok: false, error: '路径为空' }
    try {
      this.deps.makeDirectory(p)
    } catch (e) {
      return { ok: false, error: `无法创建文件夹：${String(e)}` }
    }
    this.reg = upsertWorkspace(this.reg, p, this.deps.now())
    this.save()
    return { ok: true }
  }

  /** 切换当前工作区（写指针；重启落地由调用方负责） */
  switchTo(p: string): WorkspaceResult {
    if (!p) return { ok: false, error: '路径为空' }
    if (!this.deps.isDirectory(p)) return { ok: false, error: '文件夹不存在' }
    if (p === this.reg.current) return { ok: false, error: '已是当前工作区' }
    this.reg = upsertWorkspace(this.reg, p, this.deps.now())
    this.reg.current = p
    this.save()
    return { ok: true }
  }

  /** 从列表移除（当前生效的工作区不可移除，防止产生无主状态） */
  remove(p: string): WorkspaceResult {
    if (p === this.reg.current) return { ok: false, error: '不能移除当前工作区' }
    this.reg = removeWorkspace(this.reg, p)
    this.save()
    return { ok: true }
  }
}
