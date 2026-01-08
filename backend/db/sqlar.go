package db

import (
	"bytes"
	"compress/zlib"
	"io"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SqlarStore stores a file in SQLAR format with zlib compression
func SqlarStore(name string, data []byte, mode int) bool {
	if mode == 0 {
		mode = 0644
	}

	// Compress data using zlib
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	_, err := writer.Write(data)
	if err != nil {
		log.Error().Err(err).Str("name", name).Msg("failed to compress data")
		return false
	}
	writer.Close()

	mtime := time.Now().Unix()
	originalSize := len(data)

	db := GetDB()
	_, err = db.Exec(`
		INSERT OR REPLACE INTO sqlar (name, mode, mtime, sz, data)
		VALUES (?, ?, ?, ?, ?)
	`, name, mode, mtime, originalSize, compressed.Bytes())

	if err != nil {
		log.Error().Err(err).Str("name", name).Msg("failed to store file in sqlar")
		return false
	}

	log.Debug().
		Str("name", name).
		Int("originalSize", originalSize).
		Int("compressedSize", compressed.Len()).
		Msg("stored file in sqlar")
	return true
}

// SqlarGet retrieves and decompresses a file from SQLAR
func SqlarGet(name string) []byte {
	db := GetDB()

	var compressedData []byte
	var sz int
	err := db.QueryRow("SELECT data, sz FROM sqlar WHERE name = ?", name).Scan(&compressedData, &sz)
	if err != nil {
		log.Debug().Str("name", name).Msg("file not found in sqlar")
		return nil
	}

	// Decompress using zlib
	reader, err := zlib.NewReader(bytes.NewReader(compressedData))
	if err != nil {
		log.Error().Err(err).Str("name", name).Msg("failed to create zlib reader")
		return nil
	}
	defer reader.Close()

	decompressed, err := io.ReadAll(reader)
	if err != nil {
		log.Error().Err(err).Str("name", name).Msg("failed to decompress data")
		return nil
	}

	log.Debug().Str("name", name).Int("size", sz).Msg("retrieved file from sqlar")
	return decompressed
}

// SqlarExists checks if a file exists in SQLAR
func SqlarExists(name string) bool {
	db := GetDB()

	var exists int
	err := db.QueryRow("SELECT 1 FROM sqlar WHERE name = ? LIMIT 1", name).Scan(&exists)
	return err == nil
}

// SqlarDelete removes a file from SQLAR
func SqlarDelete(name string) bool {
	db := GetDB()

	result, err := db.Exec("DELETE FROM sqlar WHERE name = ?", name)
	if err != nil {
		log.Error().Err(err).Str("name", name).Msg("failed to delete file from sqlar")
		return false
	}

	changes, _ := result.RowsAffected()
	log.Debug().Str("name", name).Int64("changes", changes).Msg("deleted file from sqlar")
	return changes > 0
}

// SqlarFileInfo represents metadata about a file in SQLAR
type SqlarFileInfo struct {
	Name  string
	Size  int
	Mtime int64
}

// SqlarList lists all files in SQLAR with a given prefix
func SqlarList(prefix string) []SqlarFileInfo {
	db := GetDB()

	rows, err := db.Query(`
		SELECT name, sz as size, mtime
		FROM sqlar
		WHERE name LIKE ?
		ORDER BY name
	`, prefix+"%")
	if err != nil {
		log.Error().Err(err).Str("prefix", prefix).Msg("failed to list files in sqlar")
		return nil
	}
	defer rows.Close()

	var files []SqlarFileInfo
	for rows.Next() {
		var info SqlarFileInfo
		if err := rows.Scan(&info.Name, &info.Size, &info.Mtime); err == nil {
			files = append(files, info)
		}
	}

	log.Debug().Str("prefix", prefix).Int("count", len(files)).Msg("listed files in sqlar")
	return files
}

// SqlarDeletePrefix deletes all files with a given prefix
func SqlarDeletePrefix(prefix string) int {
	db := GetDB()

	result, err := db.Exec("DELETE FROM sqlar WHERE name LIKE ?", prefix+"%")
	if err != nil {
		log.Error().Err(err).Str("prefix", prefix).Msg("failed to delete files by prefix from sqlar")
		return 0
	}

	changes, _ := result.RowsAffected()
	log.Debug().Str("prefix", prefix).Int64("changes", changes).Msg("deleted files by prefix from sqlar")
	return int(changes)
}

// SqlarMetadata represents full metadata about a file in SQLAR
type SqlarMetadata struct {
	Name  string
	Mode  int
	Mtime int64
	Size  int
}

// SqlarGetMetadata gets file metadata without decompressing
func SqlarGetMetadata(name string) *SqlarMetadata {
	db := GetDB()

	var meta SqlarMetadata
	err := db.QueryRow(`
		SELECT name, mode, mtime, sz as size
		FROM sqlar
		WHERE name = ?
	`, name).Scan(&meta.Name, &meta.Mode, &meta.Mtime, &meta.Size)

	if err != nil {
		return nil
	}

	return &meta
}
