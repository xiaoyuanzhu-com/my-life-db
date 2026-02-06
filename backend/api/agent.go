package api

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetFileIntention handles GET /api/files/:path/intention
// Returns the agent's analysis of a file's intention
func (h *Handlers) GetFileIntention(c *gin.Context) {
	// Get file path from query parameter
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File path is required"})
		return
	}

	// Query intention from database
	query := `
		SELECT id, file_path, conversation_id, intention_type, intention_details, confidence, suggested_folder, reasoning, created_at, updated_at
		FROM file_intentions
		WHERE file_path = ?
	`

	row := h.server.DB().Conn().QueryRow(query, path)

	type Intention struct {
		ID               string  `json:"id"`
		FilePath         string  `json:"file_path"`
		ConversationID   string  `json:"conversation_id,omitempty"`
		IntentionType    string  `json:"intention_type"`
		IntentionDetails string  `json:"intention_details,omitempty"`
		Confidence       float64 `json:"confidence"`
		SuggestedFolder  string  `json:"suggested_folder,omitempty"`
		Reasoning        string  `json:"reasoning,omitempty"`
		CreatedAt        string  `json:"created_at"`
		UpdatedAt        string  `json:"updated_at"`
	}

	var i Intention
	var conversationID, intentionDetails, suggestedFolder, reasoning *string

	err := row.Scan(
		&i.ID,
		&i.FilePath,
		&conversationID,
		&i.IntentionType,
		&intentionDetails,
		&i.Confidence,
		&suggestedFolder,
		&reasoning,
		&i.CreatedAt,
		&i.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "No intention found for this file"})
		return
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if conversationID != nil {
		i.ConversationID = *conversationID
	}
	if intentionDetails != nil {
		i.IntentionDetails = *intentionDetails
	}
	if suggestedFolder != nil {
		i.SuggestedFolder = *suggestedFolder
	}
	if reasoning != nil {
		i.Reasoning = *reasoning
	}

	c.JSON(http.StatusOK, i)
}

// GetInboxIntentions handles GET /api/inbox/intentions
// Returns all file intentions for inbox files
func (h *Handlers) GetInboxIntentions(c *gin.Context) {
	// Query all intentions for inbox files
	query := `
		SELECT id, file_path, conversation_id, intention_type, intention_details, confidence, suggested_folder, reasoning, created_at, updated_at
		FROM file_intentions
		WHERE file_path LIKE 'inbox/%'
		ORDER BY created_at DESC
	`

	rows, err := h.server.DB().Conn().Query(query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type Intention struct {
		ID               string  `json:"id"`
		FilePath         string  `json:"file_path"`
		ConversationID   string  `json:"conversation_id,omitempty"`
		IntentionType    string  `json:"intention_type"`
		IntentionDetails string  `json:"intention_details,omitempty"`
		Confidence       float64 `json:"confidence"`
		SuggestedFolder  string  `json:"suggested_folder,omitempty"`
		Reasoning        string  `json:"reasoning,omitempty"`
		CreatedAt        string  `json:"created_at"`
		UpdatedAt        string  `json:"updated_at"`
	}

	var intentions []Intention
	for rows.Next() {
		var i Intention
		var conversationID, intentionDetails, suggestedFolder, reasoning *string

		err := rows.Scan(
			&i.ID,
			&i.FilePath,
			&conversationID,
			&i.IntentionType,
			&intentionDetails,
			&i.Confidence,
			&suggestedFolder,
			&reasoning,
			&i.CreatedAt,
			&i.UpdatedAt,
		)
		if err != nil {
			continue
		}

		if conversationID != nil {
			i.ConversationID = *conversationID
		}
		if intentionDetails != nil {
			i.IntentionDetails = *intentionDetails
		}
		if suggestedFolder != nil {
			i.SuggestedFolder = *suggestedFolder
		}
		if reasoning != nil {
			i.Reasoning = *reasoning
		}

		intentions = append(intentions, i)
	}

	if intentions == nil {
		intentions = []Intention{}
	}

	c.JSON(http.StatusOK, gin.H{
		"intentions": intentions,
		"total":      len(intentions),
	})
}
