import type { ServiceRegistry } from './registry.js'
import type { NativeBackend } from '../backends/native-backend.js'
import type { DockerBackend } from '../backends/docker-backend.js'
import type { ProcessManager } from '../core/process-manager.js'
import { MinioDriver } from './minio.js'
import { RabbitMqDriver } from './rabbitmq.js'

/**
 * The full list of services. Adding one is a single line here plus a driver
 * file — no UI, IPC or log wiring changes.
 *
 * Still to implement as drivers: Elasticsearch, OpenSearch, Meilisearch, Kafka,
 * LocalStack.
 */
export function registerServices(
  registry: ServiceRegistry,
  deps: { native: NativeBackend; docker: DockerBackend; processes: ProcessManager }
): void {
  registry.register(new MinioDriver(deps.native, deps.processes))
  registry.register(new RabbitMqDriver(deps.docker))
}
