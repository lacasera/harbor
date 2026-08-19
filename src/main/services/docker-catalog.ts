import type { DockerServiceSpec } from './docker-service.js'
import { consoleAt, portField } from './docker-service.js'

/**
 * Docker-backed services, each expressed as data. Adding one means adding a
 * spec here and a line in services/index.ts — no lifecycle code, no UI.
 *
 * Local development defaults deliberately favour "starts and works": security
 * plugins off, single node, modest heaps. These are throwaway local instances,
 * not production clusters, and every value is overridable in the form.
 *
 * No spec sets `container_name` — see the note in data-catalog.ts. It is
 * Docker-global, so it is what stops two projects running the same service.
 */

export const RABBITMQ: DockerServiceSpec = {
  id: 'rabbitmq',
  icon: 'queue',
  tint: '#FF6600',
  displayName: 'RabbitMQ',
  description: 'AMQP message broker',
  defaultPorts: [5672, 15672],
  versions: ['4-management', '3.13-management'],
  // The management UI answers HTTP; the AMQP port never will.
  healthPath: '/',
  healthPortIndex: 1,
  console: consoleAt('Open management UI', 'secondaryPort'),
  configSchema: {
    type: 'object',
    properties: {
      port: portField('AMQP port', 5672),
      secondaryPort: portField('Management UI port', 15672),
      user: { type: 'string', title: 'Username', default: 'guest' },
      password: { type: 'string', title: 'Password', format: 'password', default: 'guest' },
      vhost: { type: 'string', title: 'Virtual host', default: '/' }
    },
    required: ['port', 'user', 'password']
  },
  envHints: {
    RABBITMQ_HOST: '${host}',
    RABBITMQ_PORT: '${port}',
    RABBITMQ_USER: '${user}',
    RABBITMQ_PASSWORD: '${password}',
    RABBITMQ_VHOST: '${vhost}'
  },
  fragment: (instance, version) => ({
    services: {
      rabbitmq: {
        image: `rabbitmq:${version}`,
        ports: [
          `${instance.values.port ?? 5672}:5672`,
          `${instance.values.secondaryPort ?? 15672}:15672`
        ],
        environment: {
          RABBITMQ_DEFAULT_USER: String(instance.values.user ?? 'guest'),
          RABBITMQ_DEFAULT_PASS: String(instance.values.password ?? 'guest'),
          RABBITMQ_DEFAULT_VHOST: String(instance.values.vhost ?? '/')
        },
        volumes: ['rabbitmq-data:/var/lib/rabbitmq'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'rabbitmq-data': {} }
  })
}

export const ELASTICSEARCH: DockerServiceSpec = {
  id: 'elasticsearch',
  icon: 'search',
  tint: '#00BFB3',
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
  fragment: (instance, version) => ({
    services: {
      elasticsearch: {
        image: `docker.elastic.co/elasticsearch/elasticsearch:${version}`,
        ports: [
          `${instance.values.port ?? 9200}:9200`,
          `${instance.values.secondaryPort ?? 9300}:9300`
        ],
        environment: {
          'discovery.type': 'single-node',
          'xpack.security.enabled': String(Boolean(instance.values.security)),
          ES_JAVA_OPTS: `-Xms${instance.values.heapSize ?? '512m'} -Xmx${instance.values.heapSize ?? '512m'}`
        },
        ulimits: { memlock: { soft: -1, hard: -1 } },
        volumes: ['elasticsearch-data:/usr/share/elasticsearch/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'elasticsearch-data': {} }
  })
}

export const OPENSEARCH: DockerServiceSpec = {
  id: 'opensearch',
  icon: 'search',
  tint: '#4A78C4',
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
  fragment: (instance, version) => ({
    services: {
      opensearch: {
        image: `opensearchproject/opensearch:${version}`,
        ports: [
          `${instance.values.port ?? 9250}:9200`,
          `${instance.values.secondaryPort ?? 9600}:9600`
        ],
        environment: {
          'discovery.type': 'single-node',
          DISABLE_SECURITY_PLUGIN: 'true',
          DISABLE_INSTALL_DEMO_CONFIG: 'true',
          OPENSEARCH_JAVA_OPTS: `-Xms${instance.values.heapSize ?? '512m'} -Xmx${instance.values.heapSize ?? '512m'}`
        },
        ulimits: { memlock: { soft: -1, hard: -1 } },
        volumes: ['opensearch-data:/usr/share/opensearch/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'opensearch-data': {} }
  })
}

export const LOCALSTACK: DockerServiceSpec = {
  id: 'localstack',
  icon: 'cloud',
  tint: '#7B61FF',
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
  fragment: (instance, version) => ({
    services: {
      localstack: {
        image: `localstack/localstack:${version}`,
        ports: [`${instance.values.port ?? 4566}:4566`],
        environment: {
          SERVICES: String(instance.values.services ?? 's3,sqs,sns,lambda'),
          DEFAULT_REGION: String(instance.values.region ?? 'us-east-1'),
          DEBUG: '0'
        },
        volumes: ['localstack-data:/var/lib/localstack'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'localstack-data': {} }
  })
}

export const KAFKA: DockerServiceSpec = {
  id: 'kafka',
  icon: 'stream',
  tint: '#231F20',
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
  fragment: (instance, version) => {
    const port = Number(instance.values.port ?? 9092)
    return {
      services: {
        kafka: {
          image: `apache/kafka:${version}`,
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
            KAFKA_AUTO_CREATE_TOPICS_ENABLE: String(instance.values.autoCreateTopics ?? true),
            KAFKA_HEAP_OPTS: `-Xms${instance.values.heapSize ?? '512m'} -Xmx${instance.values.heapSize ?? '512m'}`
          },
          volumes: ['kafka-data:/var/lib/kafka/data'],
          restart: 'unless-stopped'
        }
      },
      volumes: { 'kafka-data': {} }
    }
  }
}
