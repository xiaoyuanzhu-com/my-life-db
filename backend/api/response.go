package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Standard API Response Types
// =============================================================================
//
// This file defines the unified response structure for all API endpoints.
// All endpoints should use these helpers to ensure consistent response formats.
//
// Design Principles:
// - Use proper HTTP status codes (not always 200)
// - Consistent JSON structure for success and error responses
// - Error codes for programmatic error handling
// - Pagination metadata where applicable

// -----------------------------------------------------------------------------
// Error Response Types
// -----------------------------------------------------------------------------

// ErrorCode defines standard error codes for programmatic handling
type ErrorCode string

const (
	// Client errors (4xx)
	ErrCodeBadRequest       ErrorCode = "BAD_REQUEST"        // 400 - Malformed request
	ErrCodeValidation       ErrorCode = "VALIDATION_ERROR"   // 400 - Validation failed
	ErrCodeUnauthorized     ErrorCode = "UNAUTHORIZED"       // 401 - Not authenticated
	ErrCodeForbidden        ErrorCode = "FORBIDDEN"          // 403 - Not authorized
	ErrCodeNotFound         ErrorCode = "NOT_FOUND"          // 404 - Resource not found
	ErrCodeConflict         ErrorCode = "CONFLICT"           // 409 - Resource conflict
	ErrCodeUnprocessable    ErrorCode = "UNPROCESSABLE"      // 422 - Semantic error
	ErrCodeTooManyRequests  ErrorCode = "TOO_MANY_REQUESTS"  // 429 - Rate limited

	// Server errors (5xx)
	ErrCodeInternal         ErrorCode = "INTERNAL_ERROR"     // 500 - Unexpected error
	ErrCodeServiceUnavailable ErrorCode = "SERVICE_UNAVAILABLE" // 503 - Dependency down
)

// ErrorDetail provides additional context for validation errors
type ErrorDetail struct {
	Field   string `json:"field,omitempty"`   // Field name that failed validation
	Message string `json:"message"`           // Human-readable error message
	Code    string `json:"code,omitempty"`    // Field-specific error code
}

// ErrorResponse is the standard error response structure
type ErrorResponse struct {
	Error struct {
		Code    ErrorCode     `json:"code"`              // Machine-readable error code
		Message string        `json:"message"`           // Human-readable error message
		Details []ErrorDetail `json:"details,omitempty"` // Additional error details
	} `json:"error"`
}

// -----------------------------------------------------------------------------
// Success Response Types
// -----------------------------------------------------------------------------

// DataResponse wraps a single resource or object response
// Use for: GET /resource/:id, POST /resource (created item), PUT /resource/:id
type DataResponse[T any] struct {
	Data T `json:"data"`
}

// ListResponse wraps a collection of resources with optional pagination
// Use for: GET /resources (list endpoints)
type ListResponse[T any] struct {
	Data       []T         `json:"data"`
	Pagination *Pagination `json:"pagination,omitempty"`
}

// Pagination contains pagination metadata
// Supports both cursor-based and offset-based pagination
type Pagination struct {
	// Cursor-based pagination (preferred for real-time data)
	NextCursor *string `json:"nextCursor,omitempty"` // Cursor to fetch next page
	PrevCursor *string `json:"prevCursor,omitempty"` // Cursor to fetch previous page
	HasMore    bool    `json:"hasMore"`              // Whether more results exist

	// Offset-based pagination (for search results)
	Total  *int `json:"total,omitempty"`  // Total count (if available)
	Limit  *int `json:"limit,omitempty"`  // Items per page
	Offset *int `json:"offset,omitempty"` // Current offset
}

// -----------------------------------------------------------------------------
// Response Helpers
// -----------------------------------------------------------------------------

// RespondData sends a successful response with a single data object
// Status: 200 OK
func RespondData[T any](c *gin.Context, data T) {
	c.JSON(http.StatusOK, DataResponse[T]{Data: data})
}

// RespondCreated sends a 201 Created response with the created resource
// Also sets the Location header if path is provided
func RespondCreated[T any](c *gin.Context, data T, locationPath string) {
	if locationPath != "" {
		c.Header("Location", locationPath)
	}
	c.JSON(http.StatusCreated, DataResponse[T]{Data: data})
}

// RespondList sends a successful response with a list of items
// Status: 200 OK
func RespondList[T any](c *gin.Context, data []T, pagination *Pagination) {
	// Ensure empty array instead of null
	if data == nil {
		data = []T{}
	}
	c.JSON(http.StatusOK, ListResponse[T]{Data: data, Pagination: pagination})
}

// RespondNoContent sends a 204 No Content response
// Use for: successful DELETE, PUT/PATCH with no body needed
func RespondNoContent(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

// RespondAccepted sends a 202 Accepted response for async operations
func RespondAccepted(c *gin.Context, data any) {
	c.JSON(http.StatusAccepted, DataResponse[any]{Data: data})
}

// -----------------------------------------------------------------------------
// Error Helpers
// -----------------------------------------------------------------------------

// respondError is the internal helper for error responses
func respondError(c *gin.Context, status int, code ErrorCode, message string, details []ErrorDetail) {
	resp := ErrorResponse{}
	resp.Error.Code = code
	resp.Error.Message = message
	resp.Error.Details = details
	c.JSON(status, resp)
}

// RespondBadRequest sends a 400 Bad Request error
func RespondBadRequest(c *gin.Context, message string) {
	respondError(c, http.StatusBadRequest, ErrCodeBadRequest, message, nil)
}

// RespondValidationError sends a 400 Bad Request with validation details
func RespondValidationError(c *gin.Context, message string, details []ErrorDetail) {
	respondError(c, http.StatusBadRequest, ErrCodeValidation, message, details)
}

// RespondUnauthorized sends a 401 Unauthorized error
func RespondUnauthorized(c *gin.Context, message string) {
	respondError(c, http.StatusUnauthorized, ErrCodeUnauthorized, message, nil)
}

// RespondForbidden sends a 403 Forbidden error
func RespondForbidden(c *gin.Context, message string) {
	respondError(c, http.StatusForbidden, ErrCodeForbidden, message, nil)
}

// RespondNotFound sends a 404 Not Found error
func RespondNotFound(c *gin.Context, message string) {
	respondError(c, http.StatusNotFound, ErrCodeNotFound, message, nil)
}

// RespondConflict sends a 409 Conflict error
func RespondConflict(c *gin.Context, message string) {
	respondError(c, http.StatusConflict, ErrCodeConflict, message, nil)
}

// RespondInternalError sends a 500 Internal Server Error
func RespondInternalError(c *gin.Context, message string) {
	respondError(c, http.StatusInternalServerError, ErrCodeInternal, message, nil)
}

// RespondServiceUnavailable sends a 503 Service Unavailable error
func RespondServiceUnavailable(c *gin.Context, message string) {
	respondError(c, http.StatusServiceUnavailable, ErrCodeServiceUnavailable, message, nil)
}

// -----------------------------------------------------------------------------
// Migration Helpers (for gradual adoption)
// -----------------------------------------------------------------------------

// These helpers maintain backward compatibility while transitioning to the new format.
// Mark endpoints as migrated by switching from gin.H{} to the typed helpers above.

// LegacySuccess is deprecated - use RespondData, RespondNoContent, or RespondCreated
// Kept for backward compatibility during migration
func LegacySuccess(c *gin.Context, data gin.H) {
	c.JSON(http.StatusOK, data)
}

// LegacyError is deprecated - use RespondBadRequest, RespondNotFound, etc.
// Kept for backward compatibility during migration
func LegacyError(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
}
