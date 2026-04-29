package agentrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/mcp"
)

// ToolOptions tweaks the tool handlers registered by RegisterTools.
// The image generators, when nil, fall back to the production GenerateImage
// / EditImage in image.go. Tests inject mocks here.
type ToolOptions struct {
	ImageGen  func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error)
	ImageEdit func(ctx context.Context, req ImageEditRequest) (*ImageGenResult, error)
}

// imageOutputSchema is shared by generate_image and edit_image. Mirrored by
// the structuredContent field on the tool result and the [mylifedb-image]
// text-block marker. See imageToolResult.
var imageOutputSchema = map[string]any{
	"type":     "object",
	"required": []string{"op", "absPath", "relPath", "mimeType", "bytes"},
	"properties": map[string]any{
		"op":            map[string]any{"type": "string", "enum": []string{"generated", "edited"}},
		"absPath":       map[string]any{"type": "string", "description": "Absolute on-disk path to the saved PNG."},
		"relPath":       map[string]any{"type": "string", "description": "Path relative to USER_DATA_DIR, forward-slashed; usable directly in /raw/<relPath>."},
		"mimeType":      map[string]any{"type": "string", "enum": []string{"image/png"}},
		"bytes":         map[string]any{"type": "integer", "minimum": 0},
		"revisedPrompt": map[string]any{"type": "string", "description": "Empty if the model did not rephrase the prompt."},
	},
}

