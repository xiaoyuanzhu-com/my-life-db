import { InputType } from '~/lib/utils/input-type-detector';
import { Loader2, FileText, Link, Image, Music, Video, FileIcon, Layers } from 'lucide-react';
import { cn } from '~/lib/utils';

interface InputTypeTagProps {
  type: InputType | null;
  isDetecting: boolean;
}

const typeConfig = {
  text: { icon: FileText, label: 'Text', color: 'text-blue-500' },
  url: { icon: Link, label: 'URL', color: 'text-purple-500' },
  image: { icon: Image, label: 'Image', color: 'text-green-500' },
  audio: { icon: Music, label: 'Audio', color: 'text-orange-500' },
  video: { icon: Video, label: 'Video', color: 'text-red-500' },
  pdf: { icon: FileIcon, label: 'PDF', color: 'text-rose-500' },
  file: { icon: FileIcon, label: 'File', color: 'text-gray-500' },
  any: { icon: Layers, label: 'Mixed', color: 'text-cyan-500' },
};

export function InputTypeTag({ type, isDetecting }: InputTypeTagProps) {
  // Hide when empty and not detecting
  if (!type && !isDetecting) {
    return null;
  }

  if (isDetecting) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Detecting...</span>
      </div>
    );
  }

  if (!type) {
    return null;
  }

  const config = typeConfig[type];
  const Icon = config.icon;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
      <Icon className={cn('h-3.5 w-3.5', config.color)} />
      <span className={cn('text-xs font-medium', config.color)}>
        {config.label}
      </span>
    </div>
  );
}
