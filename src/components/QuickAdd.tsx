'use client';

import { useState, useRef } from 'react';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Upload, Send, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuickAddProps {
  onEntryCreated?: () => void;
}

export function QuickAdd({ onEntryCreated }: QuickAddProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!content.trim() && selectedFiles.length === 0) {
      setError('Please enter some content or select files');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // Create FormData to support file uploads
      const formData = new FormData();
      formData.append('content', content.trim());

      // Add files to FormData
      selectedFiles.forEach((file) => {
        formData.append('files', file);
      });

      const response = await fetch('/api/entries', {
        method: 'POST',
        body: formData, // Send as multipart/form-data
      });

      if (!response.ok) {
        throw new Error('Failed to create entry');
      }

      setContent('');
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onEntryCreated?.();
    } catch (err) {
      setError('Failed to save entry. Please try again.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setSelectedFiles(prev => [...prev, ...files]);
      setError('');
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFiles(prev => [...prev, ...Array.from(files)]);
      setError('');
    }
  }

  function removeFile(index: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div
        className={cn(
          'relative rounded-lg border-2 border-dashed transition-all min-h-[172px]',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-border bg-card',
          'hover:border-primary/50'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Show centered placeholder when empty */}
        {!content && selectedFiles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-3">
            <p className="text-lg text-muted-foreground/60 text-center">
              Type your thoughts or drag & drop files...
            </p>
          </div>
        )}

        {/* Textarea - grows to fill space, min height = 3x button height (40px * 3 = 120px) */}
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder=""
          disabled={isLoading}
          className={cn(
            'border-0 bg-transparent text-lg resize-none focus-visible:ring-0 focus-visible:ring-offset-0',
            'min-h-[120px] pb-[52px]'
          )}
          aria-invalid={!!error}
        />

        {/* Bottom row: File chips + Send button - fixed at bottom */}
        <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2">
          {/* File chips */}
          <div className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto">
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className={cn(
                  'flex items-center gap-1.5 px-3 h-10',
                  'bg-muted rounded-md text-sm whitespace-nowrap flex-shrink-0'
                )}
              >
                <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="max-w-[120px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  className="ml-1 hover:bg-background rounded-full p-0.5 transition-colors"
                  aria-label="Remove file"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Send button - text only */}
          <Button
            type="submit"
            disabled={isLoading || (!content.trim() && selectedFiles.length === 0)}
            className="h-10 flex-shrink-0"
          >
            <span>Send</span>
          </Button>
        </div>

        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-lg pointer-events-none">
            <div className="text-center">
              <Upload className="h-12 w-12 mx-auto mb-2 text-primary" />
              <p className="text-sm font-medium text-primary">Drop files here</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive mt-2">{error}</p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileSelect}
        multiple
        accept="image/*,application/pdf,.doc,.docx,.txt,.md"
      />
    </form>
  );
}
