'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Upload, X, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InputTypeTag } from './InputTypeTag';
import { detectInputType, InputType } from '@/lib/utils/inputTypeDetector';

interface OmniInputProps {
  onEntryCreated?: () => void;
}

export function OmniInput({ onEntryCreated }: OmniInputProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [detectedType, setDetectedType] = useState<InputType | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Debounced input type detection
  const performDetection = useCallback(async () => {
    if (!content.trim() && selectedFiles.length === 0) {
      setDetectedType(null);
      setIsDetecting(false);
      return;
    }

    setIsDetecting(true);

    try {
      const result = await detectInputType(content, selectedFiles);
      setDetectedType(result.type);
    } catch (err) {
      console.error('Detection error:', err);
      setDetectedType(null);
    } finally {
      setIsDetecting(false);
    }
  }, [content, selectedFiles]);

  // Effect to trigger debounced detection
  useEffect(() => {
    // Clear existing timeout
    if (detectionTimeoutRef.current) {
      clearTimeout(detectionTimeoutRef.current);
    }

    // Set new timeout for detection (300ms debounce)
    detectionTimeoutRef.current = setTimeout(() => {
      performDetection();
    }, 300);

    // Cleanup
    return () => {
      if (detectionTimeoutRef.current) {
        clearTimeout(detectionTimeoutRef.current);
      }
    };
  }, [performDetection]);

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
      setDetectedType(null);
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
          'relative rounded-xl border transition-all overflow-hidden',
          'bg-muted',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-border',
          'hover:border-primary/50 focus-within:border-primary'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Textarea with regular placeholder */}
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What's up?"
          disabled={isLoading}
          className={cn(
            'border-0 bg-transparent shadow-none text-base resize-none cursor-text',
            'focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-0',
            'placeholder:text-muted-foreground/50 min-h-[120px] px-4 pt-4 pb-2'
          )}
          aria-invalid={!!error}
        />

        {/* File chips above control bar */}
        {selectedFiles.length > 0 && (
          <div className="flex items-center gap-2 px-4 pb-2 overflow-x-auto">
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5',
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
        )}

        {/* Bottom control bar - floating buttons */}
        <div className="flex items-center justify-between px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Add file"
          >
            <Plus className="h-4 w-4" />
          </Button>

          {/* Input type tag in the middle */}
          <InputTypeTag type={detectedType} isDetecting={isDetecting} />

          <Button
            type="submit"
            disabled={isLoading}
            size="sm"
            className="h-8 cursor-pointer"
          >
            <span>Send</span>
          </Button>
        </div>

        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-xl pointer-events-none">
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
