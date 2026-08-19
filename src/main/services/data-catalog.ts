import type { JSONSchema } from '../../shared/json-schema.js'
import type { DockerServiceSpec } from './docker-service.js'
import { consoleAt, portField } from './docker-service.js'

/**
 * Databases, caches and mail catching — the services most projects actually
 * need, expressed as data like the rest of the Docker catalogue.
 *
 * Local defaults favour "starts and works": trivial credentials, no TLS, no
 * auth where the service allows it. These are throwaway instances bound to
 * 127.0.0.1, and a developer who has to look up a generated password before
 * they can connect will just replace the tool. Every value is overridable.
 *
 * No spec sets `container_name`. An explicit container name is Docker-global,
 * so it collides at the daemon level the moment a second project wants the same
 * service — it was the single thing preventing per-project stacks. Compose
 * derives `harbor-<project>-mysql-1` on its own, and namespaces named volumes
 * by project the same way, which is what keeps two projects' data apart.
 */

/**
 * Credentials shared by the SQL databases; identical shape, identical intent.
 *
 * `${project}` is resolved to the owning project's slug when the instance is
 * created. Naming the database after the project is what makes two stacks
 * legible side by side — `shop` and `blog` rather than two things both called
 * `harbor` — and it means a dump, a shell prompt or a stray connection string
 * says which project it belongs to without anyone having to check.
 */
const sqlAuth = {
  database: {
    type: 'string' as const,
    title: 'Database',
    section: 'Access',
    default: '${project}'
  },
  username: {
    type: 'string' as const,
    title: 'Username',
    section: 'Access',
    default: '${project}'
  },
  password: {
    type: 'string' as const,
    title: 'Password',
    format: 'password' as const,
    section: 'Access',
    default: 'harbor',
    description: 'Local only — this instance is bound to 127.0.0.1'
  }
}

/**
 * Replication settings, as real form fields rather than raw flags.
 *
 * These are the reason per-project stacks exist: a project testing CDC needs
 * the binary log on, and a project beside it does not want to pay for it. They
 * could be typed into "extra arguments", but a setting with a checkbox is one
 * a user can find — and `server-id` being mandatory alongside `log-bin` is
 * exactly the kind of detail a form should carry rather than a person.
 */
const binlogFields: Record<string, JSONSchema> = {
  binlog: {
    type: 'boolean',
    title: 'Binary log',
    section: 'Replication',
    description: 'Required for replication and change-data-capture',
    default: false
  },
  binlogFormat: {
    type: 'string',
    title: 'Binary log format',
    section: 'Replication',
    enum: ['ROW', 'MIXED', 'STATEMENT'],
    default: 'ROW'
  },
  serverId: {
    type: 'integer',
    title: 'Server ID',
    section: 'Replication',
    description: 'Must be unique across every server in a replication topology',
    default: 1,
    minimum: 1
  }
}

/** The binlog fields as server flags, or nothing when it is switched off. */
function binlogArgs(values: Record<string, unknown>): string[] {
  if (!values.binlog) return []
  return [
    '--log-bin=harbor-bin',
    `--binlog-format=${String(values.binlogFormat ?? 'ROW')}`,
    `--server-id=${Number(values.serverId ?? 1)}`
  ]
}


/**
 * SQL that makes the configured database and user real, whatever state the
 * volume is in.
 *
 * `MYSQL_DATABASE` and friends are honoured only when the entrypoint
 * initialises an empty data directory. On a volume that already exists they are
 * inert — so changing the database name in Harbor's form did nothing, and the
 * only symptom was the application failing to connect with "access denied",
 * pointing at a database that had never been created.
 *
 * The grant is deliberately global. A local database is bound to 127.0.0.1 and
 * exists to be worked against: a developer runs migrations, drops and recreates
 * schemas, and Laravel's test runner wants a second database of its own. A user
 * scoped to exactly one database turns each of those into an access error, so
 * the restriction buys nothing and costs constantly.
 */
