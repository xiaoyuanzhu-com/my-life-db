/**
 * Hooks for the Skills + MCP sections of the composer + menu.
 *
 * Skills are read-only — discovery only, since SKILL.md files load on description
 * match, not on a manual toggle. MCP servers are listed from .mcp.json with a
 * `disabled` toggle that round-trips through the backend.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "~/lib/api"

export interface SkillEntry {
  name: string
  description?: string
  source: "bundled" | "user" | "project"
  path: string
}

export interface MCPServerEntry {
  name: string
  type?: string
  url?: string
  command?: string
  disabled: boolean
}

export function useSkills() {
  return useQuery({
    queryKey: ["agent", "skills"],
    queryFn: async (): Promise<SkillEntry[]> => {
      const res = await api.get("/api/agent/skills")
      const body = await res.json()
      return body.skills ?? []
    },
    staleTime: 60 * 1000,
  })
}

export function useMCPServers() {
  return useQuery({
    queryKey: ["agent", "mcp-servers"],
    queryFn: async (): Promise<MCPServerEntry[]> => {
      const res = await api.get("/api/agent/mcp-servers")
      const body = await res.json()
      return body.servers ?? []
    },
    staleTime: 60 * 1000,
  })
}

export function useToggleMCPServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, disabled }: { name: string; disabled: boolean }) => {
      const res = await api.patch(`/api/agent/mcp-servers/${encodeURIComponent(name)}`, {
        disabled,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `failed to update ${name}`)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent", "mcp-servers"] })
    },
  })
}
