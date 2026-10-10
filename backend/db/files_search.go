package db

import (
	"context"
	"fmt"
	"strings"
)

// PathSearchOptions controls filename/path search. File contents are not indexed.
type PathSearchOptions struct {
	Limit      int
	Offset     int
	TypeFilter string
	PathFilter string
}

// SearchPaths searches the existing metadata instead of maintaining a second
// copy of every file's text in FTS. Terms are literal substrings, combined AND.
func (d *DB) SearchPaths(ctx context.Context, query string, opts PathSearchOptions) ([]*FileRecord, int, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	offset := max(opts.Offset, 0)
	where := []string{"is_folder = 0"}
	args := []any{}
	// Older metadata may contain build artifacts. Do not need a mass delete
	// (which would also remove pins) just to hide these from search.
	for _, name := range []string{"target", "build", "dist", "out"} {
		where = append(where, "instr('/' || path || '/', ?) = 0")
		args = append(args, "/"+name+"/")
	}
	for _, term := range strings.Fields(query) {
		where = append(where, `path LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLikePrefix(term)+"%")
	}
	if opts.PathFilter != "" {
		where = append(where, `path LIKE ? ESCAPE '\'`)
		args = append(args, escapeLikePrefix(strings.TrimSuffix(opts.PathFilter, "/")+"/")+"%")
	}
	if opts.TypeFilter != "" {
		where = append(where, `mime_type LIKE ? ESCAPE '\'`)
		args = append(args, escapeLikePrefix(opts.TypeFilter)+"%")
	}
	filter := strings.Join(where, " AND ")
	var total int
	if err := d.conn.QueryRowContext(ctx, "SELECT count(*) FROM files WHERE "+filter, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count paths: %w", err)
	}
	pageArgs := append(append([]any{}, args...), limit, offset)
	rows, err := d.conn.QueryContext(ctx, "SELECT path FROM files WHERE "+filter+" ORDER BY path LIMIT ? OFFSET ?", pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	paths := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return nil, 0, err
		}
		paths = append(paths, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	files, err := d.GetFilesByPaths(paths)
	if err != nil {
		return nil, 0, err
	}
	result := make([]*FileRecord, 0, len(paths))
	for _, p := range paths {
		if f := files[p]; f != nil {
			result = append(result, f)
		}
	}
	return result, total, nil
}

func escapeLikePrefix(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
