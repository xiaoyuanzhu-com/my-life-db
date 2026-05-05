# Three-Tab Navigation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify navigation from 5+ sections (Home, Inbox, Library, People, Settings) into 3 tabs: Data, Agent, Me.

**Architecture:** Replace the current route structure and navigation components. The Data page reuses the existing `FileGrid` component for folder browsing with a new search bar and action menu on top. Desktop and mobile share the same interaction model (browse grid → click → detail). The Agent page is unchanged. Settings becomes "Me" at `/me/*`.

**Tech Stack:** React Router 7, React 19, Tailwind CSS 4, shadcn/ui, Lucide icons

**Design doc:** `docs/plans/2026-04-06-three-tab-navigation-design.md`

---

### Task 1: Update route configuration (`spa-routes.tsx`)

**Files:**
- Modify: `frontend/app/spa-routes.tsx`

**Step 1: Rewrite route config**

Replace the entire file with new routes:

```tsx
/**
 * SPA Routes Configuration
 *
 * Three-tab navigation: Data, Agent, Me
 */
import type { RouteObject } from "react-router";

// Layout component
import Root from "./root";

// Route components
import Data from "./routes/data";
import FileView from "./routes/file.$";
import Agent from "./routes/agent";
import Me from "./routes/me";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Root />,
    children: [
      {
        index: true,
        Component: Data,
      },
      {
        path: "file/*",
        Component: FileView,
      },
      {
        path: "agent",
        Component: Agent,
      },
      {
        path: "agent/:sessionId",
        Component: Agent,
      },
      {
        path: "me/*",
        Component: Me,
      },
    ],
  },
];
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: Errors about missing `./routes/data` and `./routes/me` modules (expected at this stage)

---

### Task 2: Create the Data page (`routes/data.tsx`)

**Files:**
- Create: `frontend/app/routes/data.tsx`

**Step 1: Create the Data page component**

This page reuses the existing `FileGrid` component. Both mobile and desktop show the same grid-based folder browser. Desktop gets a wider layout. Top bar has search + three-dot menu.

```tsx
import { useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Search, MoreVertical, Upload, FolderUp, FolderPlus, RefreshCw } from "lucide-react";
import { FileGrid } from "~/components/library/file-grid";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useAuth } from "~/contexts/auth-context";
import { useUploadNotifications } from "~/hooks/use-upload-notifications";

function DataContent() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [createFolderTrigger, setCreateFolderTrigger] = useState(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useUploadNotifications();

  const handleFileOpen = useCallback((path: string, _name: string) => {
    navigate(`/file/${path}`);
  }, [navigate]);

  const handleUploadFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleUploadFolder = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      const { getUploadQueueManager } = await import("~/lib/send-queue/upload-queue-manager");
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();
      const batch = Array.from(files).map(file => ({ file, destination: "" }));
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error("Failed to upload files:", error);
      toast.error(`Failed to upload files: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    e.target.value = "";
  };

  const handleFolderInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      const { getUploadQueueManager } = await import("~/lib/send-queue/upload-queue-manager");
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();
      const batch = Array.from(files).map(file => {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const pathParts = relativePath.split("/");
        pathParts.pop();
        return { file, destination: pathParts.join("/") };
      });
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error("Failed to upload folder:", error);
      toast.error(`Failed to upload folder: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    e.target.value = "";
  };

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    // TODO: implement search navigation/overlay in future iteration
    if (searchQuery.trim()) {
      toast.info("Search coming soon");
    }
  }, [searchQuery]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderInputChange}
        {...{ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>}
      />

      {/* Top bar: search + actions */}
      <div className="shrink-0 px-4 py-3 flex items-center gap-2 md:px-[10%]">
        <form onSubmit={handleSearch} className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </form>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreVertical className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleUploadFile}>
              <Upload className="h-4 w-4 mr-2" />
              Upload File
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleUploadFolder}>
              <FolderUp className="h-4 w-4 mr-2" />
              Upload Folder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateFolderTrigger(n => n + 1)}>
              <FolderPlus className="h-4 w-4 mr-2" />
              New Folder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRefreshTrigger(n => n + 1)}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* File grid (same component for mobile and desktop) */}
      <div className="flex-1 overflow-hidden md:px-[10%]">
        <FileGrid
          key={refreshTrigger}
          onFileOpen={handleFileOpen}
          selectedFilePath={null}
          createFolderTrigger={createFolderTrigger}
          onUploadFile={handleUploadFile}
          onUploadFolder={handleUploadFolder}
        />
      </div>
    </div>
  );
}

