import { exec as execCb, execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import type { ContainerInvocation, ContainerRuntimeDriver } from './types.js'

const exec = promisify(execCb)
const execFile = promisify(execFileCb)

/** Ask a specific Docker context for its server version. */
async function daemonResponds(context?: string): Promise<boolean> {
  const env = context ? { ...process.env, DOCKER_CONTEXT: context } : process.env
  return execFile('docker', ['version', '--format', '{{.Server.Version}}'], { env, timeout: 8000 })
    .then((r) => r.stdout.trim().length > 0)
    .catch(() => false)
}

/** Whether a Docker context of this name is registered. */
async function hasContext(name: string): Promise<boolean> {
  return exec('docker context ls --format "{{.Name}}"', { timeout: 8000 })
    .then((r) => r.stdout.split('\n').some((l) => l.trim() === name))
    .catch(() => false)
}

function dockerInvocation(context: string): ContainerInvocation {
  // Selected per call rather than by switching the user's global context: their
  // terminal keeps pointing wherever they left it.
  return { bin: 'docker', compose: ['compose'], env: { DOCKER_CONTEXT: context } }
}

/**
 * The default on most Macs, and the only one here that Harbor cannot start:
 * it is a GUI application, and launching someone's Docker Desktop without
 * asking is not Harbor's call.
 */
export const DOCKER_DESKTOP: ContainerRuntimeDriver = {
  id: 'docker-desktop',
  displayName: 'Docker Desktop',
  description: 'The standard Docker distribution for macOS',
  install: 'brew install --cask docker',
  async detect() {
    const installed = existsSync('/Applications/Docker.app')
    if (!installed) return { installed: false, version: null }
    const version = await exec('docker version --format "{{.Server.Version}}"', { timeout: 8000 })
      .then((r) => r.stdout.trim())
      .catch(() => null)
    return { installed: true, version }
  },
  running: () => daemonResponds('desktop-linux'),
  invocation: () => dockerInvocation('desktop-linux')
}

/**
 * A drop-in Docker replacement that is markedly lighter on battery and memory.
 * Registers its own context, so nothing else changes.
 */
export const ORBSTACK: ContainerRuntimeDriver = {
  id: 'orbstack',
  displayName: 'OrbStack',
  description: 'Fast, light Docker and Linux for macOS',
  install: 'brew install --cask orbstack',
  async detect() {
    const installed = existsSync('/Applications/OrbStack.app') || (await hasContext('orbstack'))
    return { installed, version: null }
  },
  running: () => daemonResponds('orbstack'),
  invocation: () => dockerInvocation('orbstack')
}

/**
 * Scriptable and headless, which is why Harbor can start this one itself.
 */
export const COLIMA: ContainerRuntimeDriver = {
  id: 'colima',
  displayName: 'Colima',
  description: 'Container runtimes on Lima VMs — no GUI, scriptable',
  install: 'brew install colima docker',
  async detect() {
    const version = await exec('colima version', { timeout: 8000 })
      .then((r) => r.stdout.trim().split('\n')[0] ?? null)
      .catch(() => null)
    return { installed: version !== null, version }
  },
  running: () => daemonResponds('colima'),
  async start() {
    // Modest by default: this is a laptop, and the VM's ceiling is the ceiling
    // for every service a project runs.
    await exec('colima start --cpu 2 --memory 4', { maxBuffer: 16 * 1024 * 1024 })
  },
  invocation: () => dockerInvocation('colima')
}

/**
 * The one that is genuinely different: its own CLI, its own machine, and a
 * compose implementation that delegates to an external provider.
 */
export const PODMAN: ContainerRuntimeDriver = {
  id: 'podman',
  displayName: 'Podman',
  description: 'Daemonless containers; compose support depends on a provider',
  install: 'brew install podman podman-compose',
  async detect() {
    const version = await exec('podman --version', { timeout: 8000 })
      .then((r) => r.stdout.trim().replace(/^podman version\s*/i, ''))
      .catch(() => null)
    return { installed: version !== null, version }
  },
  async running() {
    return exec('podman info --format "{{.Host.Arch}}"', { timeout: 12_000 })
      .then((r) => r.stdout.trim().length > 0)
      .catch(() => false)
  },
  async start() {
    // Podman needs a VM on macOS before anything can run.
    await exec('podman machine start', { maxBuffer: 16 * 1024 * 1024 })
  },
  // No DOCKER_CONTEXT: podman is not talking to a Docker daemon at all.
  invocation: () => ({ bin: 'podman', compose: ['compose'], env: {} })
}

export const CONTAINER_RUNTIMES: ContainerRuntimeDriver[] = [
  DOCKER_DESKTOP,
  ORBSTACK,
  COLIMA,
  PODMAN
]
