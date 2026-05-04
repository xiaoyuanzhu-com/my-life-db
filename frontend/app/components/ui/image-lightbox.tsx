import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

interface ImageLightboxImage {
  src: string;
  alt?: string;
}

interface ImageLightboxProps {
  images: ImageLightboxImage[];
  initialIndex: number;
  onClose: () => void;
}

export function ImageLightbox({ images, initialIndex, onClose }: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const pointerStartRef = useRef<{ x: number; time: number } | null>(null);

  const hasMultiple = images.length > 1;

  const goTo = useCallback(
    (index: number) => {
      setCurrentIndex(Math.max(0, Math.min(images.length - 1, index)));
    },
    [images.length],
  );

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Keyboard navigation (capture phase to work inside Radix Dialog)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft" && hasMultiple) {
        e.stopPropagation();
        goTo(currentIndex - 1);
      } else if (e.key === "ArrowRight" && hasMultiple) {
        e.stopPropagation();
        goTo(currentIndex + 1);
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, goTo, currentIndex, hasMultiple]);

  // Pointer event handlers (unified touch + mouse)
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      pointerStartRef.current = { x: e.clientX, time: Date.now() };
      setDragX(0);
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pointerStartRef.current || !isDragging) return;
      setDragX(e.clientX - pointerStartRef.current.x);
    },
    [isDragging],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!pointerStartRef.current) return;
      const elapsed = Date.now() - pointerStartRef.current.time;
      const velocity = Math.abs(dragX) / elapsed;

      if (Math.abs(dragX) > 80 || velocity > 0.4) {
        if (dragX < 0 && currentIndex < images.length - 1) {
          goTo(currentIndex + 1);
        } else if (dragX > 0 && currentIndex > 0) {
          goTo(currentIndex - 1);
        }
      }

      setDragX(0);
      setIsDragging(false);
      pointerStartRef.current = null;
    },
    [dragX, currentIndex, images.length, goTo],
  );

  return createPortal(
    <div className="fixed inset-0 z-[70] bg-black flex flex-col select-none">
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 bg-black/50 text-white rounded-full p-2 hover:bg-black/70 transition-colors"
      >
        <X className="h-5 w-5" />
      </button>

      {/* Counter */}
      {hasMultiple && (
        <div className="absolute top-4 left-4 z-10 bg-black/50 text-white text-sm px-2.5 py-1 rounded-full">
          {currentIndex + 1} / {images.length}
        </div>
      )}

      {/* Desktop chevron arrows */}
      {hasMultiple && (
        <>
          {currentIndex > 0 && (
            <button
              onClick={() => goTo(currentIndex - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-10 bg-black/50 text-white rounded-full p-1.5 hidden md:flex hover:bg-black/70 transition-colors"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {currentIndex < images.length - 1 && (
            <button
              onClick={() => goTo(currentIndex + 1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 z-10 bg-black/50 text-white rounded-full p-1.5 hidden md:flex hover:bg-black/70 transition-colors"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </>
      )}

      {/* Image strip */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className="flex h-full w-full"
          style={{
            transform: `translateX(calc(-${currentIndex * 100}% + ${dragX}px))`,
            transition: isDragging ? "none" : "transform 0.3s ease-out",
          }}
        >
          {images.map((img, i) => (
            <div key={i} className="min-w-full h-full flex items-center justify-center">
              <img
                src={img.src}
                alt={img.alt ?? ""}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Dots */}
      {hasMultiple && (
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
    </div>,
    document.body,
  );
}

export type { ImageLightboxImage };
