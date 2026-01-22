import type { SystemInitData } from '~/types/claude'

interface SystemInitBlockProps {
  data: SystemInitData
}

export function SystemInitBlock({ data }: SystemInitBlockProps) {
  // Collect summary items
  const summaryItems: string[] = []
  if (data.tools?.length) summaryItems.push(`${data.tools.length} tools`)
  if (data.mcp_servers?.length) summaryItems.push(`${data.mcp_servers.length} MCP`)
  if (data.agents?.length) summaryItems.push(`${data.agents.length} agents`)
  if (data.skills?.length) summaryItems.push(`${data.skills.length} skills`)
  if (data.plugins?.length) summaryItems.push(`${data.plugins.length} plugins`)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: "Init" + session ID */}
      <div>
        <span className="font-semibold" style={{ color: 'var(--claude-text-primary)' }}>
          Init
        </span>
        <span className="ml-2" style={{ color: 'var(--claude-text-secondary)' }}>
          {data.session_id}
        </span>
      </div>

      {/* Summary line */}
      <div className="mt-1 flex gap-2" style={{ color: 'var(--claude-text-secondary)' }}>
        <span className="select-none">└</span>
        <span>
          {data.model}
          {summaryItems.length > 0 && ` · ${summaryItems.join(' · ')}`}
        </span>
      </div>
    </div>
  )
}
