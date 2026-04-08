import { useState, useEffect } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchExplorePost } from "~/hooks/use-explore";
import type { ExplorePostWithComments } from "~/types/explore";

interface PostDetailProps {
  postId: string;
  onClose: () => void;
}

export function PostDetail({ postId, onClose }: PostDetailProps) {
  const [post, setPost] = useState<ExplorePostWithComments | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchExplorePost(postId);
        if (!cancelled) setPost(data);
      } catch (err) {
        console.error("Failed to load post:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [postId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (loading || !post) {
    return (
      <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const mediaPaths = post.mediaPaths ?? [];
  const hasMultipleImages = post.mediaType === "image" && mediaPaths.length > 1;

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card rounded-xl border max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end p-3 pb-0">
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
        </div>

        {mediaPaths.length > 0 && (
          <div className="relative">
            {post.mediaType === "video" ? (
              <video src={`/raw/${mediaPaths[0]}`} controls className="w-full" />
            ) : (
              <>
                <img src={`/raw/${mediaPaths[currentImageIndex]}`} alt={post.title} className="w-full object-contain max-h-[60vh]" />
                {hasMultipleImages && (
                  <>
                    <button onClick={() => setCurrentImageIndex((i) => Math.max(0, i - 1))} className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1 disabled:opacity-30" disabled={currentImageIndex === 0}>
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button onClick={() => setCurrentImageIndex((i) => Math.min(mediaPaths.length - 1, i + 1))} className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1 disabled:opacity-30" disabled={currentImageIndex === mediaPaths.length - 1}>
                      <ChevronRight className="h-5 w-5" />
                    </button>
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                      {mediaPaths.map((_, i) => (
                        <div key={i} className={`w-1.5 h-1.5 rounded-full ${i === currentImageIndex ? "bg-white" : "bg-white/50"}`} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        <div className="p-4">
          <h2 className="text-lg font-semibold">{post.title}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm font-medium text-foreground/80">{post.author}</span>
            <span className="text-sm text-muted-foreground">{new Date(post.createdAt).toLocaleDateString()}</span>
          </div>
          {post.content && <p className="mt-3 text-sm whitespace-pre-wrap">{post.content}</p>}
          {post.tags && post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {post.tags.map((tag) => (
                <span key={tag} className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground">#{tag}</span>
              ))}
            </div>
          )}
          {post.comments.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <h3 className="text-sm font-semibold mb-2">Comments ({post.comments.length})</h3>
              <div className="space-y-3">
                {post.comments.map((comment) => (
                  <div key={comment.id}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{comment.author}</span>
                      <span className="text-xs text-muted-foreground">{new Date(comment.createdAt).toLocaleDateString()}</span>
                    </div>
                    <p className="text-sm mt-0.5">{comment.content}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
