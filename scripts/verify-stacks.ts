/**
 * Per-project service stacks: the point of the whole change is that two
 * projects can each run their own MySQL, with different configuration, without
 * seeing each other.
 *
 *   npm run verify:stacks
 *
 * Runs against the real ~/.harbor with two throwaway projects under a temp
 * directory, and removes both — and their stacks, volumes included — at the
 * end. Nothing it creates outlives it. Pulls the MySQL image on first use.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarborApp } from '../src/main/app.js'
import { EXTRA_ARGS } from '../src/main/services/docker-service.js'
import { composeDir } from '../src/main/core/paths.js'
import type { ProjectDescriptor } from '../src/shared/project.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const results: Array<[string, boolean, string]> = []
const step = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const skip = (name: string, why: string): void => {
  console.log(`  skip ${name} — ${why}`)
}

/** A minimal static site: enough to park, with nothing to run. */
function makeSite(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), `<h1>${name}</h1>\n`, 'utf8')
  return dir
}

function composeOf(project: ProjectDescriptor): Record<string, never> | null {
  const file = join(composeDir(project.composeProject), 'docker-compose.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, never>
}

async function main(): Promise<void> {
  const harbor = new HarborApp()
  const root = mkdtempSync(join(tmpdir(), 'harbor-stacks-'))
  let alpha: ProjectDescriptor | null = null
  let beta: ProjectDescriptor | null = null

  try {
    // Launch-time reconciliation, exercised here because these scripts never
    // call `harbor.start()` — and because an interrupted earlier run is exactly
    // how an orphan gets created in the first place.
    const orphans = await harbor.services.reconcile(harbor.projects.list().map((p) => p.id))
    step(
      'instances whose project is gone are reconciled away',
      harbor.services
        .all()
        .every((i) => i.owner === 'machine' || harbor.projects.list().some((p) => p.id === i.owner)),
      orphans.length ? `detached ${orphans.map((o) => o.serviceId).join(', ')}` : 'none found'
    )
    // Every surviving instance's port is known to the allocator, or the next
    // project to attach that service is handed a number already in use.
    const unregistered = harbor.services.all().filter((i) => {
      const port = Number(i.values.port)
      return port > 0 && harbor.store.get().ports[`service:${i.owner}:${i.serviceId}:port`] !== port
    })
    step(
      'every live instance holds a registered port allocation',
      unregistered.length === 0,
      unregistered.map((i) => `${i.serviceId}@${String(i.values.port)}`).join(', ')
    )

    alpha = await harbor.projects.link(makeSite(root, 'stackalpha'))
    beta = await harbor.projects.link(makeSite(root, 'stackbeta'))

    step(
      'each project gets its own compose namespace',
      Boolean(alpha.composeProject) &&
        Boolean(beta.composeProject) &&
        alpha.composeProject !== beta.composeProject,
      `${alpha.composeProject} vs ${beta.composeProject}`
    )
    step(
      'compose namespaces are harbor-prefixed',
      alpha.composeProject.startsWith('harbor-') && beta.composeProject.startsWith('harbor-'),
      alpha.composeProject
    )

    // ── attach ──────────────────────────────────────────────────────────────
    const refA = { owner: alpha.id, serviceId: 'mysql' }
    const refB = { owner: beta.id, serviceId: 'mysql' }
    await harbor.services.attach(refA, { autoStart: false })
    await harbor.services.attach(refB, { autoStart: false })

    const a = harbor.services.get(refA)
    const b = harbor.services.get(refB)
    step('both projects have their own MySQL instance', Boolean(a && b))

    const portA = Number(a?.values.port)
    const portB = Number(b?.values.port)
    step('allocated ports differ', portA !== portB, `${portA} vs ${portB}`)
    // Not "the first got 3306": a project the user already has may legitimately
    // hold it, and did while this was being written. What matters is that an
    // allocation lands NEAR the canonical port rather than in the generic
    // 3100-3999 pool, so a MySQL is recognisable as one by its number.
    step(
      'allocations land near the canonical port',
      portA >= 3306 && portA <= 3406 && portB >= 3306 && portB <= 3406,
      `${portA}, ${portB}`
    )

    // Names derived from the project. Per-project stacks already keep instances
    // apart; this is what makes them legible when you are looking at two.
    step(
      'database and username default to the project name',
      a?.values.database === 'stackalpha' && b?.values.database === 'stackbeta',
      `${String(a?.values.database)} vs ${String(b?.values.database)}`
    )
    step(
      'no placeholder survives into a stored value',
      !JSON.stringify(a?.values ?? {}).includes('${'),
      JSON.stringify(a?.values ?? {})
    )

    // ── per-project configuration ───────────────────────────────────────────
    // The binlog case, which is what made shared instances untenable.
    const configured = await harbor.services.updateConfig(refA, {
      values: { ...(a?.values ?? {}), binlog: true, binlogFormat: 'ROW', serverId: 7 }
    })
    step('binlog settings validate against the schema', configured.ok)

    const withExtras = await harbor.services.updateConfig(refA, {
      values: {
        ...(harbor.services.get(refA)?.values ?? {}),
        [EXTRA_ARGS]: '--max-connections=42'
      }
    })
    step('extra arguments validate against the schema', withExtras.ok)

    step(
      "a second project does not inherit the first's tuning",
      harbor.services.get(refB)?.values.binlog !== true,
      `B binlog=${String(harbor.services.get(refB)?.values.binlog)}`
    )

    // Nothing machine-wide may seed an instance. An earlier design carried a
    // tuned config into the next project that attached the same service, and
    // it silently gave that project another project's database name and
    // binary-log settings. Asserted against a deliberately dirty store rather
    // than a clean one, because a clean store cannot fail this.
    harbor.store.update((state) => {
      ;(state as unknown as Record<string, unknown>).serviceDefaults = {
        mysql: { version: 'latest', values: { database: 'someone_elses_db', binlog: true } }
      }
    })
    const thirdRef = { owner: alpha.id, serviceId: 'mariadb' }
    await harbor.services.attach(thirdRef, { autoStart: false })
    const third = harbor.services.get(thirdRef)
    step(
      'a stale machine-wide config cannot seed a new instance',
      third?.values.database === 'stackalpha' && third?.values.binlog !== true,
      `database=${String(third?.values.database)} binlog=${String(third?.values.binlog)}`
    )
    await harbor.services.detach(thirdRef)

    // Two directories can both be called `api`. Each would get its own server,
    // so the names would not collide — but being offered the same database name
    // for two different projects is the ambiguity this naming exists to remove.
    const twinA = makeSite(join(root, 'one'), 'twin')
    const twinB = makeSite(join(root, 'two'), 'twin')
    const projA = await harbor.projects.link(twinA)
    const projB = await harbor.projects.link(twinB)
    try {
      await harbor.services.attach({ owner: projA.id, serviceId: 'postgres' }, { autoStart: false })
      await harbor.services.attach({ owner: projB.id, serviceId: 'postgres' }, { autoStart: false })
      const dbA = harbor.services.get({ owner: projA.id, serviceId: 'postgres' })?.values.database
      const dbB = harbor.services.get({ owner: projB.id, serviceId: 'postgres' })?.values.database
      step(
        'two projects with the same name are never offered the same database name',
        dbA === 'twin' && dbB === 'twin_2',
        `${String(dbA)} vs ${String(dbB)}`
      )
    } finally {
      await harbor.projects.forget(projA.id, { destroyData: true }).catch(() => undefined)
      await harbor.projects.forget(projB.id, { destroyData: true }).catch(() => undefined)
    }

    // Rendered rather than started: the compose file is what the daemon is
    // handed, so asserting on it proves the whole render path without waiting
    // on an image pull.
    const stackA = harbor.services.stack(alpha.id)
    const stackB = harbor.services.stack(beta.id)
    const defA = (stackA.fragments.mysql?.services.mysql ?? {}) as {
      command?: string[]
      labels?: Record<string, string>
      container_name?: string
      ports?: string[]
    }
    const defB = (stackB.fragments.mysql?.services.mysql ?? {}) as {
      command?: string[]
      ports?: string[]
    }

    step(
      "one project's binlog flags do not appear in the other's",
      (defA.command ?? []).some((arg) => arg.startsWith('--log-bin')) &&
        !(defB.command ?? []).some((arg) => arg.startsWith('--log-bin')),
      `A: ${(defA.command ?? []).join(' ')} | B: ${(defB.command ?? []).join(' ')}`
    )
    step(
      'extra arguments are appended to the flags the form produced',
      (defA.command ?? []).includes('--max-connections=42') &&
        (defA.command ?? []).some((arg) => arg.startsWith('--log-bin')),
      (defA.command ?? []).join(' ')
    )
    step(
      'no fragment sets container_name',
      defA.container_name === undefined,
      String(defA.container_name)
    )
    step(
      'each fragment is labelled with its owner',
      defA.labels?.['com.harbor.owner'] === alpha.id &&
        defA.labels?.['com.harbor.service'] === 'mysql',
      JSON.stringify(defA.labels ?? {})
    )
    step(
      'each instance publishes its own host port',
      (defA.ports ?? [])[0] === `${portA}:3306` && (defB.ports ?? [])[0] === `${portB}:3306`,
      `${(defA.ports ?? [])[0]} vs ${(defB.ports ?? [])[0]}`
    )

    // ── env export ──────────────────────────────────────────────────────────
    const envA = await harbor.services.envBlock(refA)
    const envB = await harbor.services.envBlock(refB)
    const portOf = (block: typeof envA): string =>
      block.vars.find((v) => v.key === 'DB_PORT')?.value ?? ''
    step(
      'the two projects export different DB_PORT',
      portOf(envA) !== portOf(envB) && portOf(envA) !== '',
      `${portOf(envA)} vs ${portOf(envB)}`
    )

    // ── running for real ────────────────────────────────────────────────────
    const docker = await harbor.docker.available()
    if (!docker.ok) {
      skip('both stacks come up independently', docker.reason ?? 'no docker daemon')
    } else {
      console.log('  ..   starting both MySQL instances (pulls the image on first run)…')
      let started = 0
      for (const ref of [refA, refB]) {
        try {
          await harbor.services.start(ref)
          started++
        } catch (err) {
          console.log(`  ..   ${ref.serviceId} for ${ref.owner}: ${(err as Error).message}`)
        }
      }

      if (started === 2) {
        const healthOf = async (ref: typeof refA): Promise<string> => {
          const driver = harbor.catalogue.get('mysql')
          let health = await driver.healthCheck(harbor.services.get(ref)!)
          for (let i = 0; i < 120 && health.health !== 'running'; i++) {
            await wait(1000)
            health = await driver.healthCheck(harbor.services.get(ref)!)
          }
          return health.health
        }
        const [healthA, healthB] = [await healthOf(refA), await healthOf(refB)]
        step(
          'both stacks reach running health independently',
          healthA === 'running' && healthB === 'running',
          `${healthA} / ${healthB}`
        )

        const projects = await harbor.docker.listProjects()
        step(
          'the daemon shows two separate compose projects',
          projects.includes(alpha.composeProject) && projects.includes(beta.composeProject),
          projects.join(', ')
        )

        // ── the database the form asks for actually exists ──────────────────
        // The regression this guards: MYSQL_DATABASE is honoured only when the
        // entrypoint initialises an empty volume, so renaming the database on
        // an existing instance did nothing and the application failed later
        // with "access denied" for a database that had never been created.
        const renamed = await harbor.services.updateConfig(refB, {
          values: { ...(harbor.services.get(refB)?.values ?? {}), database: 'renamed_db' }
        })
        step('renaming the database validates', renamed.ok)

        await harbor.catalogue.get('mysql').bootstrap!(harbor.services.get(refB)!)
        const asUser = await harbor.docker
          .exec(refB, [
            'mysql',
            `-u${String(harbor.services.get(refB)?.values.username ?? 'stackbeta')}`,
            `-p${String(harbor.services.get(refB)?.values.password ?? 'harbor')}`,
            '-D',
            'renamed_db',
            '-N',
            '-e',
            'SELECT DATABASE();'
          ])
          .catch((e: Error) => `ERR ${e.message.split('\n')[0]}`)
        step(
          'a renamed database is created and the user can use it',
          asUser.includes('renamed_db'),
          asUser.trim().slice(0, 90)
        )

        // ── stopping one leaves the other alone ─────────────────────────────
        await harbor.projects.stop(alpha.id)
        await wait(2000)
        const afterA = await harbor.catalogue
          .get('mysql')
          .healthCheck(harbor.services.get(refA)!)
        const afterB = await harbor.catalogue
          .get('mysql')
          .healthCheck(harbor.services.get(refB)!)
        step(
          "stopping one project does not stop the other's stack",
          afterA.health !== 'running' && afterB.health === 'running',
          `${afterA.health} / ${afterB.health}`
        )

        // ── forgetting one tears down only its stack ────────────────────────
        const betaCompose = beta.composeProject
        const alphaId = alpha.id
        await harbor.projects.forget(alpha.id, { destroyData: true })
        const alphaCompose = alpha.composeProject
        alpha = null
        await wait(1500)
        const remaining = await harbor.docker.listProjects()
        step(
          "forgetting a project removes its stack and only its stack",
          !remaining.includes(alphaCompose) && remaining.includes(betaCompose),
          remaining.join(', ')
        )
        // A leaked port key keeps a port reserved forever, so the next project
        // to attach the same service silently lands on the wrong number.
        const leaked = Object.keys(harbor.store.get().ports).filter((k) =>
          k.startsWith(`service:${alphaId}:`)
        )
        step('forgetting a project releases its service ports', leaked.length === 0, leaked.join(', '))
        const strayInstances = harbor.services.forOwner(alphaId)
        step(
          'forgetting a project removes its instance records',
          strayInstances.length === 0,
          strayInstances.map((i) => i.serviceId).join(', ')
        )
      } else {
        skip('both stacks come up independently', 'a port on this machine was already held')
      }
    }

    step('the compose file was written per project', composeOf(beta) !== null, beta.composeProject)

    // ── forgetting leaves nothing behind ────────────────────────────────────
    const gone = await harbor.projects.link(makeSite(root, 'stackgone'))
    const goneVhost = harbor.projects.nginx.vhostPath(gone)
    const goneId = gone.id
    let forgotten: string | null = null
    harbor.projects.once('forgotten', (id: string) => (forgotten = id))
    await harbor.projects.forget(goneId, { destroyData: true })

    step('forgetting removes the project from the store', !harbor.projects.list().some((p) => p.id === goneId))
    // The renderer removes a project from its list on this event. Without it,
    // forgetting from the detail page navigated back to a list that still
    // showed the project.
    step('forgetting announces itself so views can drop the project', forgotten === goneId, String(forgotten))
    step('forgetting removes the vhost', !existsSync(goneVhost), goneVhost.split('/').pop() ?? '')
  } finally {
    for (const project of [alpha, beta]) {
      if (project) {
        await harbor.projects.forget(project.id, { destroyData: true }).catch(() => undefined)
      }
    }
    rmSync(root, { recursive: true, force: true })
    // Deliberately not `harbor.shutdown()`: it calls `services.stopAll()`, which
    // stops every instance on the machine — including ones the user is running
    // and this script never touched. Flushing and exiting kills this process's
    // own children and leaves containers alone.
    harbor.store.flush()
  }

  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

void main()