// RegisterTools registers the agentrunner tools (validate_agent, generate_image,
// edit_image) on the given registry. opts is optional; a nil ToolOptions uses
// production implementations.
func RegisterTools(reg *mcp.Registry, runner *Runner, opts *ToolOptions) {
	if opts == nil {
		opts = &ToolOptions{}
	}
	imageGen := opts.ImageGen
	if imageGen == nil {
		imageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
			cfg := config.Get()
			return GenerateImage(ctx, ImageGenConfig{
				BaseURL:     cfg.AgentBaseURL,
				APIKey:      cfg.AgentAPIKey,
				UserDataDir: cfg.UserDataDir,
				StorageID:   mcp.StorageIDFromContext(ctx),
			}, req)
		}
	}
	imageEdit := opts.ImageEdit
	if imageEdit == nil {
		imageEdit = func(ctx context.Context, req ImageEditRequest) (*ImageGenResult, error) {
			cfg := config.Get()
			return EditImage(ctx, ImageGenConfig{
				BaseURL:     cfg.AgentBaseURL,
				APIKey:      cfg.AgentAPIKey,
				UserDataDir: cfg.UserDataDir,
				StorageID:   mcp.StorageIDFromContext(ctx),
			}, req)
		}
	}

	reg.Register(mcp.Tool{
		Name: "validate_agent",
		Description: "Parse an agent definition's frontmatter and validate required fields without writing to disk. " +
			"Use this BEFORE writing an agent markdown file to catch syntax errors (wrong trigger type, " +
			"missing schedule on cron, missing path glob on file triggers). " +
			"`agent` and `model` are optional — when omitted, the runner falls back to the global default agent " +
			"(claude_code) and the first gateway model compatible with that agent. " +
			"Returns { valid: bool, error?: string, parsed?: { agent, model, trigger, path, schedule, enabled } } — on success, " +
			"the parsed frontmatter (with `agent` filled in to the default if omitted); on failure, a human-readable error explaining what to fix.",
		InputSchema: map[string]any{
			"type":     "object",
			"required": []string{"name", "markdown"},
			"properties": map[string]any{
				"name": map[string]any{
					"type":        "string",
					"description": "Agent folder name (kebab-case). Becomes the subfolder under agents/ and the .md filename stem.",
				},
				"markdown": map[string]any{
					"type":        "string",
					"description": "Full markdown content of the agent definition: YAML frontmatter between --- delimiters, then the prompt body.",
				},
			},
		},
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callValidateAgent(runner, args), nil
		},
	})

	reg.Register(mcp.Tool{
		Name: "generate_image",
		Description: "Generate a new image from a text prompt using gpt-image-2. " +
			"The image is saved under the current session's generated/ folder " +
			"(USER_DATA_DIR/sessions/<storage-id>/generated/) and the frontend " +
			"renders it inline in the conversation. Use this whenever the user asks for an icon, " +
			"illustration, mockup, diagram, or any visual asset — do NOT write Python/SVG code to fake " +
			"an image when this tool is available.",
		InputSchema: map[string]any{
			"type":     "object",
			"required": []string{"prompt"},
			"properties": map[string]any{
				"prompt": map[string]any{
					"type":        "string",
					"description": "Detailed description of the image. Be specific about subject, style, composition, colors.",
				},
				"size": map[string]any{
					"type":        "string",
					"enum":        []string{"1024x1024", "1536x1024", "1024x1536", "auto"},
					"default":     "1024x1024",
					"description": "Image dimensions. Use 1536x1024 for landscape, 1024x1536 for portrait.",
				},
				"quality": map[string]any{
					"type":        "string",
					"enum":        []string{"low", "medium", "high", "auto"},
					"default":     "medium",
					"description": "Higher quality costs more. Default 'medium' (~$0.05/image at 1024x1024). Use 'low' (~$0.006) for drafts; 'high' (~$0.21) only when fidelity matters.",
				},
				"background": map[string]any{
					"type":        "string",
					"enum":        []string{"transparent", "opaque", "auto"},
					"description": "Optional. Use 'transparent' for icons/logos that need a transparent background.",
				},
				"filename": map[string]any{
					"type":        "string",
					"description": "Optional. Filename hint without extension. Defaults to a slug of the prompt.",
				},
			},
		},
		OutputSchema: imageOutputSchema,
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callGenerateImage(ctx, imageGen, args), nil
		},
	})

	reg.Register(mcp.Tool{
		Name: "edit_image",
		Description: "Edit an existing image using gpt-image-2. The source image is read from disk by " +
			"absolute path. Use for changing colors, adding/removing elements, applying styles, or " +
			"inpainting (with an optional mask). Output is saved alongside generated images at " +
			"USER_DATA_DIR/sessions/<storage-id>/generated/edited-<slug>-<hash>.png and rendered inline in the conversation.",
		InputSchema: map[string]any{
			"type":     "object",
			"required": []string{"prompt", "imagePath"},
			"properties": map[string]any{
				"prompt": map[string]any{
					"type":        "string",
					"description": "Edit instruction. Describe the change you want — be specific.",
				},
				"imagePath": map[string]any{
					"type":        "string",
					"description": "Absolute path to the source image (PNG, JPEG, or WebP). Max 20 MB.",
				},
				"maskPath": map[string]any{
					"type":        "string",
					"description": "Optional absolute path to a PNG mask. Transparent pixels mark the regions to edit; opaque pixels are preserved.",
				},
				"size": map[string]any{
					"type":    "string",
					"enum":    []string{"1024x1024", "1536x1024", "1024x1536", "auto"},
					"default": "1024x1024",
				},
				"quality": map[string]any{
					"type":    "string",
					"enum":    []string{"low", "medium", "high", "auto"},
					"default": "medium",
				},
				"background": map[string]any{
					"type": "string",
					"enum": []string{"transparent", "opaque", "auto"},
				},
				"filename": map[string]any{
					"type":        "string",
					"description": "Optional. Filename hint without extension. Defaults to '<source-stem>-edited'.",
				},
			},
		},
		OutputSchema: imageOutputSchema,
		Handler: func(ctx context.Context, args map[string]any) (mcp.Result, error) {
			return callEditImage(ctx, imageEdit, args), nil
		},
	})
}

func callValidateAgent(runner *Runner, args map[string]any) mcp.Result {
	name, _ := args["name"].(string)
	markdown, _ := args["markdown"].(string)

	if name == "" {
		return mcp.JSONResult(map[string]any{
			"valid": false,
			"error": "name is required",
		})
	}
	if markdown == "" {
		return mcp.JSONResult(map[string]any{
			"valid": false,
			"error": "markdown is required",
		})
	}
	if runner == nil {
		return mcp.JSONResult(map[string]any{
			"valid": false,
			"error": "agent runner not available",
		})
	}

	def, err := runner.ValidateDef(name, []byte(markdown))
	if err != nil {
		return mcp.JSONResult(map[string]any{
			"valid": false,
			"error": err.Error(),
		})
	}

	enabled := true
	if def.Enabled != nil {
		enabled = *def.Enabled
	}
	return mcp.JSONResult(map[string]any{
		"valid": true,
		"parsed": map[string]any{
			"name":     def.Name,
			"agent":    def.Agent,
			"model":    def.Model,
			"trigger":  def.Trigger,
			"path":     def.Path,
			"schedule": def.Schedule,
			"enabled":  enabled,
		},
	})
}

