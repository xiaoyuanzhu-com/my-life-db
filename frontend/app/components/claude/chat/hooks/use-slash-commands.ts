import { useMemo } from 'react'
import { BUILTIN_COMMANDS, type SlashCommand } from '../slash-commands'

export interface InitData {
  slash_commands?: string[]
  skills?: string[]
}

/**
 * Merges built-in commands with dynamic commands from init message.
 * Dynamic commands override built-in ones if there's a name collision.
 */
export function useSlashCommands(initData: InitData | null): SlashCommand[] {
  return useMemo(() => {
    const commandMap = new Map<string, SlashCommand>()

    // Add built-in commands first
    for (const cmd of BUILTIN_COMMANDS) {
      commandMap.set(cmd.name, cmd)
    }

    // Add dynamic slash_commands (overrides built-in)
    if (initData?.slash_commands) {
      for (const name of initData.slash_commands) {
        // If already exists as built-in, keep the description but mark as dynamic
        const existing = commandMap.get(name)
        commandMap.set(name, {
          name,
          description: existing?.description || '',
          source: 'dynamic',
        })
      }
    }

    // Add skills
    if (initData?.skills) {
      for (const skill of initData.skills) {
        // Skills may have format "namespace:name" or just "name"
        const name = skill
        if (!commandMap.has(name)) {
          commandMap.set(name, {
            name,
            description: 'Skill',
            source: 'skill',
          })
        }
      }
    }

    // Convert to array and sort alphabetically
    return Array.from(commandMap.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [initData])
}

/**
 * Filters commands based on search query (text after "/").
 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands
  const lowerQuery = query.toLowerCase()
  return commands.filter((cmd) => cmd.name.toLowerCase().includes(lowerQuery))
}
