#!/bin/bash

# Modular script to run various services with Docker
# Usage: ./run.sh <service>

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function to print colored messages
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Get the project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# Default data directory (can be overridden by MY_DATA_DIR env var)
DATA_DIR="${MY_DATA_DIR:-$PROJECT_ROOT/data}"

# Service functions
run_meilisearch() {
    log_info "Starting Meilisearch with Docker..."

    local MEILI_VERSION="v1.16"
    local MEILI_PORT="7700"
    local MEILI_DATA_DIR="$DATA_DIR/.app/mylifedb/meili"

    # Create data directory if it doesn't exist
    mkdir -p "$MEILI_DATA_DIR"

    log_info "Data will be persisted to: $MEILI_DATA_DIR"
    log_info "Meilisearch will be available at: http://localhost:$MEILI_PORT"

    # Check if container is already running
    if docker ps --format '{{.Names}}' | grep -q '^meilisearch$'; then
        log_warn "Meilisearch container is already running"
        log_info "To stop it, run: docker stop meilisearch"
        exit 0
    fi

    # Pull the latest image
    docker pull "getmeili/meilisearch:$MEILI_VERSION"

    # Run Meilisearch
    docker run -it --rm \
        --name meilisearch \
        -p "$MEILI_PORT:7700" \
        -e MEILI_ENV='development' \
        -v "$MEILI_DATA_DIR:/meili_data" \
        "getmeili/meilisearch:$MEILI_VERSION"
}

# Main script logic
main() {
    local SERVICE="$1"

    if [ -z "$SERVICE" ]; then
        log_error "No service specified"
        echo ""
        echo "Usage: $0 <service>"
        echo ""
        echo "Available services:"
        echo "  meili    - Start Meilisearch search engine"
        echo ""
        exit 1
    fi

    case "$SERVICE" in
        meili|meilisearch)
            run_meilisearch
            ;;
        *)
            log_error "Unknown service: $SERVICE"
            echo ""
            echo "Available services:"
            echo "  meili    - Start Meilisearch search engine"
            echo ""
            exit 1
            ;;
    esac
}

main "$@"
