package explore

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/mcp"
)

// RegisterTools registers the explore tools (create_post, delete_post,
// list_posts, add_comment, add_tags) on the given registry.
func RegisterTools(reg *mcp.Registry, svc *Service) {
	reg.Register(mcp.Tool{
		Name:        "create_post",
		Description: "Create a new explore post. RENDERING CONTEXT: In the feed, only the first image and the title (max 2 lines) are visible on the post card — no description, no tags, no content. Users decide whether to open a post based solely on the cover image and title. Write a short, intriguing title that sparks curiosity. The first media item is the cover image — make it visually compelling and representative of the post. Content, tags, and additional images are only shown after the user opens the post. IMAGE GUIDELINES: Most readers view posts on mobile devices. Generated images should be mobile-friendly — use large, legible text, bold visuals, high contrast, and avoid tiny details that get lost on small screens. IMAGE SIZE: The feed crops cover images into 3 aspect ratio buckets — portrait (3:4), square (1:1), or landscape (4:3) — based on the image's natural ratio. For best results use one of these sizes: 1080×1440 (3:4 portrait, recommended — takes up the most screen space), 1080×1080 (1:1 square), or 1440×1080 (4:3 landscape). Avoid extreme aspect ratios as they will be cropped significantly.",
		InputSchema: map[string]any{
			"type":     "object",
			"required": []string{"author", "title"},
			"properties": map[string]any{
				"author": map[string]any{
					"type":        "string",
					"description": "Author name for the post",
				},
				"title": map[string]any{
					"type":        "string",
					"description": "Short, intriguing title (1-2 lines max). This is the only text visible on the post card in the feed — make it count. Aim to spark curiosity so users want to open the post.",
				},
				"content": map[string]any{
					"type":        "string",
					"description": "Plain text content of the post. Markdown is not supported (only visible after user opens the post)",
				},
				"mediaType": map[string]any{
					"type":        "string",
					"enum":        []string{"image", "video"},
					"description": "Type of media attached to the post",
				},
				"media": map[string]any{
					"type":        "array",
					"description": "Media files to attach. The FIRST item becomes the cover image shown on the post card — choose the most visually striking image. Each item needs a filename and either content (base64) or path (absolute file path on server). Accepted image formats: jpg, png, gif, webp. Accepted video formats: mp4, mov, webm. SVG and other formats are NOT supported.",
					"items": map[string]any{
						"type":     "object",
						"required": []string{"filename"},
						"properties": map[string]any{
							"filename": map[string]any{
								"type":        "string",
								"description": "Filename for the media file",
							},
							"content": map[string]any{
								"type":        "string",
								"description": "Base64-encoded file content",
							},
							"path": map[string]any{
								"type":        "string",
								"description": "Absolute file path on the server (alternative to content — use this for large files)",
							},
						},
					},
				},
				"tags": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Tags to attach to the post (only visible after user opens the post)",
				},
			},
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callCreatePost(svc, args), nil
		},
	})

	reg.Register(mcp.Tool{
		Name:        "delete_post",
		Description: "Delete an explore post and its associated media files.",
		InputSchema: map[string]any{
			"type":     "object",
			"required": []string{"post_id"},
			"properties": map[string]any{
				"post_id": map[string]any{
					"type":        "string",
					"description": "ID of the post to delete",
				},
			},
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callDeletePost(svc, args), nil
		},
	})

	reg.Register(mcp.Tool{
		Name:        "list_posts",
		Description: "List explore posts in reverse-chronological order with cursor-based pagination.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cursor": map[string]any{
					"type":        "string",
					"description": "Pagination cursor to fetch older posts (returned as nextCursor from previous call)",
				},
				"limit": map[string]any{
					"type":        "integer",
					"description": "Number of posts to return (default 30, max 100)",
				},
			},
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callListPosts(args), nil
		},
	})

	reg.Register(mcp.Tool{
		Name:        "add_comment",
		Description: "Add a comment to an existing explore post.",
		InputSchema: map[string]any{
			"type":     "object",
			"required": []string{"post_id", "author", "content"},
			"properties": map[string]any{
				"post_id": map[string]any{
					"type":        "string",
					"description": "ID of the post to comment on",
				},
				"author": map[string]any{
					"type":        "string",
					"description": "Author name for the comment",
				},
				"content": map[string]any{
					"type":        "string",
					"description": "Comment text",
				},
			},
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callAddComment(svc, args), nil
		},
	})

	reg.Register(mcp.Tool{
		Name:        "add_tags",
		Description: "Add tags to an existing explore post. Tags are merged idempotently with existing tags.",
		InputSchema: map[string]any{
			"type":     "object",
			"required": []string{"post_id", "tags"},
			"properties": map[string]any{
				"post_id": map[string]any{
					"type":        "string",
					"description": "ID of the post to tag",
				},
				"tags": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Tags to add to the post",
				},
			},
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callAddTags(svc, args), nil
		},
	})
}

