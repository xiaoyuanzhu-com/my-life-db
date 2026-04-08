import { useState } from "react";
import { useAuth } from "~/contexts/auth-context";
import { ExploreFeed } from "~/components/explore/explore-feed";
import { PostDetail } from "~/components/explore/post-detail";
import type { ExplorePost } from "~/types/explore";

function ExploreContent() {
  const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(null);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ExploreFeed onPostClick={setSelectedPost} />
      {selectedPost && (
        <PostDetail
          postId={selectedPost.id}
          onClose={() => setSelectedPost(null)}
        />
      )}
    </div>
  );
}

export default function ExplorePage() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return null;
  return <ExploreContent />;
}
