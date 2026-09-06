import type { MikiApi } from '../../shared/ipc'

declare global {
  interface Window {
    miki: MikiApi
  }
}

export {}
