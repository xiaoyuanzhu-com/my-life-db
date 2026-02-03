package fs

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// writeFile creates or updates a file with content
func (s *Service) writeFile(ctx context.Context, req WriteRequest) (*WriteResult, error) {
	// 1. Validate path
	if err := s.ValidatePath(req.Path); err != nil {
		return nil, err
	}

	// 2. Acquire per-file lock (allows concurrent writes to different files)
	mu := s.fileLock.acquireFileLock(req.Path)
	mu.Lock()
	defer mu.Unlock()

	// 3. Get existing record (for change detection)
	existing, _ := s.cfg.DB.GetFileByPath(req.Path)
	oldHash := ""
	if existing != nil && existing.Hash != nil {
		oldHash = *existing.Hash
	}

	// 4. Write to filesystem
	fullPath := filepath.Join(s.cfg.DataRoot, req.Path)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return nil, fmt.Errorf("failed to create parent directory: %w", err)
	}

	// Write file atomically (write to temp, then rename)
	if err := s.writeFileAtomic(fullPath, req.Content); err != nil {
		return nil, fmt.Errorf("failed to write file: %w", err)
	}

	// 5. Get file info
	info, err := os.Stat(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to stat file after write: %w", err)
	}

	// 6. Compute metadata (if requested)
	var metadata *MetadataResult
	var metadataErr error
	hashComputed := false

	if req.ComputeMetadata {
		if req.Sync {
			// Synchronous: compute now, block until done
			metadata, metadataErr = s.processor.ComputeMetadata(ctx, req.Path)
			if metadataErr != nil {
				log.Warn().
					Err(metadataErr).
					Str("path", req.Path).
					Msg("failed to compute metadata synchronously, will schedule retry")
			} else {
				hashComputed = true
			}
		} else {
			// Asynchronous: start computation in background
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				_, err := s.processor.ComputeMetadata(context.Background(), req.Path)
				if err != nil {
					log.Warn().
						Err(err).
						Str("path", req.Path).
						Msg("failed to compute metadata asynchronously")
					// TODO: Schedule retry with exponential backoff
				}
			}()
		}
	}

	// 7. Create/update database record (SINGLE upsert with all fields)
	record := s.buildFileRecord(req.Path, info, metadata)
	isNew, err := s.cfg.DB.UpsertFile(record)
	if err != nil {
		// Rollback: delete file if DB upsert failed
		os.Remove(fullPath)
		return nil, fmt.Errorf("failed to upsert file record: %w", err)
	}

	// 8. Detect content change
	newHash := ""
	if metadata != nil {
		newHash = metadata.Hash
	}
	contentChanged := (oldHash == "" && newHash != "") || (oldHash != "" && newHash != "" && oldHash != newHash)

	// 9. Notify digest service if content changed
	if contentChanged {
		log.Info().
			Str("path", req.Path).
			Str("oldHash", oldHash[:min(16, len(oldHash))]).
			Str("newHash", newHash[:min(16, len(newHash))]).
			Bool("isNew", isNew).
			Msg("file content changed, notifying digest service")

		s.notifyFileChange(FileChangeEvent{
			FilePath:       req.Path,
			IsNew:          isNew,
			ContentChanged: true,
			Trigger:        req.Source,
		})
	}

	// 10. Send notification for text preview (if computed)
	// TODO: Integrate with notifications service when available

	log.Info().
		Str("path", req.Path).
		Bool("isNew", isNew).
		Bool("hashComputed", hashComputed).
		Str("source", req.Source).
		Msg("file written successfully")

	return &WriteResult{
		Record:       record,
		IsNew:        isNew,
		HashComputed: hashComputed,
		Error:        metadataErr, // Non-fatal metadata errors
	}, nil
}

// readFile reads a file's content
func (s *Service) readFile(ctx context.Context, path string) (io.ReadCloser, error) {
	// 1. Validate path
	if err := s.ValidatePath(path); err != nil {
		return nil, err
	}

	// 2. Check file exists in database
	record, err := s.cfg.DB.GetFileByPath(path)
	if err != nil || record == nil {
		return nil, ErrFileNotFound
	}

	if record.IsFolder {
		return nil, ErrIsDirectory
	}

	// 3. Open file from filesystem
	fullPath := filepath.Join(s.cfg.DataRoot, path)
	file, err := os.Open(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrFileNotFound
		}
		return nil, err
	}

	return file, nil
}

// deleteFile removes a file from filesystem and database.
// This is the SINGLE entry point for file deletion - all callers should use this.
// Handles: filesystem, files table, digests, pins, meili_documents, qdrant_documents.
func (s *Service) deleteFile(ctx context.Context, path string) error {
	// 1. Validate path
	if err := s.ValidatePath(path); err != nil {
		return err
	}

	// 2. Acquire lock
	mu := s.fileLock.acquireFileLock(path)
	mu.Lock()
	defer mu.Unlock()

	// 3. Delete from filesystem
	fullPath := filepath.Join(s.cfg.DataRoot, path)
	if err := os.Remove(fullPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete file from filesystem: %w", err)
	}

	// 4. Cascade delete from database (files, digests, pins, meili, qdrant)
	if err := s.cfg.DB.DeleteFileWithCascade(path); err != nil {
		log.Warn().
			Err(err).
			Str("path", path).
			Msg("failed to cascade delete file from database")
		return fmt.Errorf("failed to delete file from database: %w", err)
	}

	// 5. Release lock (garbage collection)
	s.fileLock.releaseFileLock(path)

	log.Info().Str("path", path).Msg("file deleted successfully")
	return nil
}

