import type { ComponentType } from 'react';
import type { BaseModalProps, FileContentType } from '../types';
import { ImageModal } from './image-modal';
import { VideoModal } from './video-modal';
import { AudioModal } from './audio-modal';
import { FallbackModal } from './fallback-modal';
import { TextModal } from './text-modal';

const modalRegistry: Partial<Record<FileContentType, ComponentType<BaseModalProps>>> = {
  image: ImageModal,
  video: VideoModal,
  audio: AudioModal,
};

export function getModalComponent(contentType: FileContentType): ComponentType<BaseModalProps> | null {
  return modalRegistry[contentType] || null;
}

export {
  ImageModal,
  VideoModal,
  AudioModal,
  FallbackModal,
  TextModal,
};
