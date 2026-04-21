import type { SimpleIcon } from 'simple-icons';
import {
  siX,
  siTelegram,
  siWechat,
  siGoogledrive,
  siNotion,
  siObsidian,
  siApple,
} from 'simple-icons';
import type { App } from '~/types/apps';
import { cn } from '~/lib/utils';

const SLUG_TO_ICON: Record<string, SimpleIcon> = {
  x: siX,
  telegram: siTelegram,
  wechat: siWechat,
  googledrive: siGoogledrive,
  notion: siNotion,
  obsidian: siObsidian,
  apple: siApple,
};

interface Props {
  app: App;
  onClick: () => void;
}

export function AppCard({ app, onClick }: Props) {
  const slug = app.icon ?? app.id;
  const icon = SLUG_TO_ICON[slug];

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-2 p-4 rounded-lg',
        'hover:bg-muted/50 transition-colors text-left'
      )}
      title={app.description}
    >
      <div className="h-12 w-12 flex items-center justify-center">
        {icon ? (
          <svg
            className="h-10 w-10"
            role="img"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-label={app.name}
          >
            <path d={icon.path} />
          </svg>
        ) : (
          <span className="text-lg font-semibold text-muted-foreground">
            {app.name[0]}
          </span>
        )}
      </div>
      <div className="text-sm font-medium truncate max-w-full">{app.name}</div>
      <div className="text-xs text-muted-foreground capitalize">
        {app.category}
      </div>
    </button>
  );
}
