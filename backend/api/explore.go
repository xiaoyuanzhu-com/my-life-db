package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ExplorePostsResponse is the paginated list response for explore posts.
type ExplorePostsResponse struct {
	Items   []db.ExplorePost `json:"items"`
	Cursors struct {
		First *string `json:"first"`
		Last  *string `json:"last"`
	} `json:"cursors"`
	HasMore struct {
		Older bool `json:"older"`
		Newer bool `json:"newer"`
	} `json:"hasMore"`
}

// GetExplorePosts handles GET /api/explore/posts
func (h *Handlers) GetExplorePosts(c *gin.Context) {
	limitStr := c.Query("limit")
	before := c.Query("before")
	after := c.Query("after")

	limit := 30
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	var result *db.ExplorePostListResult
	var err error

	if before != "" {
		_, _, parseErr := db.ParseExploreCursor(before)
		if parseErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid before cursor format"})
			return
		}
		result, err = db.ListExplorePostsBefore(before, limit)
	} else if after != "" {
		_, _, parseErr := db.ParseExploreCursor(after)
		if parseErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid after cursor format"})
			return
		}
		result, err = db.ListExplorePostsAfter(after, limit)
	} else {
		result, err = db.ListExplorePostsNewest(limit)
	}

	if err != nil {
		log.Error().Err(err).Msg("list explore posts failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list explore posts"})
		return
	}

	response := ExplorePostsResponse{
		Items: result.Posts,
		HasMore: struct {
			Older bool `json:"older"`
			Newer bool `json:"newer"`
		}{
			Older: result.HasOlder,
			Newer: result.HasNewer,
		},
	}

	if len(result.Posts) > 0 {
		first := db.CreateExploreCursor(result.Posts[0].CreatedAt, result.Posts[0].ID)
		last := db.CreateExploreCursor(result.Posts[len(result.Posts)-1].CreatedAt, result.Posts[len(result.Posts)-1].ID)
		response.Cursors.First = &first
		response.Cursors.Last = &last
	}

	c.JSON(http.StatusOK, response)
}

// GetExplorePost handles GET /api/explore/posts/:id
func (h *Handlers) GetExplorePost(c *gin.Context) {
	id := c.Param("id")

	post, err := db.GetExplorePost(id)
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("get explore post failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get explore post"})
		return
	}
	if post == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Post not found"})
		return
	}

	c.JSON(http.StatusOK, post)
}

// GetExploreComments handles GET /api/explore/posts/:id/comments
func (h *Handlers) GetExploreComments(c *gin.Context) {
	postID := c.Param("id")

	comments, err := db.ListExploreComments(postID)
	if err != nil {
		log.Error().Err(err).Str("postId", postID).Msg("list explore comments failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list comments"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"comments": comments})
}

// DeleteExplorePost handles DELETE /api/explore/posts/:id
func (h *Handlers) DeleteExplorePost(c *gin.Context) {
	id := c.Param("id")

	if err := h.server.Explore().DeletePost(id); err != nil {
		log.Error().Err(err).Str("id", id).Msg("delete explore post failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
