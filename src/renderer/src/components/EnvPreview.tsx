import { useState } from 'react'
import type { EnvBlock } from '../../../shared/service.js'
import { invoke } from '../ipc/client.js'

/**
 * Read-only preview + copy for a service's .env block. The values come from the
 * main process resolved against live config, so this component never knows
 * anything service-specific.
 */
export function EnvPreview({ serviceId }: { serviceId: string }): React.JSX.Element {
  const [block, setBlock] = useState<EnvBlock | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async (): Promise<EnvBlock> => {
    const result = await invoke('services:envBlock', serviceId)
    setBlock(result)
    return result
  }

  const copy = async (): Promise<void> => {
    const result = block ?? (await load())
    await navigator.clipboard.writeText(renderBlock(result))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="env-preview">
      <div className="env-actions">
        <button type="button" className="btn" onClick={() => void load()}>
          {block ? 'Refresh' : 'Preview .env'}
        </button>
        <button type="button" className="btn" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy .env'}
        </button>
      </div>
      {block && <pre className="env-block">{renderBlock(block)}</pre>}
    </div>
  )
}

export function renderBlock(block: EnvBlock): string {
  return block.vars.map(({ key, value }) => `${key}=${value}`).join('\n')
}
