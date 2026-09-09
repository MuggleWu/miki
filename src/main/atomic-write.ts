// 主进程共用的原子文件写：先写 .tmp 再改名，防半写文件。
// 统一 0600：config.json 含 API token，指针/端口文件无敏感字段但收紧无害。
import * as fs from 'node:fs'

export function atomicWrite(file: string, data: string): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, file)
}