export default function DataPage() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">Data</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            Browse and manage your personal data files.
          </p>
          <p className="text-muted-foreground">
            Please sign in to get started.
          </p>
        </div>
      </div>
    );
  }

  return <DataContent />;
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: Error about missing `./routes/me` only

---

### Task 3: Create the Me page (`routes/me.tsx`)

**Files:**
- Create: `frontend/app/routes/me.tsx`
- Reference: `frontend/app/routes/settings.tsx` (copy and adapt)

**Step 1: Create Me page**

Copy `settings.tsx` to `me.tsx` and update:
- Change the title from "Settings" to "Me"
- Update all internal paths from `/settings/*` to `/me/*`
- Keep all settings functionality intact

The key changes from settings.tsx:
- `SettingsHeader` title: "Settings" → "Me"
- Tab paths: `/settings` → `/me`, `/settings/vendors` → `/me/vendors`, etc.
- The `useParams` wildcard pattern stays the same since the route is `me/*`

```tsx
// Copy settings.tsx content, then apply these changes:
// 1. Title: "Settings" → "Me"
// 2. All path references: "/settings" → "/me"
```

Specifically, in the tabs array:
```tsx
const tabs = [
  { label: "General", value: "general", path: "/me" },
  { label: "Vendors", value: "vendors", path: "/me/vendors" },
  { label: "Digest", value: "digest", path: "/me/digest" },
  { label: "Data Sources", value: "data-sources", path: "/me/data-sources" },
  { label: "Stats", value: "stats", path: "/me/stats" },
];
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS (no errors)

**Step 3: Commit**

```bash
git add frontend/app/spa-routes.tsx frontend/app/routes/data.tsx frontend/app/routes/me.tsx
git commit -m "feat: add Data and Me route pages, update route config for three-tab nav"
```

---

### Task 4: Update navigation components

**Files:**
- Modify: `frontend/app/components/bottom-nav.tsx`
- Modify: `frontend/app/components/header.tsx`
- Modify: `frontend/app/root.tsx`

**Step 1: Update bottom-nav.tsx for 3 tabs**

Replace the navItems and icons:

```tsx
import { Link, useLocation } from 'react-router';
import { Database, Bot, User } from 'lucide-react';
import { cn } from '~/lib/utils';

const navItems = [
  {
    href: '/',
    label: 'Data',
    icon: Database,
  },
  {
    href: '/agent',
    label: 'Agent',
    icon: Bot,
  },
  {
    href: '/me',
    label: 'Me',
    icon: User,
  },
];

