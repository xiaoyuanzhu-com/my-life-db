package db

import (
	"database/sql"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

// QueryParam represents a parameter for database queries
type QueryParam interface{}

var shouldLogQueries bool

func init() {
	cfg := config.Get()
	shouldLogQueries = cfg.DBLogQueries
}

func logQuery(kind string, sql string, params []QueryParam) {
	if !shouldLogQueries {
		return
	}
	logger.Debug().
		Str("kind", kind).
		Str("sql", sql).
		Interface("params", params).
		Msg("db query")
}

// Select runs a SELECT query returning multiple rows
// The scanner function is called for each row to map results
func Select[T any](query string, params []QueryParam, scanner func(*sql.Rows) (T, error)) ([]T, error) {
	logQuery("select", query, params)

	db := GetDB()

	// Convert params to interface slice
	args := make([]interface{}, len(params))
	for i, p := range params {
		args[i] = p
	}

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []T
	for rows.Next() {
		item, err := scanner(rows)
		if err != nil {
			return nil, err
		}
		results = append(results, item)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return results, nil
}

// SelectOne runs a SELECT query returning a single row (or nil if not found)
func SelectOne[T any](query string, params []QueryParam, scanner func(*sql.Row) (T, error)) (*T, error) {
	logQuery("get", query, params)

	db := GetDB()

	// Convert params to interface slice
	args := make([]interface{}, len(params))
	for i, p := range params {
		args[i] = p
	}

	row := db.QueryRow(query, args...)
	result, err := scanner(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return &result, nil
}

// Run executes an INSERT/UPDATE/DELETE query
func Run(query string, params ...QueryParam) (sql.Result, error) {
	logQuery("run", query, params)

	db := GetDB()

	// Convert params to interface slice
	args := make([]interface{}, len(params))
	for i, p := range params {
		args[i] = p
	}

	return db.Exec(query, args...)
}

// RunResult represents the result of a Run operation
type RunResult struct {
	LastInsertID int64
	RowsAffected int64
}

// RunWithResult executes a query and returns simplified result
func RunWithResult(query string, params ...QueryParam) (*RunResult, error) {
	result, err := Run(query, params...)
	if err != nil {
		return nil, err
	}

	lastID, _ := result.LastInsertId()
	affected, _ := result.RowsAffected()

	return &RunResult{
		LastInsertID: lastID,
		RowsAffected: affected,
	}, nil
}

// Exists checks if a row exists matching the query
func Exists(query string, params ...QueryParam) (bool, error) {
	logQuery("exists", query, params)

	db := GetDB()

	// Convert params to interface slice
	args := make([]interface{}, len(params))
	for i, p := range params {
		args[i] = p
	}

	var exists bool
	err := db.QueryRow("SELECT EXISTS("+query+")", args...).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

// Count returns the count of rows matching the query
func Count(query string, params ...QueryParam) (int64, error) {
	logQuery("count", query, params)

	db := GetDB()

	// Convert params to interface slice
	args := make([]interface{}, len(params))
	for i, p := range params {
		args[i] = p
	}

	var count int64
	err := db.QueryRow(query, args...).Scan(&count)
	if err != nil {
		return 0, err
	}

	return count, nil
}
