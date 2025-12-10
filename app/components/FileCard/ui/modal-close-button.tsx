import { X } from 'lucide-react';
import { cn } from '~/lib/utils';

interface ModalCloseButtonProps {
  onClick: () => void;
  className?: string;
}

export function ModalCloseButton({ onClick, className }: ModalCloseButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'fixed top-4 right-4 z-50',
        'w-10 h-10 rounded-full border-none outline-none',
        'bg-black/50 hover:bg-black/70',
        'flex items-center justify-center',
        'text-white',
        'transition-colors',
        'touch-manipulation',
        className
      )}
      aria-label="Close"
    >
      <X className="w-5 h-5" />
    </button>
  );
}
