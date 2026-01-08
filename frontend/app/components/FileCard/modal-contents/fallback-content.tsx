import type { FileWithDigests } from '~/types/file-card';

interface FallbackContentProps {
  file: FileWithDigests;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function FallbackContent({ file }: FallbackContentProps) {
  return (
    <div className="w-full h-full rounded-lg bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] flex items-center justify-center">
      <div className="text-center space-y-2 text-sm px-6">
        <div className="break-all">{file.name}</div>
        {file.size !== null && (
          <div className="text-muted-foreground">{formatFileSize(file.size)}</div>
        )}
        <div className="text-muted-foreground">
          {new Date(file.createdAt).toLocaleString()}
        </div>
      </div>
    </div>
  );
}
