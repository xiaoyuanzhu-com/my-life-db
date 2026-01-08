package api

import (
	"net/http"
	"runtime"

	"github.com/labstack/echo/v4"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/db"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/notifications"
)

var statsLogger = log.GetLogger("ApiStats")

// GetStats handles GET /api/stats
func GetStats(c echo.Context) error {
	stats := make(map[string]interface{})

	// File stats
	fileStats, err := db.GetFileStats()
	if err != nil {
		statsLogger.Error().Err(err).Msg("failed to get file stats")
		fileStats = make(map[string]interface{})
	}
	stats["files"] = fileStats

	// Digest stats
	digestStats, err := db.GetDigestStats()
	if err != nil {
		statsLogger.Error().Err(err).Msg("failed to get digest stats")
		digestStats = make(map[string]interface{})
	}
	stats["digests"] = digestStats

	// Pin count
	pinCount, _ := db.CountPins()
	stats["pins"] = pinCount

	// System stats
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	stats["system"] = map[string]interface{}{
		"goVersion":    runtime.Version(),
		"numGoroutine": runtime.NumGoroutine(),
		"numCPU":       runtime.NumCPU(),
		"memAlloc":     memStats.Alloc,
		"memSys":       memStats.Sys,
	}

	// Notification subscribers
	stats["notificationSubscribers"] = notifications.GetService().SubscriberCount()

	return c.JSON(http.StatusOK, stats)
}
