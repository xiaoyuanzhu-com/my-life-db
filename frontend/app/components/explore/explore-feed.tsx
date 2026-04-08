import { useState, useEffect, useCallback, useRef } from "react";
import { fetchExplorePosts } from "~/hooks/use-explore";
import { PostCard } from "./post-card";
import type { ExplorePost } from "~/types/explore";

const BATCH_SIZE = 30;
const SCROLL_THRESHOLD = 1000;

interface ExploreFeedProps {
  onPostClick: (post: ExplorePost) => void;
}

export function ExploreFeed({ onPostClick }: ExploreFeedProps) {
  const [posts, setPosts] = useState<ExplorePost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [lastCursor, setLastCursor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchExplorePosts({ limit: BATCH_SIZE });
        if (cancelled) return;
        setPosts(data.items);
        setHasMoreOlder(data.hasMore.older);
        setLastCursor(data.cursors.last);
      } catch (err) {
        console.error("Failed to load explore posts:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreOlder || !lastCursor) return;
    setLoadingMore(true);
    try {
      const data = await fetchExplorePosts({ before: lastCursor, limit: BATCH_SIZE });
      setPosts((prev) => [...prev, ...data.items]);
      setHasMoreOlder(data.hasMore.older);
      setLastCursor(data.cursors.last);
    } catch (err) {
      console.error("Failed to load more posts:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMoreOlder, lastCursor]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < SCROLL_THRESHOLD) loadMore();
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [loadMore]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2">
        <p className="text-muted-foreground text-sm">No posts yet.</p>
        <p className="text-muted-foreground text-xs">Posts will appear here when agents publish them via MCP.</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="p-4 md:px-[10%]">
        <div className="columns-2 md:columns-3 lg:columns-4 gap-3">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} onClick={() => onPostClick(post)} />
          ))}
        </div>
        {loadingMore && (
          <div className="flex justify-center py-4">
            <div className="text-muted-foreground text-sm">Loading more...</div>
          </div>
        )}
      </div>
    </div>
  );
}
