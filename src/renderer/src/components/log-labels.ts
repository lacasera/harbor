import type { ProjectDescriptor } from '../../../shared/project.js'
import type { ServiceDescriptor } from '../../../shared/service.js'
import { MACHINE_OWNER, parseInstanceKey } from '../../../shared/service.js'

/**
 * Readable names for log sources.
 *
 * A source id is an identity — a project's uuid, or `<owner>:<serviceId>` for a
 * service instance — and it stays that way: it keys the aggregator, the process
 * manager and the usage sampler, and a name that changes when the user renames
 * a project would break all three. So the id is kept and the label is derived
 * here, where the projects and the catalogue are already to hand.
 */
export function sourceLabels(
  projects: ProjectDescriptor[],
  services: ServiceDescriptor[]
): Map<string, string> {
  const labels = new Map<string, string>()
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))

  for (const [id, name] of projectNames) labels.set(id, name)

  for (const service of services) {
    for (const instance of service.instances) {
      const owner =
        instance.owner === MACHINE_OWNER
          ? 'Machine'
          : (projectNames.get(instance.owner) ?? shortOwner(instance.owner))
      labels.set(instance.key, `${owner} · ${instance.displayName}`)
    }
  }
  return labels
}

/**
 * The label for one source, falling back to something readable.
 *
 * An instance can outlive the project record the renderer has — a log line
 * buffered before a reload, a service detached moments ago — so an unmatched
 * `owner:service` is still worth splitting rather than printing whole.
 */
export function labelForSource(source: string, labels: Map<string, string>): string {
  const known = labels.get(source)
  if (known) return known
  if (!source.includes(':')) return source
  const { owner, serviceId } = parseInstanceKey(source)
  return `${owner === MACHINE_OWNER ? 'Machine' : shortOwner(owner)} · ${serviceId}`
}

/** A uuid is not a name; showing all 36 characters of one helps nobody. */
function shortOwner(owner: string): string {
  return /^[0-9a-f-]{36}$/i.test(owner) ? owner.slice(0, 8) : owner
}
