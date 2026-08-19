import type { DockerServiceSpec } from './docker-service.js'
import { portField } from './docker-service.js'

/**
 * Docker-backed services, each expressed as data. Adding one means adding a
 * spec here and a line in services/index.ts — no lifecycle code, no UI.
 *
 * Local development defaults deliberately favour "starts and works": security
 * plugins off, single node, modest heaps. These are throwaway local instances,
 * not production clusters, and every value is overridable in the form.
 */

export const ELASTICSEARCH: DockerServiceSpec = {
  id: 'elasticsearch',
  displayName: 'Elasticsearch',
  description: 'Distributed search & analytics',
  defaultPorts: [9200, 9300],
  versions: ['8.15.0', '8.14.3', '7.17.23'],
  healthPath: '/_cluster/health',
  configSchema: {
    type: 'object',
    properties: {
      port: portField('HTTP port', 9200),
      secondaryPort: portField('Transport port', 9300),
      heapSize: {
        type: 'string',
        title: 'JVM heap',
        description: 'Elasticsearch is memory-hungry; 512m is enough for local work',
        default: '512m'
      },
      security: {
        type: 'boolean',
        title: 'Enable security',
        description: 'Off locally so clients connect without certificates',
        default: false
      }
    },
    required: ['port']
  },
  envHints: {
    ELASTIC_HOST: 'http://${host}:${port}',
    ELASTIC_PORT: '${port}',
    ELASTICSEARCH_HOST: 'http://${host}:${port}'
  },
  fragment: (config, version) => ({
    services: {
      elasticsearch: {
        image: `docker.elastic.co/elasticsearch/elasticsearch:${version}`,
        container_name: 'harbor-elasticsearch',
        ports: [
          `${config.values.port ?? 9200}:9200`,
          `${config.values.secondaryPort ?? 9300}:9300`
        ],
        environment: {
          'discovery.type': 'single-node',
          'xpack.security.enabled': String(Boolean(config.values.security)),
          ES_JAVA_OPTS: `-Xms${config.values.heapSize ?? '512m'} -Xmx${config.values.heapSize ?? '512m'}`
        },
        ulimits: { memlock: { soft: -1, hard: -1 } },
        volumes: ['harbor-elasticsearch:/usr/share/elasticsearch/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-elasticsearch': {} }
  })
}

export const OPENSEARCH: DockerServiceSpec = {
  id: 'opensearch',
  displayName: 'OpenSearch',
  description: 'Search & analytics suite',
  // Defaults to 9250 rather than 9200 so it can run beside Elasticsearch.
  defaultPorts: [9250, 9600],
  versions: ['2.15.0', '2.14.0'],
  healthPath: '/_cluster/health',
  configSchema: {
    type: 'object',
    properties: {
      port: portField('HTTP port', 9250),
      secondaryPort: portField('Performance analyzer port', 9600),
      heapSize: { type: 'string', title: 'JVM heap', default: '512m' }
    },
    required: ['port']
  },
  envHints: {
    OPENSEARCH_HOST: 'http://${host}:${port}',
    OPENSEARCH_PORT: '${port}'
  },
  fragment: (config, version) => ({
    services: {
      opensearch: {
        image: `opensearchproject/opensearch:${version}`,
        container_name: 'harbor-opensearch',
        ports: [
          `${config.values.port ?? 9250}:9200`,
          `${config.values.secondaryPort ?? 9600}:9600`
        ],
        environment: {
          'discovery.type': 'single-node',
          DISABLE_SECURITY_PLUGIN: 'true',
          DISABLE_INSTALL_DEMO_CONFIG: 'true',
          OPENSEARCH_JAVA_OPTS: `-Xms${config.values.heapSize ?? '512m'} -Xmx${config.values.heapSize ?? '512m'}`
        },
        ulimits: { memlock: { soft: -1, hard: -1 } },
        volumes: ['harbor-opensearch:/usr/share/opensearch/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-opensearch': {} }
  })
}

export const LOCALSTACK: DockerServiceSpec = {
  id: 'localstack',
  displayName: 'LocalStack',
  description: 'Local AWS cloud emulator',
  defaultPorts: [4566],
  versions: ['3.7', '3.5'],
  healthPath: '/_localstack/health',
  configSchema: {
    type: 'object',
    properties: {
      port: portField('Edge port', 4566),
      services: {
        type: 'string',
        title: 'Services',
        description: 'Comma separated — fewer services start faster',
        default: 's3,sqs,sns,lambda'
      },
      region: { type: 'string', title: 'Default region', default: 'us-east-1' }
    },
    required: ['port']
  },
  envHints: {
    AWS_ENDPOINT: 'http://${host}:${port}',
    AWS_ENDPOINT_URL: 'http://${host}:${port}',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_DEFAULT_REGION: '${region}',
    AWS_USE_PATH_STYLE_ENDPOINT: 'true'
  },
  fragment: (config, version) => ({
    services: {
      localstack: {
        image: `localstack/localstack:${version}`,
        container_name: 'harbor-localstack',
        ports: [`${config.values.port ?? 4566}:4566`],
        environment: {
          SERVICES: String(config.values.services ?? 's3,sqs,sns,lambda'),
          DEFAULT_REGION: String(config.values.region ?? 'us-east-1'),
          DEBUG: '0'
        },
        volumes: ['harbor-localstack:/var/lib/localstack'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-localstack': {} }
  })
}

export const KAFKA: DockerServiceSpec = {
  id: 'kafka',
  displayName: 'Kafka',
  description: 'Distributed event streaming',
  defaultPorts: [9092],
  versions: ['3.8.0', '3.7.1'],
  configSchema: {
    type: 'object',
    properties: {
      port: portField('Broker port', 9092),
      heapSize: { type: 'string', title: 'JVM heap', default: '512m' },
      autoCreateTopics: {
        type: 'boolean',
        title: 'Auto-create topics',
        description: 'Convenient locally; produces typos as topics',
        default: true
      }
    },
    required: ['port']
  },
  envHints: {
    KAFKA_BROKERS: '${host}:${port}',
    KAFKA_BOOTSTRAP_SERVERS: '${host}:${port}'
  },
  // KRaft mode: no ZooKeeper, which halves what has to run locally.
  fragment: (config, version) => {
    const port = Number(config.values.port ?? 9092)
    return {
      services: {
        kafka: {
          image: `apache/kafka:${version}`,
          container_name: 'harbor-kafka',
          ports: [`${port}:9092`],
          environment: {
            KAFKA_NODE_ID: '1',
            KAFKA_PROCESS_ROLES: 'broker,controller',
            KAFKA_LISTENERS: 'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
            KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
            KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
            KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
            KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
              'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
            KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
            KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
            KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
            KAFKA_AUTO_CREATE_TOPICS_ENABLE: String(config.values.autoCreateTopics ?? true),
            KAFKA_HEAP_OPTS: `-Xms${config.values.heapSize ?? '512m'} -Xmx${config.values.heapSize ?? '512m'}`
          },
          volumes: ['harbor-kafka:/var/lib/kafka/data'],
          restart: 'unless-stopped'
        }
      },
      volumes: { 'harbor-kafka': {} }
    }
  }
}
