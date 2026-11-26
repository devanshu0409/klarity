import type { KlarityApi } from '@shared/ipc'

declare global {
  interface Window {
    klarity: KlarityApi
  }
}

export {}
