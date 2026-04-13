import { useState } from "react";
import type { ExplorePost } from "~/types/explore";

interface PostCardProps {
  post: ExplorePost;
  onClick: () => void;
}

/**
 * Bucket an image's natural aspect ratio into one of 3 fixed ratios
 * (like RedNote): portrait 3:4, square 1:1, or landscape 4:3.
 */
function getAspectClass(width: number, height: number): string {
  const ratio = width / height;
  if (ratio > 1.1) return "aspect-[4/3]";
  if (ratio > 0.85) return "aspect-square";
  return "aspect-[3/4]";
}

export function PostCard({ post, onClick }: PostCardProps) {
  const coverImage = post.mediaPaths?.[0];
  const hasMultipleImages = (post.mediaPaths?.length ?? 0) > 1;
  const [aspectClass, setAspectClass] = useState("aspect-[3/4]");

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setAspectClass(getAspectClass(img.naturalWidth, img.naturalHeight));
  };

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
              <div className={`${aspectClass} overflow-hidden`}>
                <img
                  src={`/raw/${coverImage}`}
                  alt={post.title}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onLoad={handleImageLoad}
                />
              </div>
            )}
            {hasMultipleImages && (
              <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                {post.mediaPaths!.length}
              </div>
            )}
          </div>
        )}
        <div className="px-2.5 py-2">
          <h3 className="font-semibold text-sm line-clamp-2 leading-snug">{post.title}</h3>
          <span className="text-xs text-muted-foreground mt-1 block">{post.author}</span>
        </div>
      </div>
    </div>
  );
}
