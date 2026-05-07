import { useParams, useNavigate } from "react-router";
import { useAuth } from "~/contexts/auth-context";
import { ExploreFeed } from "~/components/explore/explore-feed";
import { PostDetail } from "~/components/explore/post-detail";

function ExploreContent() {
  const { postId } = useParams<{ postId: string }>();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ExploreFeed onPostClick={(post) => navigate(`/explore/${post.id}`)} />
      {postId && isAuthenticated && (
        <PostDetail
          postId={postId}
          onClose={() => navigate("/explore", { replace: true })}
        />
      )}
    </div>
  );
}

export default function ExplorePage() {
  const { isLoading } = useAuth();
  if (isLoading) return null;
  return <ExploreContent />;
}
