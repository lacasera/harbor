import type { DockerServiceSpec } from './docker-service.js'
import { portField } from './docker-service.js'

/**
 * Databases, caches and mail catching — the services most projects actually
 * need, expressed as data like the rest of the Docker catalogue.
 *
 * Local defaults favour "starts and works": trivial credentials, no TLS, no
 * auth where the service allows it. These are throwaway instances bound to
 * 127.0.0.1, and a developer who has to look up a generated password before
 * they can connect will just replace the tool. Every value is overridable.
 */

/** Credentials shared by the SQL databases; identical shape, identical intent. */
const sqlAuth = {
  database: { type: 'string' as const, title: 'Database', default: 'harbor' },
  username: { type: 'string' as const, title: 'Username', default: 'harbor' },
  password: {
    type: 'string' as const,
    title: 'Password',
    format: 'password' as const,
    default: 'harbor',
    description: 'Local only — this instance is bound to 127.0.0.1'
  }
}

export const MYSQL: DockerServiceSpec = {
  id: 'mysql',
  icon: 'database',
  tint: '#4479A1',
  displayName: 'MySQL',
  description: 'Relational database',
  defaultPorts: [3306],
  versions: ['8.4', '8.0', '5.7'],
  healthTcp: true,
  configSchema: {
    type: 'object',
    properties: { port: portField('Port', 3306), ...sqlAuth },
    required: ['port', 'database', 'username']
  },
  envHints: {
    DB_CONNECTION: 'mysql',
    DB_HOST: '${host}',
    DB_PORT: '${port}',
    DB_DATABASE: '${database}',
    DB_USERNAME: '${username}',
    DB_PASSWORD: '${password}'
  },
  fragment: (config, version) => ({
    services: {
      mysql: {
        image: `mysql:${version}`,
        container_name: 'harbor-mysql',
        ports: [`${config.values.port ?? 3306}:3306`],
        environment: {
          MYSQL_DATABASE: String(config.values.database ?? 'harbor'),
          MYSQL_USER: String(config.values.username ?? 'harbor'),
          MYSQL_PASSWORD: String(config.values.password ?? 'harbor'),
          // Passwordless root is deliberate: local tooling expects to connect
          // as root without ceremony, and the port never leaves the machine.
          MYSQL_ALLOW_EMPTY_PASSWORD: 'yes'
        },
        volumes: ['harbor-mysql:/var/lib/mysql'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-mysql': {} }
  })
}

export const MARIADB: DockerServiceSpec = {
  id: 'mariadb',
  icon: 'database',
  tint: '#003545',
  displayName: 'MariaDB',
  description: 'MySQL-compatible relational database',
  defaultPorts: [3307],
  versions: ['11.4', '10.11'],
  healthTcp: true,
  configSchema: {
    // Defaults to 3307 so it can run beside MySQL.
    type: 'object',
    properties: { port: portField('Port', 3307), ...sqlAuth },
    required: ['port', 'database', 'username']
  },
  envHints: {
    DB_CONNECTION: 'mysql',
    DB_HOST: '${host}',
    DB_PORT: '${port}',
    DB_DATABASE: '${database}',
    DB_USERNAME: '${username}',
    DB_PASSWORD: '${password}'
  },
  fragment: (config, version) => ({
    services: {
      mariadb: {
        image: `mariadb:${version}`,
        container_name: 'harbor-mariadb',
        ports: [`${config.values.port ?? 3307}:3306`],
        environment: {
          MARIADB_DATABASE: String(config.values.database ?? 'harbor'),
          MARIADB_USER: String(config.values.username ?? 'harbor'),
          MARIADB_PASSWORD: String(config.values.password ?? 'harbor'),
          MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: 'yes'
        },
        volumes: ['harbor-mariadb:/var/lib/mysql'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-mariadb': {} }
  })
}

export const POSTGRES: DockerServiceSpec = {
  id: 'postgres',
  icon: 'database',
  tint: '#4169E1',
  displayName: 'PostgreSQL',
  description: 'Relational database',
  defaultPorts: [5432],
  versions: ['17', '16', '15'],
  healthTcp: true,
  configSchema: {
    type: 'object',
    properties: { port: portField('Port', 5432), ...sqlAuth },
    required: ['port', 'database', 'username']
  },
  envHints: {
    DB_CONNECTION: 'pgsql',
    DB_HOST: '${host}',
    DB_PORT: '${port}',
    DB_DATABASE: '${database}',
    DB_USERNAME: '${username}',
    DB_PASSWORD: '${password}',
    DATABASE_URL: 'postgresql://${username}:${password}@${host}:${port}/${database}'
  },
  fragment: (config, version) => ({
    services: {
      postgres: {
        image: `postgres:${version}-alpine`,
        container_name: 'harbor-postgres',
        ports: [`${config.values.port ?? 5432}:5432`],
        environment: {
          POSTGRES_DB: String(config.values.database ?? 'harbor'),
          POSTGRES_USER: String(config.values.username ?? 'harbor'),
          POSTGRES_PASSWORD: String(config.values.password ?? 'harbor')
        },
        volumes: ['harbor-postgres:/var/lib/postgresql/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-postgres': {} }
  })
}

export const MONGODB: DockerServiceSpec = {
  id: 'mongodb',
  icon: 'database',
  tint: '#47A248',
  displayName: 'MongoDB',
  description: 'Document database',
  defaultPorts: [27017],
  versions: ['8.0', '7.0'],
  healthTcp: true,
  configSchema: {
    type: 'object',
    properties: {
      port: portField('Port', 27017),
      database: { type: 'string', title: 'Database', default: 'harbor' },
      username: { type: 'string', title: 'Root username', default: 'harbor' },
      password: {
        type: 'string',
        title: 'Root password',
        format: 'password',
        default: 'harbor',
        description: 'Local only — this instance is bound to 127.0.0.1'
      }
    },
    required: ['port', 'database']
  },
  envHints: {
    MONGODB_URI: 'mongodb://${username}:${password}@${host}:${port}/${database}?authSource=admin',
    MONGO_HOST: '${host}',
    MONGO_PORT: '${port}',
    MONGO_DATABASE: '${database}'
  },
  fragment: (config, version) => ({
    services: {
      mongodb: {
        image: `mongo:${version}`,
        container_name: 'harbor-mongodb',
        ports: [`${config.values.port ?? 27017}:27017`],
        environment: {
          MONGO_INITDB_ROOT_USERNAME: String(config.values.username ?? 'harbor'),
          MONGO_INITDB_ROOT_PASSWORD: String(config.values.password ?? 'harbor'),
          MONGO_INITDB_DATABASE: String(config.values.database ?? 'harbor')
        },
        volumes: ['harbor-mongodb:/data/db'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-mongodb': {} }
  })
}

export const REDIS: DockerServiceSpec = {
  id: 'redis',
  icon: 'cache',
  tint: '#FF4438',
  displayName: 'Redis',
  description: 'In-memory cache, queue and session store',
  defaultPorts: [6379],
  versions: ['7.4', '7.2'],
  healthTcp: true,
  configSchema: {
    type: 'object',
    properties: {
      port: portField('Port', 6379),
      password: {
        type: 'string',
        title: 'Password',
        format: 'password',
        description: 'Leave blank for no authentication, as most local setups expect',
        default: ''
      },
      maxMemory: {
        type: 'string',
        title: 'Max memory',
        description: 'Evicts least-recently-used keys beyond this',
        default: '256mb'
      }
    },
    required: ['port']
  },
  envHints: {
    REDIS_HOST: '${host}',
    REDIS_PORT: '${port}',
    REDIS_PASSWORD: '${password}',
    REDIS_URL: 'redis://${host}:${port}'
  },
  fragment: (config, version) => {
    const password = String(config.values.password ?? '')
    const memory = String(config.values.maxMemory ?? '256mb')
    return {
      services: {
        redis: {
          image: `redis:${version}-alpine`,
          container_name: 'harbor-redis',
          ports: [`${config.values.port ?? 6379}:6379`],
          command: [
            'redis-server',
            '--maxmemory',
            memory,
            '--maxmemory-policy',
            'allkeys-lru',
            ...(password ? ['--requirepass', password] : [])
          ],
          volumes: ['harbor-redis:/data'],
          restart: 'unless-stopped'
        }
      },
      volumes: { 'harbor-redis': {} }
    }
  }
}

export const MAILPIT: DockerServiceSpec = {
  id: 'mailpit',
  icon: 'mail',
  tint: '#5B7C99',
  displayName: 'Mailpit',
  description: 'Catches outgoing mail and shows it in a web inbox',
  // SMTP first: it is the port projects connect to, so it leads the env block.
  defaultPorts: [1025, 8025],
  versions: ['latest', 'v1.20'],
  // The web inbox answers HTTP; the SMTP port never will.
  healthPath: '/readyz',
  healthPortIndex: 1,
  configSchema: {
    type: 'object',
    properties: {
      port: portField('SMTP port', 1025),
      secondaryPort: portField('Web inbox port', 8025),
      maxMessages: {
        type: 'integer',
        title: 'Messages kept',
        description: 'Oldest are discarded beyond this',
        default: 500,
        minimum: 0
      }
    },
    required: ['port', 'secondaryPort']
  },
  envHints: {
    MAIL_MAILER: 'smtp',
    MAIL_HOST: '${host}',
    MAIL_PORT: '${port}',
    MAIL_USERNAME: '',
    MAIL_PASSWORD: '',
    MAIL_ENCRYPTION: 'null',
    MAIL_FROM_ADDRESS: 'hello@example.test'
  },
  fragment: (config, version) => ({
    services: {
      mailpit: {
        image: `axllent/mailpit:${version}`,
        container_name: 'harbor-mailpit',
        ports: [
          `${config.values.port ?? 1025}:1025`,
          `${config.values.secondaryPort ?? 8025}:8025`
        ],
        environment: {
          MP_MAX_MESSAGES: String(config.values.maxMessages ?? 500),
          MP_SMTP_AUTH_ACCEPT_ANY: '1',
          MP_SMTP_AUTH_ALLOW_INSECURE: '1'
        },
        volumes: ['harbor-mailpit:/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'harbor-mailpit': {} }
  })
}
