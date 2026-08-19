import type { HarborBridge } from '../shared/ipc.js'

declare global {
  interface Window {
    harbor: HarborBridge
  }
}

export {}
