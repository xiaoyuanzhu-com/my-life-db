package log

import (
	"io"
	stdlog "log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

var (
	logger     zerolog.Logger
	loggerLock sync.RWMutex
)

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

	// Set default log level (will be overridden by settings later)
	level := zerolog.InfoLevel

	logger = zerolog.New(output).
		Level(level).
		With().
		Timestamp().
		Logger()
}

// SetLevel sets the global log level at runtime
func SetLevel(levelStr string) {
	level := parseLogLevel(levelStr)
	loggerLock.Lock()
	logger = logger.Level(level)
	loggerLock.Unlock()
}

// parseLogLevel converts a string log level to zerolog.Level
func parseLogLevel(levelStr string) zerolog.Level {
	switch strings.ToLower(levelStr) {
	case "debug":
		return zerolog.DebugLevel
	case "info":
		return zerolog.InfoLevel
	case "warn", "warning":
		return zerolog.WarnLevel
	case "error":
		return zerolog.ErrorLevel
	case "fatal":
		return zerolog.FatalLevel
	default:
		return zerolog.InfoLevel
	}
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

// StdLogger returns a standard library *log.Logger that writes to zerolog at the specified level.
// Useful for passing to http.Server.ErrorLog and other stdlib integrations.
func StdLogger(level zerolog.Level) *stdlog.Logger {
	return stdlog.New(logger.Level(level), "", 0)
}

// zerologWriter wraps a zerolog.Logger to implement io.Writer
type zerologWriter struct {
	logger zerolog.Logger
}

func (w zerologWriter) Write(p []byte) (n int, err error) {
	// Trim trailing newline that stdlib log adds
	msg := strings.TrimSuffix(string(p), "\n")
	w.logger.Warn().Msg(msg)
	return len(p), nil
}

// StdErrorLogger returns a standard library *log.Logger that writes to zerolog.
// Useful for passing to http.Server.ErrorLog.
func StdErrorLogger() *stdlog.Logger {
	return stdlog.New(zerologWriter{logger: logger}, "", 0)
}
