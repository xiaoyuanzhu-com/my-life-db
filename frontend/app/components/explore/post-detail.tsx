import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useFormatter } from "~/lib/i18n/use-formatter";
import { fetchExplorePost } from "~/hooks/use-explore";
import { ImageLightbox } from "~/components/ui/image-lightbox";
import type { ExplorePostWithComments } from "~/types/explore";

interface PostDetailProps {
  postId: string;
  onClose: () => void;
}

export function PostDetail({ postId, onClose }: PostDetailProps) {
  const { t } = useTranslation('common');
  const fmt = useFormatter();
  const [post, setPost] = useState<ExplorePostWithComments | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  // Swipe-back state
  const containerRef = useRef<HTMLDivElement>(null);
  const [swipeX, setSwipeX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number; edgeSwipe: boolean } | null>(null);

  // Image swipe state (for carousel)
  const imgTouchRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const [imgDragX, setImgDragX] = useState(0);
  const [imgDragging, setImgDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCurrentImageIndex(0);
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

  // Push browser history entry so back button closes detail
  useEffect(() => {
    const onPopState = () => onClose();
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [onClose]);

  // Edge swipe-back handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    const edgeSwipe = touch.clientX < 30;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, edgeSwipe };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current?.edgeSwipe) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = Math.abs(touch.clientY - touchStartRef.current.y);
    if (dx > 0 && dx > dy) {
      setIsSwiping(true);
      setSwipeX(dx);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (isSwiping && swipeX > 100) {
      onClose();
    }
    setSwipeX(0);
    setIsSwiping(false);
    touchStartRef.current = null;
  }, [isSwiping, swipeX, onClose]);

  // Image carousel swipe handlers
  const mediaPaths = post?.mediaPaths ?? [];
  const hasMultipleImages = post?.mediaType === "image" && mediaPaths.length > 1;

  const handleImgTouchStart = useCallback((e: React.TouchEvent) => {
    // Don't trigger edge swipe-back
    if (e.touches[0].clientX < 30) return;
    const touch = e.touches[0];
    imgTouchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    setImgDragging(true);
  }, []);

  const handleImgTouchMove = useCallback((e: React.TouchEvent) => {
    if (!imgTouchRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - imgTouchRef.current.x;
    setImgDragX(dx);
  }, []);

  const handleImgTouchEnd = useCallback(() => {
    if (!imgTouchRef.current) return;
    const elapsed = Date.now() - imgTouchRef.current.time;
    const velocity = Math.abs(imgDragX) / elapsed;

    if (Math.abs(imgDragX) > 50 || velocity > 0.5) {
      if (imgDragX < 0 && currentImageIndex < mediaPaths.length - 1) {
        setCurrentImageIndex((i) => i + 1);
      } else if (imgDragX > 0 && currentImageIndex > 0) {
        setCurrentImageIndex((i) => i - 1);
      }
    }

    setImgDragX(0);
    setImgDragging(false);
    imgTouchRef.current = null;
  }, [imgDragX, currentImageIndex, mediaPaths.length]);

  const slideStyle = isSwiping
    ? { transform: `translateX(${swipeX}px)`, transition: "none" }
    : { transform: "translateX(0)", transition: "transform 0.2s ease-out" };

  const renderMediaSection = () => {
    if (mediaPaths.length === 0) return null;

    if (post?.mediaType === "video") {
      return (
        <div className="relative">
          <video src={`/raw/${mediaPaths[0]}`} controls className="w-full" />
        </div>
      );
    }

    return (
      <div className="relative">
        {/* Image carousel */}
        <div
          className="overflow-hidden cursor-pointer"
          onTouchStart={hasMultipleImages ? handleImgTouchStart : undefined}
          onTouchMove={hasMultipleImages ? handleImgTouchMove : undefined}
          onTouchEnd={hasMultipleImages ? handleImgTouchEnd : undefined}
          onClick={() => setFullscreenOpen(true)}
        >
          <div
            className="flex"
            style={{
              transform: `translateX(calc(-${currentImageIndex * 100}% + ${imgDragX}px))`,
              transition: imgDragging ? "none" : "transform 0.3s ease-out",
            }}
          >
            {mediaPaths.map((path, i) => (
              <img
                key={i}
                src={`/raw/${path}`}
                alt={post?.title ?? ""}
                className="min-w-full object-contain max-h-[60vh] md:max-h-[80vh] bg-muted"
                draggable={false}
              />
            ))}
          </div>
        </div>

        {/* [current]/[total] indicator - top right */}
        {hasMultipleImages && (
          <div className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
            {currentImageIndex + 1}/{mediaPaths.length}
          </div>
        )}

        {/* Desktop arrow buttons */}
        {hasMultipleImages && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); setCurrentImageIndex((i) => Math.max(0, i - 1)); }}
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1 disabled:opacity-30 hidden md:block"
              disabled={currentImageIndex === 0}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setCurrentImageIndex((i) => Math.min(mediaPaths.length - 1, i + 1)); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1 disabled:opacity-30 hidden md:block"
              disabled={currentImageIndex === mediaPaths.length - 1}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}

        {/* Dot indicator - below image */}
        {hasMultipleImages && (
          <div className="flex justify-center gap-1.5 py-2">
            {mediaPaths.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentImageIndex(i)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${i === currentImageIndex ? "bg-foreground" : "bg-foreground/30"}`}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderTextContent = () => (
    <div className="p-4">
      <h2 className="text-lg font-semibold">{post!.title}</h2>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-sm font-medium text-foreground/80">{post!.author}</span>
        <span className="text-sm text-muted-foreground">{fmt.date(post!.createdAt)}</span>
      </div>
      {post!.content && <p className="mt-3 text-sm whitespace-pre-wrap">{post!.content}</p>}
      {post!.tags && post!.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {post!.tags.map((tag) => (
            <span key={tag} className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground">#{tag}</span>
          ))}
        </div>
      )}
      {post!.comments.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <h3 className="text-sm font-semibold mb-2">Comments ({post!.comments.length})</h3>
          <div className="space-y-3">
            {post!.comments.map((comment) => (
              <div key={comment.id}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{comment.author}</span>
                  <span className="text-xs text-muted-foreground">{fmt.date(comment.createdAt)}</span>
                </div>
                <p className="text-sm mt-0.5">{comment.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div
        ref={containerRef}
        className="fixed inset-0 z-50 bg-background"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={slideStyle}
      >
        {/* Back button */}
        <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b border-border/50">
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-1 px-3 py-3 text-sm text-primary hover:text-primary/80"
          >
            <ChevronLeft className="h-5 w-5" />
            Back
          </button>
        </div>

        {loading || !post ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-muted-foreground">{t('states.loading')}</div>
          </div>
        ) : (
          <>
            {/* Mobile: stacked layout */}
            <div className="md:hidden overflow-y-auto" style={{ height: "calc(100% - 49px)" }}>
              {renderMediaSection()}
              {renderTextContent()}
            </div>

            {/* Desktop: left-right layout */}
            <div className="hidden md:flex" style={{ height: "calc(100% - 49px)" }}>
              {mediaPaths.length > 0 && (
                <div className="flex-1 min-w-0 flex flex-col justify-center bg-muted/30 overflow-hidden">
                  {renderMediaSection()}
                </div>
              )}
              <div className={`overflow-y-auto ${mediaPaths.length > 0 ? "w-[380px] border-l border-border/50" : "flex-1"}`}>
                {renderTextContent()}
              </div>
            </div>
          </>
        )}

        {isSwiping && (
          <div
            className="fixed left-0 top-0 bottom-0 w-1 bg-primary/40 rounded-r"
            style={{ opacity: Math.min(swipeX / 100, 1) }}
          />
        )}
      </div>

      {/* Fullscreen image viewer */}
      {fullscreenOpen && post?.mediaType === "image" && mediaPaths.length > 0 && (
        <ImageLightbox
          images={mediaPaths.map(p => ({ src: `/raw/${p}` }))}
          initialIndex={currentImageIndex}
          onClose={() => setFullscreenOpen(false)}
        />
      )}
    </>
  );
}
