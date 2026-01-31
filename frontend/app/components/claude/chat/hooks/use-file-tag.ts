import { useState, useEffect, useMemo } from 'react'
import { api } from '~/lib/api'

export interface FileItem {
  path: string
  type: 'file' | 'folder'
}

interface FileNode {
  path: string
  type: 'file' | 'folder'
  children?: FileNode[]
}

interface TreeResponse {
  basePath: string
  path: string
  children: FileNode[]
}

/**
 * Flattens a tree of FileNodes into a flat array of FileItems.
 */
function flattenTree(nodes: FileNode[], prefix = ''): FileItem[] {
  const result: FileItem[] = []
  for (const node of nodes) {
    const fullPath = prefix ? `${prefix}/${node.path}` : node.path
    result.push({ path: fullPath, type: node.type })
    if (node.children) {
      result.push(...flattenTree(node.children, fullPath))
    }
  }
  return result
}

/**
 * Fuzzy match: checks if all characters in pattern appear in order in str.
 * Returns a score (higher is better match) or -1 if no match.
 *
 * Scoring:
 * - +1 per matched char, +2 if consecutive
 * - +3 for word boundary matches (after / or .)
 * - +10 if pattern is an exact substring
 * - +15 if pattern matches in filename (not just path)
 * - -0.1 per path char (prefer shorter paths)
 */
function fuzzyMatch(pattern: string, str: string): number {
  const lowerPattern = pattern.toLowerCase()
  const lowerStr = str.toLowerCase()

  let patternIdx = 0
  let score = 0
  let lastMatchIdx = -1

  for (let i = 0; i < lowerStr.length && patternIdx < lowerPattern.length; i++) {
    if (lowerStr[i] === lowerPattern[patternIdx]) {
      // Bonus for consecutive matches
      if (lastMatchIdx === i - 1) {
        score += 2
      } else {
        score += 1
      }
      // Bonus for matching at word boundaries (after / or .)
      if (i === 0 || lowerStr[i - 1] === '/' || lowerStr[i - 1] === '.') {
        score += 3
      }
      lastMatchIdx = i
      patternIdx++
    }
  }

  // All pattern characters must be found
  if (patternIdx < lowerPattern.length) {
    return -1
  }

  // Bonus for exact substring match (contiguous characters)
  if (lowerStr.includes(lowerPattern)) {
    score += 10
  }

  // Bonus for matching in filename (after last /)
  const lastSlash = lowerStr.lastIndexOf('/')
  const filename = lastSlash >= 0 ? lowerStr.slice(lastSlash + 1) : lowerStr
  if (filename.includes(lowerPattern)) {
    score += 15
  }

  // Slight penalty for longer paths (normalize score)
  // Subtract 0.1 per character to prefer shorter paths with same match quality
  score -= str.length * 0.1

  return score
}

/**
 * Filters and sorts files based on fuzzy query.
 */
export function filterFiles(files: FileItem[], query: string): FileItem[] {
  if (!query) return files.slice(0, 50) // Limit initial list

  const scored = files
    .map((file) => ({ file, score: fuzzyMatch(query, file.path) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, 50).map(({ file }) => file)
}

/**
 * Hook to fetch and manage file list for tagging.
 */
export function useFileTag(workingDir: string | undefined) {
  const [files, setFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workingDir) {
      setFiles([])
      return
    }

    const fetchFiles = async () => {
      setLoading(true)
      setError(null)
      try {
        // Fetch all files recursively (depth=0 means unlimited)
        const params = new URLSearchParams({
          path: workingDir,
          depth: '0',
        })
        const response = await api.get(`/api/library/tree?${params}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch files: ${response.statusText}`)
        }
        const data: TreeResponse = await response.json()
        const flattened = flattenTree(data.children)
        setFiles(flattened)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
        setFiles([])
      } finally {
        setLoading(false)
      }
    }

    fetchFiles()
  }, [workingDir])

  return { files, loading, error }
}

/**
 * Hook to get filtered files based on query.
 */
export function useFilteredFiles(files: FileItem[], query: string): FileItem[] {
  return useMemo(() => filterFiles(files, query), [files, query])
}
