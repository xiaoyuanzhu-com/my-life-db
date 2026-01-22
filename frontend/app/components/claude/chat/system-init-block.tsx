import type { SystemInitData } from '~/types/claude'

interface SystemInitBlockProps {
  data: SystemInitData
}

export function SystemInitBlock({ data }: SystemInitBlockProps) {
  return (
    <div
      className="rounded-lg p-4 text-sm space-y-3"
      style={{ backgroundColor: 'var(--claude-bg-subtle)' }}
    >
      {/* Title */}
      <div className="font-medium" style={{ color: 'var(--claude-text-primary)' }}>
        Init {data.session_id.slice(0, 8)}...
      </div>

      {/* Model */}
      <TagSection label="Model">
        <Tag>{data.model}</Tag>
      </TagSection>

      {/* Tools */}
      {data.tools?.length > 0 && (
        <TagSection label="Tools">
          {data.tools.map((tool) => (
            <Tag key={tool}>{tool}</Tag>
          ))}
        </TagSection>
      )}

      {/* MCP Servers */}
      {data.mcp_servers?.length > 0 && (
        <TagSection label="MCP Servers">
          {data.mcp_servers.map((server) => (
            <Tag
              key={server.name}
              variant={server.status === 'connected' ? 'success' : 'muted'}
            >
              {server.name}
            </Tag>
          ))}
        </TagSection>
      )}

      {/* Slash Commands */}
      {data.slash_commands?.length > 0 && (
        <TagSection label="Slash Commands">
          {data.slash_commands.map((cmd) => (
            <Tag key={cmd}>/{cmd}</Tag>
          ))}
        </TagSection>
      )}

      {/* Agents */}
      {data.agents?.length > 0 && (
        <TagSection label="Agents">
          {data.agents.map((agent) => (
            <Tag key={agent}>{agent}</Tag>
          ))}
        </TagSection>
      )}

      {/* Skills */}
      {data.skills?.length > 0 && (
        <TagSection label="Skills">
          {data.skills.map((skill) => (
            <Tag key={skill}>{skill}</Tag>
          ))}
        </TagSection>
      )}

      {/* Plugins */}
      {data.plugins?.length > 0 && (
        <TagSection label="Plugins">
          {data.plugins.map((plugin) => (
            <Tag key={plugin.name}>{plugin.name}</Tag>
          ))}
        </TagSection>
      )}
    </div>
  )
}

function TagSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div
        className="text-xs font-medium uppercase tracking-wide"
        style={{ color: 'var(--claude-text-secondary)' }}
      >
        {label}
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

function Tag({
  children,
  variant = 'default',
}: {
  children: React.ReactNode
  variant?: 'default' | 'success' | 'muted'
}) {
  const variantStyles = {
    default: {
      backgroundColor: 'var(--claude-bg-code-block)',
      color: 'var(--claude-text-primary)',
    },
    success: {
      backgroundColor: 'rgba(34, 197, 94, 0.15)',
      color: 'rgb(34, 197, 94)',
    },
    muted: {
      backgroundColor: 'var(--claude-bg-code-block)',
      color: 'var(--claude-text-secondary)',
    },
  }

  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono"
      style={variantStyles[variant]}
    >
      {children}
    </span>
  )
}
