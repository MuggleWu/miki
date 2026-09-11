// 移动版工作区路径规则：与桌面端 WorkspacePaths 完全同构，只是用 POSIX 相对路径
// （FileStore 的路径统一相对于应用私有目录，见 fs/types.ts）。
export class MobilePaths {
  constructor(readonly root: string) {}

  decksFile(): string {
    return `${this.root}/decks.json`
  }

  deckCardsFile(deckId: string): string {
    return `${this.root}/cards/${deckId}.ndjson`
  }

  deckDeltaFile(deckId: string): string {
    return `${this.root}/cards/${deckId}.delta.ndjson`
  }

  cardsDir(): string {
    return `${this.root}/cards`
  }

  logDir(): string {
    return `${this.root}/review-log`
  }

  /** review-log 按月分文件（与桌面端同名规则，跨机才可能合并同一文件） */
  logFile(t: number): string {
    const d = new Date(t)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${this.root}/review-log/${d.getFullYear()}-${p(d.getMonth() + 1)}.ndjson`
  }

  configFile(): string {
    return `${this.root}/config.json`
  }
}
