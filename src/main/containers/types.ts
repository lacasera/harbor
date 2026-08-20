import type { ContainerRuntimeId } from '../../shared/container-runtime.js'

/** How to invoke a runtime's CLI for compose work. */
export interface ContainerInvocation {
  /** The CLI binary: `docker` for most, `podman` for Podman. */
  bin: string
  /** Sub-command that reaches compose, e.g. `['compose']`. */
  compose: string[]
  /**
   * Environment for the call. Docker-compatible runtimes are selected with
   * `DOCKER_CONTEXT`, which points this invocation at one daemon without
   * touching the context the user's own terminal uses.
   */
  env: Record<string, string>
}

/**
 * A container runtime Harbor can run services on.
 *
 * Docker Desktop, OrbStack and Colima all speak the same CLI and differ only in
 * how they are detected, started, and which Docker context they register — so
 * the interface is about those three things, not about compose. Podman is the
 * one that genuinely differs, which is why the invocation is part of the
 * contract rather than assumed.
 */
export interface ContainerRuntimeDriver {
  id: ContainerRuntimeId
  displayName: string
  description: string
  /** Command that installs it, or null when Harbor should not offer to. */
  install: string | null
  /** Present on this machine, and its version if it can be read. */
  detect(): Promise<{ installed: boolean; version: string | null; detail?: string }>
  /** Whether its daemon is responding right now. */
  running(): Promise<boolean>
  /** Start the daemon. Absent when only the user can (a GUI app, say). */
  start?(): Promise<void>
  invocation(): ContainerInvocation
}
