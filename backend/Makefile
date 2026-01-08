.PHONY: all build build-server build-frontend dev clean test lint help

# Default target
all: build

# Build everything (frontend + server)
build: build-frontend build-server

# Build Go server
build-server:
	@echo "Building Go server..."
	CGO_ENABLED=1 go build -o ../bin/server .

# Build frontend (calls npm in frontend directory)
build-frontend:
	@echo "Building frontend..."
	cd ../frontend && npm run build:client

# Development mode - run server with hot reload
dev:
	@echo "Starting development server..."
	go run .

# Run tests
test:
	@echo "Running tests..."
	go test -v ./...

# Run linter
lint:
	@echo "Running linter..."
	go vet ./...
	@if command -v golangci-lint >/dev/null 2>&1; then \
		golangci-lint run; \
	else \
		echo "golangci-lint not installed, skipping"; \
	fi

# Clean build artifacts
clean:
	@echo "Cleaning..."
	rm -f ../bin/server
	rm -rf ../dist

# Download dependencies
deps:
	@echo "Downloading dependencies..."
	go mod download
	go mod tidy

# Generate (if needed for future code generation)
generate:
	@echo "Running go generate..."
	go generate ./...

# Help
help:
	@echo "Available targets:"
	@echo "  all           - Build everything (default)"
	@echo "  build         - Build frontend and server"
	@echo "  build-server  - Build Go server only"
	@echo "  build-frontend - Build frontend only"
	@echo "  dev           - Run development server"
	@echo "  test          - Run tests"
	@echo "  lint          - Run linter"
	@echo "  clean         - Clean build artifacts"
	@echo "  deps          - Download dependencies"
	@echo "  help          - Show this help"