function sqlBootstrap(values: Record<string, unknown>): string {
  const database = String(values.database ?? 'harbor')
  const user = String(values.username ?? 'harbor')
  const password = String(values.password ?? 'harbor')
  return [
    `CREATE DATABASE IF NOT EXISTS ${quoteIdent(database)};`,
    `CREATE USER IF NOT EXISTS ${quoteString(user)}@'%' IDENTIFIED BY ${quoteString(password)};`,
    // Re-stated so changing the password in the form takes effect on a user
    // that already exists, rather than silently applying only to a new one.
    `ALTER USER ${quoteString(user)}@'%' IDENTIFIED BY ${quoteString(password)};`,
    `GRANT ALL PRIVILEGES ON *.* TO ${quoteString(user)}@'%' WITH GRANT OPTION;`,
    'FLUSH PRIVILEGES;'
  ].join('\n')
}

/** Backtick-quoted identifier; an embedded backtick is doubled. */
function quoteIdent(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``
}

/** Single-quoted literal; embedded quotes and backslashes are escaped. */
function quoteString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
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
  commandBase: ['mysqld'],
  configMount: '/etc/mysql/conf.d/harbor.cnf',
  bootstrap: (instance) => ({
    label: 'create database and grant user',
    command: ['mysql', '-uroot', '--protocol=socket'],
    stdin: sqlBootstrap(instance.values)
  }),
  configSchema: {
    type: 'object',
    properties: { port: portField('Port', 3306), ...sqlAuth, ...binlogFields },
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
  fragment: (instance, version) => ({
    services: {
      mysql: {
        image: `mysql:${version}`,
        ports: [`${instance.values.port ?? 3306}:3306`],
        command: ['mysqld', ...binlogArgs(instance.values)],
        environment: {
          MYSQL_DATABASE: String(instance.values.database ?? 'harbor'),
          MYSQL_USER: String(instance.values.username ?? 'harbor'),
          MYSQL_PASSWORD: String(instance.values.password ?? 'harbor'),
          // Passwordless root is deliberate: local tooling expects to connect
          // as root without ceremony, and the port never leaves the machine.
          MYSQL_ALLOW_EMPTY_PASSWORD: 'yes'
        },
        volumes: ['mysql-data:/var/lib/mysql'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'mysql-data': {} }
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
  commandBase: ['mariadbd'],
  configMount: '/etc/mysql/conf.d/harbor.cnf',
  bootstrap: (instance) => ({
    label: 'create database and grant user',
    command: ['mariadb', '-uroot', '--protocol=socket'],
    stdin: sqlBootstrap(instance.values)
  }),
  configSchema: {
    // Defaults to 3307 so it can run beside MySQL.
    type: 'object',
    properties: { port: portField('Port', 3307), ...sqlAuth, ...binlogFields },
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
  fragment: (instance, version) => ({
    services: {
      mariadb: {
        image: `mariadb:${version}`,
        ports: [`${instance.values.port ?? 3307}:3306`],
        command: ['mariadbd', ...binlogArgs(instance.values)],
        environment: {
          MARIADB_DATABASE: String(instance.values.database ?? 'harbor'),
          MARIADB_USER: String(instance.values.username ?? 'harbor'),
          MARIADB_PASSWORD: String(instance.values.password ?? 'harbor'),
          MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: 'yes'
        },
        volumes: ['mariadb-data:/var/lib/mysql'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'mariadb-data': {} }
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
  // Postgres takes settings as `-c key=value`, which is exactly what the extra
  // arguments field is for; it has no drop-in conf.d in the official image.
  commandBase: ['postgres'],
  // `POSTGRES_DB` has the same first-init-only behaviour as MySQL's. The role
  // is already a superuser, so only the database itself needs reconciling.
  bootstrap: (instance) => {
    const database = String(instance.values.database ?? 'harbor')
    const user = String(instance.values.username ?? 'harbor')
    return {
      label: 'create database',
      command: [
        'sh',
        '-c',
        `psql -U "$0" -tAc "SELECT 1 FROM pg_database WHERE datname='$1'" | grep -q 1 || ` +
          `psql -U "$0" -c "CREATE DATABASE \\"$1\\""`,
        user,
        database
      ]
    }
  },
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
  fragment: (instance, version) => ({
    services: {
      postgres: {
        image: `postgres:${version}-alpine`,
        ports: [`${instance.values.port ?? 5432}:5432`],
        environment: {
          POSTGRES_DB: String(instance.values.database ?? 'harbor'),
          POSTGRES_USER: String(instance.values.username ?? 'harbor'),
          POSTGRES_PASSWORD: String(instance.values.password ?? 'harbor')
        },
        volumes: ['postgres-data:/var/lib/postgresql/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'postgres-data': {} }
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
  commandBase: ['mongod'],
  configSchema: {
    type: 'object',
    properties: {
      port: portField('Port', 27017),
      database: { type: 'string', title: 'Database', section: 'Access', default: '${project}' },
      username: {
        type: 'string',
        title: 'Root username',
        section: 'Access',
        default: '${project}'
      },
      password: {
        type: 'string',
        title: 'Root password',
        format: 'password',
        section: 'Access',
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
  fragment: (instance, version) => ({
    services: {
      mongodb: {
        image: `mongo:${version}`,
        ports: [`${instance.values.port ?? 27017}:27017`],
        environment: {
          MONGO_INITDB_ROOT_USERNAME: String(instance.values.username ?? 'harbor'),
          MONGO_INITDB_ROOT_PASSWORD: String(instance.values.password ?? 'harbor'),
          MONGO_INITDB_DATABASE: String(instance.values.database ?? 'harbor')
        },
        volumes: ['mongodb-data:/data/db'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'mongodb-data': {} }
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
  commandBase: ['redis-server'],
  configSchema: {
    type: 'object',
    properties: {
      port: portField('Port', 6379),
      password: {
        type: 'string',
        title: 'Password',
        format: 'password',
        section: 'Access',
        description: 'Leave blank for no authentication, as most local setups expect',
        default: ''
      },
      maxMemory: {
        type: 'string',
        title: 'Max memory',
        section: 'Settings',
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
  fragment: (instance, version) => {
    const password = String(instance.values.password ?? '')
    const memory = String(instance.values.maxMemory ?? '256mb')
    return {
      services: {
        redis: {
          image: `redis:${version}-alpine`,
          ports: [`${instance.values.port ?? 6379}:6379`],
          command: [
            'redis-server',
            '--maxmemory',
            memory,
            '--maxmemory-policy',
            'allkeys-lru',
            ...(password ? ['--requirepass', password] : [])
          ],
          volumes: ['redis-data:/data'],
          restart: 'unless-stopped'
        }
      },
      volumes: { 'redis-data': {} }
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
  console: consoleAt('Open inbox', 'secondaryPort'),
  configSchema: {
    type: 'object',
    properties: {
      port: portField('SMTP port', 1025),
      secondaryPort: portField('Web inbox port', 8025),
      maxMessages: {
        type: 'integer',
        title: 'Messages kept',
        section: 'Settings',
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
  fragment: (instance, version) => ({
    services: {
      mailpit: {
        image: `axllent/mailpit:${version}`,
        ports: [
          `${instance.values.port ?? 1025}:1025`,
          `${instance.values.secondaryPort ?? 8025}:8025`
        ],
        environment: {
          MP_MAX_MESSAGES: String(instance.values.maxMessages ?? 500),
          MP_SMTP_AUTH_ACCEPT_ANY: '1',
          MP_SMTP_AUTH_ALLOW_INSECURE: '1'
        },
        volumes: ['mailpit-data:/data'],
        restart: 'unless-stopped'
      }
    },
    volumes: { 'mailpit-data': {} }
  })
}
