import type { ExplorePost } from "~/types/explore";

interface PostCardProps {
  post: ExplorePost;
  onClick: () => void;
}

export function PostCard({ post, onClick }: PostCardProps) {
  const coverImage = post.mediaPaths?.[0];
  const hasMultipleImages = (post.mediaPaths?.length ?? 0) > 1;

  return (
    <div className="break-inside-avoid mb-3 cursor-pointer group" onClick={onClick}>
      <div className="bg-card rounded-xl overflow-hidden border border-border/50 hover:border-border transition-colors">
        {coverImage && (
          <div className="relative">
            {post.mediaType === "video" ? (
              <div className="aspect-video bg-muted flex items-center justify-center">
                <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center">
                  <div className="w-0 h-0 border-l-[16px] border-l-white border-y-[10px] border-y-transparent ml-1" />
                </div>
              </div>
            ) : (
              <img src={`/raw/${coverImage}`} alt={post.title} className="w-full object-cover" loading="lazy" />
            )}
            {hasMultipleImages && (
              <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                {post.mediaPaths!.length}
              </div>
            )}
          </div>
        )}
        <div className="p-3">
          <h3 className="font-semibold text-sm line-clamp-2">{post.title}</h3>
          {post.content && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{post.content}</p>}
          {post.tags && post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {post.tags.map((tag) => (
                <span key={tag} className="text-xs bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground">#{tag}</span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs font-medium text-foreground/80">{post.author}</span>
            <span className="text-xs text-muted-foreground">{new Date(post.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
