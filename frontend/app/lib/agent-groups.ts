/**
 * Agent session group API client.
 *
 * Groups organize agent sessions in the sidebar. A session may belong to one
 * group (or none — "ungrouped"). Pinning is a separate orthogonal flag, surfaced
 * as a virtual "Pinned" section that pulls pinned sessions to the top regardless
 * of their group.
 */

import { api } from './api'

export interface AgentSessionGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export async function listAgentSessionGroups(): Promise<AgentSessionGroup[]> {
  const res = await api.get('/api/agent/groups')
  if (!res.ok) throw new Error(`listAgentSessionGroups: ${res.status}`)
  const data = await res.json()
  return (data.groups ?? []) as AgentSessionGroup[]
}

export async function createAgentSessionGroup(name: string): Promise<AgentSessionGroup> {
  const res = await api.post('/api/agent/groups', { name })
  if (!res.ok) throw new Error(`createAgentSessionGroup: ${res.status}`)
  const data = await res.json()
  return data.group as AgentSessionGroup
}

export async function renameAgentSessionGroup(id: string, name: string): Promise<void> {
  const res = await api.patch(`/api/agent/groups/${id}`, { name })
  if (!res.ok) throw new Error(`renameAgentSessionGroup: ${res.status}`)
}

export async function deleteAgentSessionGroup(id: string): Promise<void> {
  const res = await api.delete(`/api/agent/groups/${id}`)
  if (!res.ok) throw new Error(`deleteAgentSessionGroup: ${res.status}`)
}

export async function reorderAgentSessionGroups(ids: string[]): Promise<void> {
  const res = await api.put('/api/agent/groups/order', { ids })
  if (!res.ok) throw new Error(`reorderAgentSessionGroups: ${res.status}`)
}

// Session-side mutations: groupId / pinned go through PATCH /api/agent/sessions/:id.
// `groupId: null` clears the group; omitting the key leaves it unchanged.
export async function setAgentSessionGroup(sessionId: string, groupId: string | null): Promise<void> {
  const res = await api.patch(`/api/agent/sessions/${sessionId}`, { groupId })
  if (!res.ok) throw new Error(`setAgentSessionGroup: ${res.status}`)
}

export async function setAgentSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
  const res = await api.patch(`/api/agent/sessions/${sessionId}`, { pinned })
  if (!res.ok) throw new Error(`setAgentSessionPinned: ${res.status}`)
}
