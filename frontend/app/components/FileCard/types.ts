import type { FileWithDigests } from '~/types/file-card';
import type { SearchResultItem, MatchedObject } from '~/types/search';
import type { LucideIcon } from 'lucide-react';

/**
 * Content type detected from file metadata
 * Used to dispatch to appropriate card/modal components
 */
export type FileContentType =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'pdf'
  | 'doc'
  | 'ppt'
  | 'xls'
  | 'epub'
  | 'fallback';

/**
 * Base props shared by all card components
 */
export interface BaseCardProps {
  file: FileWithDigests;
  className?: string;
  priority?: boolean;
  highlightTerms?: string[];
  matchContext?: SearchResultItem['matchContext'];
  /** Matched object from image-objects for highlighting in image (images only) */
  matchedObject?: MatchedObject;
  /** Called immediately when delete is confirmed (for optimistic UI) */
  onDeleted?: () => void;
  /** Called when delete fails after optimistic removal (to restore the item) */
  onRestoreItem?: () => void;
  /** Called when user wants to locate this item in the feed (search results only) */
  onLocateInFeed?: () => void;
}

/**
 * Props for the main FileCard dispatcher
 */
export interface FileCardProps {
  file: FileWithDigests;
  className?: string;
  showTimestamp?: boolean;
  highlightTerms?: string[];
  matchContext?: SearchResultItem['matchContext'];
  /** Matched object from image-objects for highlighting in image (images only) */
  matchedObject?: MatchedObject;
  priority?: boolean;
  /** Called immediately when delete is confirmed (for optimistic UI) */
  onDeleted?: () => void;
  /** Called when delete fails after optimistic removal (to restore the item) */
  onRestoreItem?: () => void;
  /** Called when user wants to locate this item in the feed (search results only) */
  onLocateInFeed?: () => void;
}

/**
 * Navigation controls for modal navigation
 */
export interface ModalNavigationProps {
  /** Whether there's a previous file to navigate to */
  hasPrev?: boolean;
  /** Whether there's a next file to navigate to */
  hasNext?: boolean;
  /** Navigate to previous file */
  onPrev?: () => void;
  /** Navigate to next file */
  onNext?: () => void;
}

/**
 * Props for modal components
 */
export interface BaseModalProps extends ModalNavigationProps {
  file: FileWithDigests;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Context menu action definition
 */
export interface ContextMenuAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
  hidden?: boolean;
}
