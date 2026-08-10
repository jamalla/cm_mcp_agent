/** The approved tool list, as the agent sees it.
 *
 * Everything here arrived over MCP from `list_contracts` — the engine's
 * `public_view()`. There is no binding, no host and no credential in this payload,
 * which is the point: the routing layer decides between tools it cannot inspect
 * the internals of.
 *
 * The provenance line matters as much as the list. The engine resolves contracts
 * from one of four sources, and only one of them is the artifact the pipeline
 * published and a human merged. A demo that shows the tool list without saying
 * where it came from cannot claim the tools are approved.
 */
import { useState } from 'react'

export type RegistryTool = {
  name: string
  version: string
  title?: string
  description?: string
  whenToUse?: string[]
  whenNotToUse?: string[]
  annotations?: Record<string, boolean>
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] }
}

export type Registry = {
  tools: RegistryTool[]
  warnings?: string[]
  source?: { kind: string; path: string; origin: string }
}

/** Arguments as chips, required ones marked. */
function args(tool: RegistryTool): { name: string; required: boolean }[] {
  const properties = Object.keys(tool.inputSchema?.properties ?? {})
  const required = new Set(tool.inputSchema?.required ?? [])
  return properties.map((name) => ({ name, required: required.has(name) }))
}

export function RegistryPanel({
  registry,
  onClose,
  onRefresh,
}: {
  registry: Registry
  onClose: () => void
  onRefresh: () => void
}) {
  const [open, setOpen] = useState<string | null>(null)

  // Only a pinned artifact is the approved set. A contracts directory is whatever
  // is on someone's disk — useful for iterating, and not the same claim.
  const approved = registry.source?.kind === 'registry-file'

  return (
    <section className="registry-panel">
      <header>
        <div>
          <strong>{registry.tools.length}</strong> tool
          {registry.tools.length === 1 ? '' : 's'} the agent may call
          <span className={`badge ${approved ? 'badge-approved' : 'badge-dev'}`}>
            {approved ? 'APPROVED REGISTRY' : 'DEVELOPMENT SOURCE'}
          </span>
        </div>
        <div className="registry-actions">
          <button onClick={onRefresh}>re-read</button>
          <button onClick={onClose}>close</button>
        </div>
      </header>

      {registry.source && (
        <p className="registry-source">
          {approved
            ? 'Pinned artifact published by cm_mcp_contracts and merged here after review — every tool below passed the contract gate.'
            : 'Read straight from a contracts checkout, so this is whatever is on disk — not the approved artifact.'}
          <code>{registry.source.origin}</code>
        </p>
      )}

      {registry.warnings && registry.warnings.length > 0 && (
        <ul className="registry-warnings">
          {/* Contracts the engine refused to serve, and why. Worth showing: a tool
              silently missing is the failure this panel exists to make visible. */}
          {registry.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <ul className="registry-tools">
        {registry.tools.map((tool) => {
          const readOnly = tool.annotations?.readOnlyHint
          const expanded = open === tool.name
          return (
            <li key={tool.name}>
              <button className="registry-tool" onClick={() => setOpen(expanded ? null : tool.name)}>
                <span className="registry-name">{tool.name}</span>
                <span className="registry-version">v{tool.version}</span>
                <span className={`badge ${readOnly ? 'badge-read' : 'badge-write'}`}>
                  {readOnly ? 'READ-ONLY' : 'WRITE'}
                </span>
                {tool.annotations?.destructiveHint && (
                  <span className="badge badge-destructive">DESTRUCTIVE</span>
                )}
              </button>

              {expanded && (
                <div className="registry-detail">
                  <p>{tool.description}</p>

                  <div className="registry-args">
                    {args(tool).map(({ name, required }) => (
                      <code key={name} className={required ? 'required' : ''}>
                        {name}
                        {required ? '*' : ''}
                      </code>
                    ))}
                  </div>

                  {tool.whenToUse && tool.whenToUse.length > 0 && (
                    <>
                      <h4>Use when</h4>
                      <ul>
                        {tool.whenToUse.map((hint) => (
                          <li key={hint}>{hint}</li>
                        ))}
                      </ul>
                    </>
                  )}

                  {tool.whenNotToUse && tool.whenNotToUse.length > 0 && (
                    <>
                      <h4>Do not use when</h4>
                      <ul className="negative">
                        {tool.whenNotToUse.map((hint) => (
                          <li key={hint}>{hint}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
