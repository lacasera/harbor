export type ContainerRuntimeId = 'docker-desktop' | 'orbstack' | 'colima' | 'podman' | (string & {})

/** Wire-safe description of a container runtime, sent to the renderer. */
export interface ContainerRuntimeDescriptor {
  id: ContainerRuntimeId
  displayName: string
  description: string
  installed: boolean
  running: boolean
  /** The tool's own version, when it can be read. */
  version: string | null
  /** What was found, in the user's terms. */
  detail: string
  /** The command that installs it, for the UI to offer. */
  install: string | null
  /** Whether Harbor can start the daemon itself, or the user must. */
  startable: boolean
  /** The one Harbor will use. */
  selected: boolean
}

/**
 * `auto` picks whatever is installed and running, so a machine with exactly one
 * runtime never has to be told which. Anything else is a deliberate choice and
 * is respected even when it is not currently running — silently falling back
 * would run a user's containers somewhere they did not ask for.
 */
export const AUTO_RUNTIME = 'auto'