func callCreatePost(svc *Service, args map[string]any) mcp.Result {
	author, _ := args["author"].(string)
	title, _ := args["title"].(string)

	if author == "" || title == "" {
		return mcp.ErrorResult("Error: author and title are required")
	}

	input := CreatePostInput{
		Author: author,
		Title:  title,
	}

	if content, ok := args["content"].(string); ok {
		input.Content = &content
	}
	if mediaType, ok := args["mediaType"].(string); ok {
		input.MediaType = &mediaType
	}

	if mediaRaw, ok := args["media"].([]any); ok {
		for _, item := range mediaRaw {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			filename, _ := m["filename"].(string)
			content, _ := m["content"].(string)
			path, _ := m["path"].(string)
			if filename == "" {
				continue
			}
			if content == "" && path == "" {
				continue
			}
			input.Media = append(input.Media, MediaInput{
				Filename: filename,
				Content:  content,
				Path:     path,
			})
		}
	}

	if tagsRaw, ok := args["tags"].([]any); ok {
		for _, t := range tagsRaw {
			if s, ok := t.(string); ok {
				input.Tags = append(input.Tags, s)
			}
		}
	}

	post, err := svc.CreatePost(input)
	if err != nil {
		return mcp.ErrorResult("Error: " + err.Error())
	}
	return mcp.JSONResult(post)
}

func callDeletePost(svc *Service, args map[string]any) mcp.Result {
	postID, _ := args["post_id"].(string)
	if postID == "" {
		return mcp.ErrorResult("Error: post_id is required")
	}

	if err := svc.DeletePost(postID); err != nil {
		return mcp.ErrorResult("Error: " + err.Error())
	}
	return mcp.TextResult(fmt.Sprintf("Deleted post %s", postID))
}

func callListPosts(args map[string]any) mcp.Result {
	limit := 30
	if limitRaw, ok := args["limit"]; ok {
		switch v := limitRaw.(type) {
		case float64:
			limit = int(v)
		case string:
			if parsed, err := strconv.Atoi(v); err == nil {
				limit = parsed
			}
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	cursor, _ := args["cursor"].(string)

	var result *db.ExplorePostListResult
	var err error

	if cursor != "" {
		result, err = db.ListExplorePostsBefore(cursor, limit)
	} else {
		result, err = db.ListExplorePostsNewest(limit)
	}
	if err != nil {
		return mcp.ErrorResult("Error: " + err.Error())
	}

	resp := map[string]any{
		"posts":    result.Posts,
		"hasOlder": result.HasOlder,
		"hasNewer": result.HasNewer,
	}

	if result.HasOlder && len(result.Posts) > 0 {
		last := result.Posts[len(result.Posts)-1]
		resp["nextCursor"] = db.CreateExploreCursor(last.CreatedAt, last.ID)
	}

	data, _ := json.Marshal(resp)
	return mcp.TextResult(string(data))
}

func callAddComment(svc *Service, args map[string]any) mcp.Result {
	postID, _ := args["post_id"].(string)
	author, _ := args["author"].(string)
	content, _ := args["content"].(string)

	if postID == "" || author == "" || content == "" {
		return mcp.ErrorResult("Error: post_id, author, and content are required")
	}

	comment, err := svc.AddComment(postID, author, content)
	if err != nil {
		return mcp.ErrorResult("Error: " + err.Error())
	}
	return mcp.JSONResult(comment)
}

func callAddTags(svc *Service, args map[string]any) mcp.Result {
	postID, _ := args["post_id"].(string)
	if postID == "" {
		return mcp.ErrorResult("Error: post_id is required")
	}

	var tags []string
	if tagsRaw, ok := args["tags"].([]any); ok {
		for _, t := range tagsRaw {
			if s, ok := t.(string); ok {
				tags = append(tags, s)
			}
		}
	}
	if len(tags) == 0 {
		return mcp.ErrorResult("Error: tags array is required and must not be empty")
	}

	merged, err := svc.AddTags(postID, tags)
	if err != nil {
		return mcp.ErrorResult("Error: " + err.Error())
	}
	return mcp.JSONResult(map[string]any{"postId": postID, "tags": merged})
}
