package log

import (
	"io"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

var (
	// Global logger
	logger zerolog.Logger
	// Debug modules (enabled via DEBUG env var)
	debugModules map[string]bool
)

func init() {
	// Parse debug modules from environment
	debugModules = make(map[string]bool)
	cfg := config.Get()
	if cfg.DebugModules != "" {
		for _, module := range strings.Split(cfg.DebugModules, ",") {
			debugModules[strings.TrimSpace(module)] = true
		}
	}

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

// Logger represents a module-specific logger
type Logger struct {
	logger       zerolog.Logger
	module       string
	debugEnabled bool
}

// GetLogger returns a logger for a specific module
func GetLogger(module string) *Logger {
	// Check if this module has debug logging enabled
	debugEnabled := debugModules[module]

	return &Logger{
		logger:       logger.With().Str("module", module).Logger(),
		module:       module,
		debugEnabled: debugEnabled,
	}
}

// Debug logs a debug message (only if module debug is enabled)
func (l *Logger) Debug() *zerolog.Event {
	if l.debugEnabled {
		return l.logger.Debug()
	}
	// Return a disabled event (won't output anything)
	return l.logger.Debug().Discard()
}

// Info logs an info message
func (l *Logger) Info() *zerolog.Event {
	return l.logger.Info()
}

// Warn logs a warning message
func (l *Logger) Warn() *zerolog.Event {
	return l.logger.Warn()
}

// Error logs an error message
func (l *Logger) Error() *zerolog.Event {
	return l.logger.Error()
}

// Fatal logs a fatal message and exits
func (l *Logger) Fatal() *zerolog.Event {
	return l.logger.Fatal()
}

// WithError adds an error to the log event
func (l *Logger) WithError(err error) *zerolog.Event {
	return l.logger.Error().Err(err)
}
