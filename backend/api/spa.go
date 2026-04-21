package api

import (
	"html/template"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

var (
	spaTplOnce sync.Once
	spaTpl     *template.Template
	spaTplErr  error
)

func loadSpaTpl(path string) (*template.Template, error) {
	spaTplOnce.Do(func() {
		spaTpl, spaTplErr = template.ParseFiles(path)
	})
	return spaTpl, spaTplErr
}

// spaContext holds the data injected into the index.html template.
type spaContext struct {
	Lang            string
	PreloadCatalogs []string
}

// buildSPAContext resolves the locale and preload hints from the user preference
// and Accept-Language header. This is a pure function — easy to unit-test.
func buildSPAContext(userPref, acceptLang string) spaContext {
	supported := []string{"en", "zh-Hans"}
	lang := ResolveUILocale(userPref, acceptLang, supported, "en")

	// Preload the `common` namespace so the nav renders without FOUC.
	// English is the fallback bundle baked into the JS — no preload needed.
	var preload []string
	if lang != "en" {
		preload = append(preload, "/locales/"+lang+"/common.json")
	}

	return spaContext{Lang: lang, PreloadCatalogs: preload}
}

// ServeSPAIndex renders index.html with the correct <html lang> attr
// and locale-preload hints for react-i18next.
func (h *Handlers) ServeSPAIndex(c *gin.Context) {
	tpl, err := loadSpaTpl(filepath.Join("frontend", "dist", "index.html"))
	if err != nil {
		c.String(http.StatusInternalServerError, "template load error")
		return
	}

	// Read preferences_language from settings (empty string if unset).
	userPref, _ := db.GetSetting("preferences_language")

	ctx := buildSPAContext(userPref, c.GetHeader("Accept-Language"))

	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Cache-Control", "no-store") // HTML is per-user; don't cache
	_ = tpl.Execute(c.Writer, ctx)
}
