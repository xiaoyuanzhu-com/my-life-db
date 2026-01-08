package api

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// PersonResponse represents a person with their clusters
type PersonResponse struct {
	ID          string             `json:"id"`
	DisplayName string             `json:"displayName"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
	Clusters    []db.PersonCluster `json:"clusters,omitempty"`
}

// GetPeople handles GET /api/people
func GetPeople(c *gin.Context) {
	rows, err := db.GetDB().Query(`
		SELECT id, display_name, created_at, updated_at
		FROM people
		ORDER BY display_name
	`)
	if err != nil {
		log.Error().Err(err).Msg("failed to get people")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get people"})
		return
	}
	defer rows.Close()

	var people []PersonResponse
	for rows.Next() {
		var p PersonResponse
		if err := rows.Scan(&p.ID, &p.DisplayName, &p.CreatedAt, &p.UpdatedAt); err != nil {
			continue
		}
		people = append(people, p)
	}

	if people == nil {
		people = []PersonResponse{}
	}

	c.JSON(http.StatusOK, people)
}

// CreatePerson handles POST /api/people
func CreatePerson(c *gin.Context) {
	var body struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.DisplayName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Display name is required"})
		return
	}

	now := db.NowUTC()
	person := PersonResponse{
		ID:          uuid.New().String(),
		DisplayName: body.DisplayName,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	_, err := db.GetDB().Exec(`
		INSERT INTO people (id, display_name, created_at, updated_at)
		VALUES (?, ?, ?, ?)
	`, person.ID, person.DisplayName, person.CreatedAt, person.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create person")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create person"})
		return
	}

	c.JSON(http.StatusCreated, person)
}

// GetPerson handles GET /api/people/:id
func GetPerson(c *gin.Context) {
	id := c.Param("id")

	var p PersonResponse
	err := db.GetDB().QueryRow(`
		SELECT id, display_name, created_at, updated_at
		FROM people
		WHERE id = ?
	`, id).Scan(&p.ID, &p.DisplayName, &p.CreatedAt, &p.UpdatedAt)

	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "Person not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get person"})
		return
	}

	// Get clusters for this person
	rows, err := db.GetDB().Query(`
		SELECT id, people_id, cluster_type, sample_count, created_at, updated_at
		FROM people_clusters
		WHERE people_id = ?
	`, id)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var cluster db.PersonCluster
			var peopleID sql.NullString
			if err := rows.Scan(&cluster.ID, &peopleID, &cluster.ClusterType, &cluster.SampleCount, &cluster.CreatedAt, &cluster.UpdatedAt); err != nil {
				continue
			}
			if peopleID.Valid {
				cluster.PeopleID = &peopleID.String
			}
			p.Clusters = append(p.Clusters, cluster)
		}
	}

	c.JSON(http.StatusOK, p)
}

// UpdatePerson handles PUT /api/people/:id
func UpdatePerson(c *gin.Context) {
	id := c.Param("id")

	var body struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.DisplayName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Display name is required"})
		return
	}

	result, err := db.GetDB().Exec(`
		UPDATE people SET display_name = ?, updated_at = ? WHERE id = ?
	`, body.DisplayName, db.NowUTC(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update person"})
		return
	}

	affected, _ := result.RowsAffected()
	if affected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Person not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// DeletePerson handles DELETE /api/people/:id
func DeletePerson(c *gin.Context) {
	id := c.Param("id")

	// First unassign all clusters
	_, err := db.GetDB().Exec(`
		UPDATE people_clusters SET people_id = NULL WHERE people_id = ?
	`, id)
	if err != nil {
		log.Warn().Err(err).Msg("failed to unassign clusters")
	}

	// Delete person
	result, err := db.GetDB().Exec("DELETE FROM people WHERE id = ?", id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete person"})
		return
	}

	affected, _ := result.RowsAffected()
	if affected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Person not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// MergePeople handles POST /api/people/:id/merge
func MergePeople(c *gin.Context) {
	targetID := c.Param("id")

	var body struct {
		SourceID string `json:"sourceId"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if body.SourceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Source ID is required"})
		return
	}

	// Move all clusters from source to target
	_, err := db.GetDB().Exec(`
		UPDATE people_clusters SET people_id = ? WHERE people_id = ?
	`, targetID, body.SourceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to merge clusters"})
		return
	}

	// Delete source person
	db.GetDB().Exec("DELETE FROM people WHERE id = ?", body.SourceID)

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// AssignEmbedding handles POST /api/people/embeddings/:id/assign
func AssignEmbedding(c *gin.Context) {
	embeddingID := c.Param("id")

	var body struct {
		PersonID string `json:"personId"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// This would typically involve cluster management
	// For now, just update the cluster's person_id
	_, err := db.GetDB().Exec(`
		UPDATE people_clusters SET people_id = ?, updated_at = ?
		WHERE id = (SELECT cluster_id FROM people_embeddings WHERE id = ?)
	`, body.PersonID, db.NowUTC(), embeddingID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to assign embedding"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}

// UnassignEmbedding handles POST /api/people/embeddings/:id/unassign
func UnassignEmbedding(c *gin.Context) {
	embeddingID := c.Param("id")

	_, err := db.GetDB().Exec(`
		UPDATE people_clusters SET people_id = NULL, updated_at = ?
		WHERE id = (SELECT cluster_id FROM people_embeddings WHERE id = ?)
	`, db.NowUTC(), embeddingID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unassign embedding"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": "true"})
}
