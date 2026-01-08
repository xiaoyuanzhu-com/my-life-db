package log

import (
	"io"
	"os"
	"time"

	"github.com/rs/zerolog"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

var logger zerolog.Logger

func init() {
	cfg := config.Get()

	// Configure output based on environment
	var output io.Writer
	if cfg.IsDevelopment() {
		// Pretty console output for development
		output = zerolog.ConsoleWriter{
			Out:        os.Stdout,
			TimeFormat: time.Kitchen,
		}
	} else {
		// JSON output for production
		output = os.Stdout
	}

	// Set global log level
	level := zerolog.InfoLevel
	if cfg.IsDevelopment() {
		level = zerolog.DebugLevel
	}

	logger = zerolog.New(output).
		Level(level).
		With().
		Timestamp().
		Logger()
}

// Debug logs a debug message
func Debug() *zerolog.Event {
	return logger.Debug()
}

// Info logs an info message
func Info() *zerolog.Event {
	return logger.Info()
}

// Warn logs a warning message
func Warn() *zerolog.Event {
	return logger.Warn()
}

// Error logs an error message
func Error() *zerolog.Event {
	return logger.Error()
}

// Fatal logs a fatal message and exits
func Fatal() *zerolog.Event {
	return logger.Fatal()
}

// Logger returns the underlying zerolog.Logger for integrations
func Logger() zerolog.Logger {
	return logger
}