export function BottomNav() {
  const location = useLocation();
  const pathname = location.pathname;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t md:hidden">
      <div className="pb-safe">
        <div className="flex items-center justify-around">
          {navItems.map((item) => {
            const isActive = item.href === '/'
              ? pathname === '/' || pathname.startsWith('/file/')
              : pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 py-3 px-4 min-w-[64px] transition-colors',
                  'active:bg-accent/50',
                  isActive
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span className="text-xs font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
```

**Step 2: Update header.tsx for desktop nav**

Update the `navLinks` array and profile dropdown:

```tsx
// Change navLinks to:
const navLinks = [
  { href: '/', label: 'Data', icon: Database },
  { href: '/agent', label: 'Agent', icon: Terminal },
  { href: '/me', label: 'Me', icon: User },
];
```

- Import `User` from lucide-react (add to existing import), remove `Home`, `Library`, `Settings`
- Remove the profile dropdown menu entirely — "Me" tab replaces it
- Update desktop nav to show all 3 links (change `navLinks.slice(0, 3)` to just `navLinks`)
- Remove the avatar/dropdown section for authenticated users on desktop — just show the 3 nav links
- On mobile, the Sheet menu can be removed since BottomNav handles navigation

**Step 3: Integrate BottomNav into root.tsx**

In `root.tsx`, import and render `BottomNav`:

```tsx
import { BottomNav } from "~/components/bottom-nav";
```

Add `<BottomNav />` after `<main>` in the Root component, with the same conditional logic as the header (hide on share pages, hide in native app):

```tsx
{!native && <ConditionalBottomNav />}
```

Where `ConditionalBottomNav` hides on share pages and agent session detail (same as header):

```tsx
function ConditionalBottomNav() {
  const location = useLocation();
  const isSharePage = /^\/share\//.test(location.pathname);
  const isAgentSessionDetail = /^\/agent\/[^/]+/.test(location.pathname);
  if (isSharePage || isAgentSessionDetail) return null;
  return <BottomNav />;
}
```

Also add bottom padding to `<main>` on mobile to account for the fixed bottom nav:

```tsx
<main className={`min-h-0 h-full flex flex-col w-full min-w-0${native ? '' : ' row-start-2'} pb-[60px] md:pb-0`}>
```

**Step 4: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/app/components/bottom-nav.tsx frontend/app/components/header.tsx frontend/app/root.tsx
git commit -m "feat: update navigation for three-tab layout (Data, Agent, Me)"
```

---

### Task 5: Update file detail back-navigation

**Files:**
- Modify: `frontend/app/routes/file.$.tsx`
- Modify: `frontend/app/lib/file-path-resolver.ts`

**Step 1: Update file.$.tsx back button**

The file detail page currently navigates back to `/library?open=...`. Update to navigate to `/` (Data page):

Find the line:
```tsx
navigate(`/library?open=${encodeURIComponent(filePath)}`);
```
Replace with:
```tsx
navigate('/');
```

Or better, use `navigate(-1)` to go back in history if available:
```tsx
navigate(-1);
```

**Step 2: Update file-path-resolver.ts**

The `libraryUrl()` function generates `/library?...` URLs. Update to use root path:

```tsx
export function libraryUrl(resolved: ResolvedPath): string {
  if (resolved.libraryRelative === null) return '#'
  // Navigate to file detail view
  return `/file/${resolved.libraryRelative}`
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS

**Step 4: Commit**

```bash
git add frontend/app/routes/file.$.tsx frontend/app/lib/file-path-resolver.ts
git commit -m "feat: update file navigation paths from /library to new Data page"
```

---

### Task 6: Remove unused route files and components

**Files:**
- Delete: `frontend/app/routes/home.tsx`
- Delete: `frontend/app/routes/inbox.tsx`
- Delete: `frontend/app/routes/inbox.$id.tsx`
- Delete: `frontend/app/routes/library.tsx`
- Delete: `frontend/app/routes/library.browse.tsx`
- Delete: `frontend/app/routes/people.tsx`
- Delete: `frontend/app/routes/people.$id.tsx`
- Delete: `frontend/app/routes/settings.tsx`

**Step 1: Delete the old route files**

```bash
cd frontend/app/routes
rm home.tsx inbox.tsx inbox.\$id.tsx library.tsx library.browse.tsx people.tsx people.\$id.tsx settings.tsx
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS (these files are no longer imported)

**Step 3: Verify build succeeds**

Run: `cd frontend && npm run build 2>&1 | tail -10`
Expected: Build completes successfully

**Step 4: Commit**

```bash
git add -A frontend/app/routes/
git commit -m "chore: remove old route files (home, inbox, library, people, settings)"
```

---

### Task 7: Update native bridge references

**Files:**
- Modify: `frontend/app/lib/native-bridge.ts` (if it references `/library`)

**Step 1: Check and update native bridge**

The native bridge has a reference to `/library` in a comment. Update any hardcoded `/library` paths to `/` or `/file/...` as appropriate. This is primarily documentation — the actual navigation is dynamic via `navigateTo()`.

Also check `root.tsx` for the library link click interceptor — update the class check if needed (`.library-file-link` links should now navigate to `/file/...` paths).

**Step 2: Verify TypeScript compiles and build succeeds**

Run: `cd frontend && npx tsc --noEmit && npm run build 2>&1 | tail -5`
Expected: PASS

**Step 3: Commit**

```bash
git add frontend/app/lib/native-bridge.ts frontend/app/root.tsx
git commit -m "chore: update native bridge references for new navigation"
```

---

### Task 8: Final verification

**Step 1: Full typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 2: Full build**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 3: Lint**

Run: `cd frontend && npm run lint`
Expected: No errors (or only pre-existing warnings)

**Step 4: Manual verification checklist**

- [ ] `/` loads Data page with file grid + search bar + three-dot menu
- [ ] Clicking a file navigates to `/file/<path>` detail view
- [ ] `/agent` loads Agent page (unchanged)
- [ ] `/me` loads Me (settings) page with all tabs working
- [ ] Bottom nav shows 3 tabs on mobile: Data, Agent, Me
- [ ] Desktop header shows 3 nav links: Data, Agent, Me
- [ ] Old routes (`/inbox`, `/library`, `/people`, `/settings`) return 404
- [ ] Three-dot menu: Upload File, Upload Folder, New Folder, Refresh all work
