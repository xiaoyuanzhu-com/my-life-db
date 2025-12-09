import type { ComponentType } from 'react';
import type { BaseCardProps, FileContentType } from '../types';
import { ImageCard } from './image-card';
import { VideoCard } from './video-card';
import { AudioCard } from './audio-card';
import { TextCard } from './text-card';
import { PdfCard } from './pdf-card';
import { DocCard } from './doc-card';
import { PptCard } from './ppt-card';
import { FallbackCard } from './fallback-card';

const cardRegistry: Record<FileContentType, ComponentType<BaseCardProps>> = {
  image: ImageCard,
  video: VideoCard,
  audio: AudioCard,
  text: TextCard,
  pdf: PdfCard,
  doc: DocCard,
  ppt: PptCard,
  fallback: FallbackCard,
};

export function getCardComponent(contentType: FileContentType): ComponentType<BaseCardProps> {
  return cardRegistry[contentType] || FallbackCard;
}

export {
  ImageCard,
  VideoCard,
  AudioCard,
  TextCard,
  PdfCard,
  DocCard,
  PptCard,
  FallbackCard,
};
