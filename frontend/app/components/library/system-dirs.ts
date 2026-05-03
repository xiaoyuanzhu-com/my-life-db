import folderGenericIcon from '~/assets/folder-generic.svg?raw';
import folderAgentsIcon from '~/assets/folder-agents.svg?raw';
import folderSessionsIcon from '~/assets/folder-sessions.svg?raw';
import folderExploreIcon from '~/assets/folder-explore.svg?raw';

export const FOLDER_GENERIC_ICON = folderGenericIcon;

interface SystemDirInfo {
  /** Inline SVG markup for this system dir. Uses fill="currentColor" so the
   * outer body tints with the parent's CSS color. */
  icon: string;
  /** i18n key under data:library.systemDirs (e.g. "agents") — value is the description shown to the user */
  descriptionKey: string;
}

/**
 * Folders MyLifeDB itself reads from / writes to. Recognized only at the
 * data root — nested matches (e.g. `notes/agents`) are NOT treated as system.
 */
const SYSTEM_DIRS: Record<string, SystemDirInfo> = {
  agents: { icon: folderAgentsIcon, descriptionKey: 'agents' },
  sessions: { icon: folderSessionsIcon, descriptionKey: 'sessions' },
  explore: { icon: folderExploreIcon, descriptionKey: 'explore' },
};

/**
 * Look up system-dir metadata for a top-level folder. Returns null for
 * non-folders, non-root paths, and unknown names.
 */
export function getSystemDir(
  fullPath: string,
  isFolder: boolean,
): SystemDirInfo | null {
  if (!isFolder) return null;
  return SYSTEM_DIRS[fullPath] ?? null;
}
