import { useFormatter } from '~/lib/i18n/use-formatter';
import type { FileWithDigests } from '~/types/file-card';

interface FallbackContentProps {
  file: FileWithDigests;
}

export function FallbackContent({ file }: FallbackContentProps) {
  const fmt = useFormatter();
  return (
    <div className="w-full h-full rounded-lg bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] flex items-center justify-center">
      <div className="text-center space-y-2 text-sm px-6">
        <div className="break-all">{file.name}</div>
        {file.size !== null && (
          <div className="text-muted-foreground">{fmt.fileSize(file.size)}</div>
        )}
        <div className="text-muted-foreground">
          {fmt.dateTime(file.createdAt)}
        </div>
      </div>
    </div>
  );
}
