import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { api, encodePath } from "~/lib/api";

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface QuickNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (savedPath: string) => void;
}

export function QuickNoteDialog({ open, onOpenChange, onSaved }: QuickNoteDialogProps) {
  const { t } = useTranslation('data');
  const { t: tc } = useTranslation('common');
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setContent("");
      // autoFocus on Radix dialog content sometimes loses race; re-focus after mount
      const id = window.setTimeout(() => textareaRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const handleSend = async () => {
    const trimmed = content.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const filename = `note-${todayLocal()}.txt`;
      const url = `/api/data/uploads/simple/${encodePath(filename)}`;
      const res = await api.fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: content,
      });
      if (!res.ok) {
        toast.error(t('quickNote.saveFailed', 'Failed to save note'));
        return;
      }
      const data = (await res.json()) as { path?: string };
      const savedPath = data.path ?? filename;
      toast.success(t('quickNote.saved', 'Saved to {{path}}', { path: savedPath }));
      onOpenChange(false);
      onSaved?.(savedPath);
    } catch {
      toast.error(t('quickNote.saveFailed', 'Failed to save note'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[calc(100%-1rem)] sm:max-w-2xl md:max-w-3xl gap-3 p-4 sm:p-5"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          // Delegate focus to the textarea (Radix focuses the first focusable
          // element by default, which can flicker when there's a button group).
          e.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('quickNote.title', 'Quick note')}</DialogTitle>
        </DialogHeader>
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('quickNote.placeholder', 'Quick note...')}
          disabled={saving}
          className="min-h-[60vh] resize-none border-0 shadow-none focus-visible:ring-0 focus-visible:border-transparent px-0 py-0 text-base"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {tc('actions.cancel')}
          </Button>
          <Button onClick={handleSend} disabled={!content.trim() || saving}>
            {saving
              ? t('quickNote.sending', 'Sending...')
              : t('quickNote.send', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
