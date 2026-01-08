import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';

interface VideoContentProps {
  file: FileWithDigests;
}

export function VideoContent({ file }: VideoContentProps) {
  const src = getFileContentUrl(file);

  return (
    <div className="w-full h-full flex items-center justify-center bg-black">
      <video
        key={file.path}
        controls
        autoPlay
        playsInline
        className="object-contain"
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          width: 'auto',
          height: 'auto',
        }}
      >
        <source src={src} type={file.mimeType || 'video/mp4'} />
        Your browser does not support the video tag.
      </video>
    </div>
  );
}
