import type { PhpFrameworkDriver } from '../../../shared/project.js'
import { LaravelDriver } from './laravel.js'
import { SymfonyDriver } from './symfony.js'
import { WordPressDriver } from './wordpress.js'
import { PlainPhpDriver } from './plain.js'

/**
 * Detection runs highest-priority first and stops at the first match, so
 * specific frameworks always beat the generic fallback. Registering a new
 * framework is a driver file plus one line here — the nginx template never
 * changes.
 */
export class PhpFrameworkRegistry {
  private readonly drivers: PhpFrameworkDriver[] = []

  register(driver: PhpFrameworkDriver): void {
    this.drivers.push(driver)
    this.drivers.sort((a, b) => b.priority - a.priority)
  }

  list(): PhpFrameworkDriver[] {
    return [...this.drivers]
  }

  get(id: string): PhpFrameworkDriver | null {
    return this.drivers.find((d) => d.id === id) ?? null
  }

  async detect(dir: string): Promise<PhpFrameworkDriver> {
    for (const driver of this.drivers) {
      if (await driver.detect(dir)) return driver
    }
    throw new Error('No PHP framework driver matched — the plain driver must be registered')
  }
}

export function createPhpFrameworkRegistry(): PhpFrameworkRegistry {
  const registry = new PhpFrameworkRegistry()
  registry.register(new LaravelDriver())
  registry.register(new SymfonyDriver())
  registry.register(new WordPressDriver())
  registry.register(new PlainPhpDriver())
  return registry
}
