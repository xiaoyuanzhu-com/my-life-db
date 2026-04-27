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
  /** Agent affinity. Empty string means vendor-neutral (any agent). */
  agent?: "" | "claude_code" | "codex" | "gemini" | "cursor"
  path: string
}

export interface MCPServerEntry {
  name: string
  type?: string
  url?: string
  command?: string
  disabled: boolean
}

/**
 * List skills discoverable for the current composer state.
 *
 * Pass the composer's selected working directory so project-level skill dirs
 * (.claude/skills, .agents/skills, .gemini/skills under workingDir) are
 * included — matches what the agent runtime would actually load when launched
 * with that cwd. Without workingDir, only bundled + user-level skills are
 * returned.
 */
export function useSkills(workingDir?: string) {
  return useQuery({
    queryKey: ["agent", "skills", workingDir ?? ""],
    queryFn: async (): Promise<SkillEntry[]> => {
      const path = workingDir
        ? `/api/agent/skills?workingDir=${encodeURIComponent(workingDir)}`
        : "/api/agent/skills"
      const res = await api.get(path)
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
