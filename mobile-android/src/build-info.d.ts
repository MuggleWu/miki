// 构建戳的全局注入声明：值由 vite.config.ts 的 define 在打包时替换（见那里的 buildStamp 说明）。
// 这里只声明类型，让 tsc --noEmit 认识这个全局常量。
declare const __MIKI_BUILD__: {
  /** 移动端 package.json 的 version */
  version: string
  /** 打包时的短 commit（没有 git 元数据时为 unknown） */
  hash: string
  /** 打包时间（ISO 字符串） */
  at: string
}