func callGenerateImage(ctx context.Context, gen func(context.Context, ImageGenRequest) (*ImageGenResult, error), args map[string]any) mcp.Result {
	prompt, _ := args["prompt"].(string)
	if prompt == "" {
		return mcp.ErrorResult("prompt is required")
	}
	size, _ := args["size"].(string)
	quality, _ := args["quality"].(string)
	background, _ := args["background"].(string)
	filename, _ := args["filename"].(string)

	res, err := gen(ctx, ImageGenRequest{
		Prompt:     prompt,
		Size:       size,
		Quality:    quality,
		Background: background,
		Filename:   filename,
	})
	if err != nil {
		return mcp.ErrorResult(err.Error())
	}
	return imageToolResult("Generated", res)
}

func callEditImage(ctx context.Context, edit func(context.Context, ImageEditRequest) (*ImageGenResult, error), args map[string]any) mcp.Result {
	prompt, _ := args["prompt"].(string)
	if prompt == "" {
		return mcp.ErrorResult("prompt is required")
	}
	imagePath, _ := args["imagePath"].(string)
	if imagePath == "" {
		return mcp.ErrorResult("imagePath is required")
	}
	maskPath, _ := args["maskPath"].(string)
	size, _ := args["size"].(string)
	quality, _ := args["quality"].(string)
	background, _ := args["background"].(string)
	filename, _ := args["filename"].(string)

	res, err := edit(ctx, ImageEditRequest{
		Prompt:     prompt,
		ImagePath:  imagePath,
		MaskPath:   maskPath,
		Size:       size,
		Quality:    quality,
		Background: background,
		Filename:   filename,
	})
	if err != nil {
		return mcp.ErrorResult(err.Error())
	}
	return imageToolResult("Edited", res)
}

// imageToolResult builds the MCP tool_result for an image operation.
//
// The result carries the same structured payload in TWO places, by design:
//
//  1. `structuredContent` — the MCP 2025-06-18 native field for structured
//     tool results. Spec-aware clients read this directly. (Pre-2025-06-18
//     clients ignore unknown fields, which is harmless.)
//  2. `[mylifedb-image] <JSON>` marker line at the end of the text content
//     block. The MCP spec itself recommends this pattern even when
//     `structuredContent` is set: "For backwards compatibility, a tool that
//     returns structured content SHOULD also return the serialized JSON in a
//     TextContent block." We rely on this fallback because the agent CLI
//     (Claude Code, observed 2026-04-28) drops fields it doesn't recognize
//     when forwarding to ACP — `_meta` and `structuredContent` both vanish
//     today. Text content is the only thing that always survives.
//
// The base64 image bytes are NOT included inline — that would burn ~640K
// text tokens or ~1500 vision tokens per call. The frontend renders the
// image from disk via the existing /raw/<RelPath> endpoint.
func imageToolResult(verb string, res *ImageGenResult) mcp.Result {
	op := strings.ToLower(verb)

	structured := map[string]any{
		"op":            op,
		"absPath":       res.AbsPath,
		"relPath":       res.RelPath,
		"mimeType":      "image/png",
		"bytes":         res.Bytes,
		"revisedPrompt": res.RevisedPrompt,
	}
	marker, _ := json.Marshal(structured)

	text := fmt.Sprintf("%s image saved to %s\nRelative path (under USER_DATA_DIR): %s\nSize: %s.",
		verb, res.AbsPath, res.RelPath, formatBytes(res.Bytes))
	if res.RevisedPrompt != "" {
		text += "\nModel's revised prompt: " + res.RevisedPrompt
	}
	text += "\n\n[mylifedb-image] " + string(marker)

	return mcp.Result{
		Content:           []mcp.ContentBlock{{Type: "text", Text: text}},
		StructuredContent: structured,
	}
}

func formatBytes(n int) string {
	const kb = 1024
	const mb = 1024 * 1024
	switch {
	case n >= mb:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(mb))
	case n >= kb:
		return fmt.Sprintf("%.1f KB", float64(n)/float64(kb))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
