import type { ServiceRegistry } from './registry.js'
import type { NativeBackend } from '../backends/native-backend.js'
import type { DockerBackend } from '../backends/docker-backend.js'
import type { ProcessManager } from '../core/process-manager.js'
import { MinioDriver } from './minio.js'
import { MeilisearchDriver } from './meilisearch.js'
import { RabbitMqDriver } from './rabbitmq.js'
import { DockerServiceDriver } from './docker-service.js'
import { ELASTICSEARCH, KAFKA, LOCALSTACK, OPENSEARCH } from './docker-catalog.js'

/**
 * The service catalogue. Adding one is a driver (or, for Docker services, a
 * spec) plus a line here — no UI, IPC, config-form or log wiring changes.
 */
export function registerServices(
  registry: ServiceRegistry,
  deps: { native: NativeBackend; docker: DockerBackend; processes: ProcessManager }
): void {
  // Native: single binaries developers leave running all day.
  registry.register(new MinioDriver(deps.native, deps.processes))
  registry.register(new MeilisearchDriver(deps.native, deps.processes))

  // Docker: heavier, JVM-shaped, or awkward to install natively.
  registry.register(new RabbitMqDriver(deps.docker))
  for (const spec of [ELASTICSEARCH, OPENSEARCH, LOCALSTACK, KAFKA]) {
    registry.register(new DockerServiceDriver(deps.docker, spec))
  }
}
