import { X, Circle } from 'lucide-react';
import { cn } from '~/lib/utils';
import { useTranslation } from 'react-i18next';

interface ModalCloseButtonProps {
  onClick: () => void;
  className?: string;
  isDirty?: boolean;
}

export function ModalCloseButton({ onClick, className, isDirty }: ModalCloseButtonProps) {
  const { t } = useTranslation('common');
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
      aria-label={t('actions.close')}
    >
      {isDirty ? (
        <Circle className="w-4 h-4 fill-current" />
      ) : (
        <X className="w-5 h-5" />
      )}
    </button>
  );
}
