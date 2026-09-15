// 主进程共用的原子文件写：先写 .tmp 再改名，防半写文件。
// 统一 0600：写出的文件只读属主。config.json 随工作区 git 仓库同步，权限收紧是防御性兜底。
import * as fs from 'node:fs'

export function atomicWrite(file: string, data: string): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, file)
}
