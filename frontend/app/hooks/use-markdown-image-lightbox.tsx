/**
 * useMarkdownImageLightbox
 *
 * Attaches a delegated click handler to a markdown container so that clicking
 * any inline `<img>` opens an `ImageLightbox` with the full set of images in
 * that container. The clicked image determines the initial index, and swiping
 * navigates between all images in the document.
 *
 * Returns the lightbox React node (or null) for the consumer to render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageLightbox, type ImageLightboxImage } from "~/components/ui/image-lightbox";

interface LightboxState {
  images: ImageLightboxImage[];
  index: number;
}

export function useMarkdownImageLightbox<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T | null>(null);
  const [state, setState] = useState<LightboxState | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const img = target.closest("img");
      if (!img || !container.contains(img)) return;
      // Skip images inside anchors — those should follow their link.
      if (img.closest("a")) return;

      e.preventDefault();
      e.stopPropagation();

      const allImgs = Array.from(container.querySelectorAll("img"));
      const images: ImageLightboxImage[] = allImgs.map((el) => ({
        src: el.currentSrc || el.src,
        alt: el.alt || undefined,
      }));
      const index = Math.max(0, allImgs.indexOf(img as HTMLImageElement));
      setState({ images, index });
    };

    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, []);

  const close = useCallback(() => setState(null), []);

  const lightboxNode = state ? (
    <ImageLightbox images={state.images} initialIndex={state.index} onClose={close} />
  ) : null;

  return { containerRef, lightboxNode };
}
