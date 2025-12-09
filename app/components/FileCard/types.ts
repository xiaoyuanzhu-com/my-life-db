import type { FileWithDigests } from '~/types/file-card';
import type { SearchResultItem } from '~/types/search';
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
  priority?: boolean;
}

/**
 * Props for modal components
 */
export interface BaseModalProps {
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
