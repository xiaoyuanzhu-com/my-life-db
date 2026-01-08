import { useState, useMemo, useRef, useEffect } from "react";
import { X } from "lucide-react";

export interface TagOption {
  value: string;
  label: string;
  searchTerms?: string[]; // Additional terms for searching (e.g., English name for non-English labels)
}

interface MultiTagInputProps {
  options: TagOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
}

export function MultiTagInput({ options, selected, onChange, placeholder = "Search..." }: MultiTagInputProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Map values to labels
  const labelMap = useMemo(() => {
    const map = new Map<string, string>();
    options.forEach((opt) => map.set(opt.value, opt.label));
    return map;
  }, [options]);

  // Filter available options (exclude already selected)
  const availableOptions = useMemo(() => {
    return options.filter((opt) => !selected.includes(opt.value));
  }, [options, selected]);

  // Filter by search query
  const filteredOptions = useMemo(() => {
    if (!query) return availableOptions;
    const q = query.toLowerCase();
    return availableOptions.filter((opt) => {
      if (opt.value.toLowerCase().includes(q)) return true;
      if (opt.label.toLowerCase().includes(q)) return true;
      if (opt.searchTerms?.some((term) => term.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [availableOptions, query]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (value: string) => {
    onChange([...selected, value]);
    setQuery("");
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleRemove = (value: string) => {
    onChange(selected.filter((v) => v !== value));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !query && selected.length > 0) {
      // Remove last tag on backspace when input is empty
      onChange(selected.slice(0, -1));
    } else if (e.key === "Escape") {
      setIsOpen(false);
    } else if (e.key === "Enter" && filteredOptions.length > 0) {
      e.preventDefault();
      handleSelect(filteredOptions[0].value);
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === toIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newSelected = [...selected];
    const [moved] = newSelected.splice(dragIndex, 1);
    newSelected.splice(toIndex, 0, moved);
    onChange(newSelected);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="relative" ref={containerRef}>
      {/* Input container with tags */}
      <div
        className="flex flex-wrap gap-1.5 p-2 min-h-10 rounded-md border bg-background cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {/* Tags */}
        {selected.map((value, index) => (
          <div
            key={value}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            className={`flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-sm cursor-grab select-none transition-opacity ${
              dragIndex === index ? "opacity-50" : ""
            } ${dragOverIndex === index ? "ring-2 ring-primary" : ""}`}
          >
            <span>{labelMap.get(value) || value}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRemove(value);
              }}
              className="p-0.5 rounded hover:bg-background/50"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
        />
      </div>

      {/* Dropdown */}
      {isOpen && filteredOptions.length > 0 && (
        <div className="absolute z-50 w-full mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
          {filteredOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleSelect(opt.value)}
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {isOpen && query && filteredOptions.length === 0 && (
        <div className="absolute z-50 w-full mt-1 rounded-md border bg-popover shadow-md p-3 text-sm text-muted-foreground">
          No results found
        </div>
      )}
    </div>
  );
}
