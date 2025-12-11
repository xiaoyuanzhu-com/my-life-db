import type { LoaderFunctionArgs } from "react-router";
import fs from "fs/promises";
import path from "path";
import { DATA_ROOT } from "~/.server/fs/storage";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "LibraryTreeAPI" });

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
}

function shouldExclude(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (name === "node_modules" || name === ".git") return true;
  return false;
}

async function readDirectoryTree(
  dirPath: string,
  relativePath: string = "",
  maxDepth: number = 5,
  currentDepth: number = 0
): Promise<FileNode[]> {
  if (currentDepth >= maxDepth) {
    return [];
  }

  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const item of items) {
      if (shouldExclude(item.name)) continue;

      const itemPath = path.join(dirPath, item.name);
      const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;

      if (item.isDirectory()) {
        nodes.push({
          name: item.name,
          path: itemRelativePath,
          type: "folder",
          children: [],
        });
      } else if (item.isFile()) {
        try {
          const stats = await fs.stat(itemPath);
          nodes.push({
            name: item.name,
            path: itemRelativePath,
            type: "file",
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          });
        } catch (error) {
          log.error({ err: error, itemPath }, "Failed to stat file");
        }
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch (error) {
    log.error({ err: error, dirPath }, "Failed to read directory tree");
    return [];
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const requestedPath = url.searchParams.get("path") || "";

    const normalizedPath = path.normalize(requestedPath);
    if (normalizedPath.startsWith("..") || path.isAbsolute(normalizedPath)) {
      return Response.json({ error: "Invalid path" }, { status: 400 });
    }

    const fullPath = path.join(DATA_ROOT, normalizedPath);

    const realPath = await fs.realpath(fullPath);
    const realDataRoot = await fs.realpath(DATA_ROOT);
    if (!realPath.startsWith(realDataRoot)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const tree = await readDirectoryTree(fullPath, normalizedPath);

    return Response.json({ path: normalizedPath, nodes: tree });
  } catch (error) {
    log.error({ err: error }, "Library tree API error");
    return Response.json({ error: "Failed to read directory tree" }, { status: 500 });
  }
}