// moveFile moves a file from src to dst.
// This is the SINGLE entry point for file moves/renames - all callers should use this.
// Handles: filesystem, files table, digests, pins, meili_documents, qdrant_documents.
func (s *Service) moveFile(ctx context.Context, src, dst string) error {
	// 1. Validate paths
	if err := s.ValidatePath(src); err != nil {
		return fmt.Errorf("invalid source path: %w", err)
	}
	if err := s.ValidatePath(dst); err != nil {
		return fmt.Errorf("invalid destination path: %w", err)
	}

	// 2. Acquire locks for both files (in order to prevent deadlocks)
	locks := s.acquireMultipleLocks(src, dst)
	defer s.releaseMultipleLocks(locks)

	// 3. Check source exists
	srcRecord, err := s.cfg.DB.GetFileByPath(src)
	if err != nil || srcRecord == nil {
		return ErrFileNotFound
	}

	// 4. Move on filesystem
	srcFullPath := filepath.Join(s.cfg.DataRoot, src)
	dstFullPath := filepath.Join(s.cfg.DataRoot, dst)

	// Ensure destination directory exists
	if err := os.MkdirAll(filepath.Dir(dstFullPath), 0755); err != nil {
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	// Try rename (fast if same filesystem)
	if err := os.Rename(srcFullPath, dstFullPath); err != nil {
		// Fallback to copy + delete (different filesystems)
		if err := s.copyFile(srcFullPath, dstFullPath); err != nil {
			return fmt.Errorf("failed to copy file: %w", err)
		}
		if err := os.Remove(srcFullPath); err != nil {
			log.Warn().Err(err).Msg("failed to remove source file after copy")
		}
	}

	// 5. Get file info at new location
	info, err := os.Stat(dstFullPath)
	if err != nil {
		return fmt.Errorf("failed to stat destination file: %w", err)
	}

	// 6. Build new record, preserving hash and text preview
	newRecord := s.buildFileRecord(dst, info, nil)
	newRecord.Hash = srcRecord.Hash
	newRecord.TextPreview = srcRecord.TextPreview

	// 7. Atomic DB update (files, digests, pins, meili, qdrant)
	if err := s.cfg.DB.MoveFileAtomic(src, dst, newRecord); err != nil {
		return fmt.Errorf("failed to update database: %w", err)
	}

	// 8. Sync external search services (Meili, Qdrant) - best effort, async
	go db.SyncSearchIndexOnMove(src, dst)

	log.Info().Str("src", src).Str("dst", dst).Msg("file moved successfully")
	return nil
}

// buildFileRecord creates a FileRecord from file info and metadata
func (s *Service) buildFileRecord(path string, info os.FileInfo, metadata *MetadataResult) *db.FileRecord {
	now := db.NowUTC()
	filename := filepath.Base(path)
	size := info.Size()

	// Auto-detect MIME type if not provided
	mimeType := utils.DetectMimeType(filename)

	record := &db.FileRecord{
		Path:          path,
		Name:          filename,
		IsFolder:      info.IsDir(),
		Size:          &size,
		MimeType:      &mimeType,
		ModifiedAt:    info.ModTime().UTC().Format(time.RFC3339),
		CreatedAt:     now,
		LastScannedAt: now,
	}

	// Add metadata if computed
	if metadata != nil {
		record.Hash = &metadata.Hash
		record.TextPreview = metadata.TextPreview
	}

	return record
}

// writeFileAtomic writes content to a file atomically (write to temp, then rename)
func (s *Service) writeFileAtomic(path string, content io.Reader) error {
	// Create temp file in same directory (ensures same filesystem for atomic rename)
	tmpFile, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()

	// Ensure temp file is cleaned up on error
	defer func() {
		if tmpFile != nil {
			tmpFile.Close()
			os.Remove(tmpPath)
		}
	}()

	// Write content to temp file
	if _, err := io.Copy(tmpFile, content); err != nil {
		return err
	}

	// Sync to ensure data is written
	if err := tmpFile.Sync(); err != nil {
		return err
	}

	// Close temp file before rename
	if err := tmpFile.Close(); err != nil {
		return err
	}

	// Atomic rename
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}

	// Success: clear defer cleanup
	tmpFile = nil
	return nil
}

// copyFile copies a file from src to dst
func (s *Service) copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}

	return dstFile.Sync()
}

// acquireMultipleLocks acquires locks for multiple paths in sorted order (prevents deadlocks)
func (s *Service) acquireMultipleLocks(paths ...string) []*sync.Mutex {
	// Sort paths to ensure consistent lock ordering
	sortedPaths := make([]string, len(paths))
	copy(sortedPaths, paths)
	sort.Strings(sortedPaths)

	locks := make([]*sync.Mutex, len(sortedPaths))
	for i, path := range sortedPaths {
		mu := s.fileLock.acquireFileLock(path)
		mu.Lock()
		locks[i] = mu
	}

	return locks
}

// releaseMultipleLocks releases multiple locks
func (s *Service) releaseMultipleLocks(locks []*sync.Mutex) {
	for i := len(locks) - 1; i >= 0; i-- {
		locks[i].Unlock()
	}
}

// min returns the minimum of two integers
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
