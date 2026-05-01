import type { ComponentType } from 'react';
import type { BaseCardProps, FileContentType } from '../types';
import { ImageCard } from './image-card';
import { VideoCard } from './video-card';
import { AudioCard } from './audio-card';
import { TextCard } from './text-card';
import { PdfCard } from './pdf-card';
import { DocCard } from './doc-card';
import { PptCard } from './ppt-card';
import { XlsCard } from './xls-card';
import { EpubCard } from './epub-card';
import { FallbackCard } from './fallback-card';

const cardRegistry: Record<FileContentType, ComponentType<BaseCardProps>> = {
  image: ImageCard,
  video: VideoCard,
  audio: AudioCard,
  text: TextCard,
  // Markdown and HTML files use the same card layout as text files;
  // the richer preview only kicks in when the modal opens them.
  markdown: TextCard,
  html: TextCard,
  pdf: PdfCard,
  doc: DocCard,
  ppt: PptCard,
  xls: XlsCard,
  epub: EpubCard,
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
  XlsCard,
  EpubCard,
  FallbackCard,
};
