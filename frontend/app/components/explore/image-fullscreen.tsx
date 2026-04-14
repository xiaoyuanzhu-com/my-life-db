import { useState, useCallback, useRef } from "react";
import { X } from "lucide-react";

interface ImageFullscreenProps {
  images: string[];
  initialIndex: number;
  onClose: () => void;
}

export function ImageFullscreen({ images, initialIndex, onClose }: ImageFullscreenProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const goTo = useCallback((index: number) => {
    setCurrentIndex(Math.max(0, Math.min(images.length - 1, index)));
  }, [images.length]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    setDragX(dx);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current) return;
    const elapsed = Date.now() - touchStartRef.current.time;
    const velocity = Math.abs(dragX) / elapsed;

    // Swipe threshold: either distance > 50px or fast flick
    if (Math.abs(dragX) > 50 || velocity > 0.5) {
      if (dragX < 0 && currentIndex < images.length - 1) {
        goTo(currentIndex + 1);
      } else if (dragX > 0 && currentIndex > 0) {
        goTo(currentIndex - 1);
      }
    }

    setDragX(0);
    setIsDragging(false);
    touchStartRef.current = null;
  }, [dragX, currentIndex, images.length, goTo]);

  return (
    <div className="fixed inset-0 z-[60] bg-black flex flex-col">
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 bg-black/50 text-white rounded-full p-2"
      >
        <X className="h-5 w-5" />
      </button>

      {/* Counter */}
      {images.length > 1 && (
        <div className="absolute top-4 left-4 z-10 bg-black/50 text-white text-sm px-2.5 py-1 rounded-full">
          {currentIndex + 1} / {images.length}
        </div>
      )}

      {/* Image area */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          className="flex h-full w-full"
          style={{
            transform: `translateX(calc(-${currentIndex * 100}% + ${dragX}px))`,
            transition: isDragging ? "none" : "transform 0.3s ease-out",
          }}
        >
          {images.map((src, i) => (
            <div key={i} className="min-w-full h-full flex items-center justify-center">
              <img
                src={`/raw/${src}`}
                alt=""
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Dots */}
      {images.length > 1 && (
        <div className="flex justify-center gap-1.5 pb-8 pt-3">
          {images.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={`w-2 h-2 rounded-full transition-colors ${i === currentIndex ? "bg-white" : "bg-white/40"}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
