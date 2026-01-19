#!/usr/bin/env bash
#
# MemoriaHub Development Script for Linux/macOS
#
# Manages the MemoriaHub development environment using Docker Compose.
# Supports starting, stopping, rebuilding, and viewing logs.
#
# Usage: ./dev.sh <action> [service]
#
# Actions:
#   start     Start all services (or specific service)
#   stop      Stop all services (or specific service)
#   restart   Restart all services (or specific service)
#   rebuild   Rebuild and restart all services (or specific service)
#   logs      Show logs (follow mode). Optionally specify service
#   status    Show status of all services
#   clean     Stop services and remove volumes (resets database)
#   help      Show this help message
#
# Examples:
#   ./dev.sh start           # Start all services
#   ./dev.sh rebuild         # Rebuild and start all services
#   ./dev.sh rebuild api     # Rebuild only the API service
#   ./dev.sh logs api        # Follow API logs
#   ./dev.sh status          # Show service status
#   ./dev.sh clean           # Reset everything (destroys data)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info() { echo -e "${CYAN}$*${NC}"; }
success() { echo -e "${GREEN}$*${NC}"; }
warning() { echo -e "${YELLOW}$*${NC}"; }
error() { echo -e "${RED}$*${NC}"; }

# Get the repository root (parent of scripts folder)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$REPO_ROOT/infra/compose/dev.compose.yml"

# Verify compose file exists
if [[ ! -f "$COMPOSE_FILE" ]]; then
    error "ERROR: Compose file not found at $COMPOSE_FILE"
    error "Make sure you're running this script from the MemoriaHub repository."
    exit 1
fi

ACTION="${1:-help}"
SERVICE="${2:-}"

show_help() {
    echo ""
    info "MemoriaHub Development Script"
    echo "=============================="
    echo ""
    echo "Usage: ./dev.sh <action> [service]"
    echo ""
    echo "Actions:"
    echo "  start     Start all services (or specific service)"
    echo "  stop      Stop all services (or specific service)"
    echo "  restart   Restart all services (or specific service)"
    echo "  rebuild   Rebuild and restart all services (or specific service)"
    echo "  logs      Show logs (follow mode). Optionally specify service"
    echo "  status    Show status of all services"
    echo "  clean     Stop services and remove volumes (resets database)"
    echo "  help      Show this help message"
    echo ""
    echo "Services: api, web, worker, postgres, minio, nginx, grafana, prometheus, jaeger"
    echo ""
    echo "Examples:"
    echo "  ./dev.sh start           # Start all services"
    echo "  ./dev.sh rebuild         # Rebuild and start all services"
    echo "  ./dev.sh rebuild api     # Rebuild only the API service"
    echo "  ./dev.sh logs api        # Follow API logs"
    echo "  ./dev.sh status          # Show service status"
    echo "  ./dev.sh clean           # Reset everything (destroys data)"
    echo ""
    echo "URLs (after start):"
    echo "  Web App:      http://localhost:5173"
    echo "  API:          http://localhost:3000"
    echo "  API Health:   http://localhost:3000/healthz"
    echo "  Grafana:      http://localhost:3001 (admin/admin)"
    echo "  Jaeger:       http://localhost:16686"
    echo "  MinIO:        http://localhost:9001 (memoriahub/memoriahub_dev_secret)"
    echo ""
}

run_compose() {
    info "Running: docker compose -f $COMPOSE_FILE $*"
    docker compose -f "$COMPOSE_FILE" "$@"
}

start_services() {
    info "Starting MemoriaHub services..."
    if [[ -n "$SERVICE" ]]; then
        run_compose up -d "$SERVICE"
    else
        run_compose up -d
    fi
    success "Services started!"
    echo ""
    info "Web App: http://localhost:5173"
    info "API:     http://localhost:3000/healthz"
}

stop_services() {
    info "Stopping MemoriaHub services..."
    if [[ -n "$SERVICE" ]]; then
        run_compose stop "$SERVICE"
    else
        run_compose down
    fi
    success "Services stopped!"
}

restart_services() {
    info "Restarting MemoriaHub services..."
    if [[ -n "$SERVICE" ]]; then
        run_compose restart "$SERVICE"
    else
        run_compose down
        run_compose up -d
    fi
    success "Services restarted!"
}

rebuild_services() {
    info "Rebuilding MemoriaHub services..."
    if [[ -n "$SERVICE" ]]; then
        run_compose up -d --build "$SERVICE"
    else
        run_compose up -d --build
    fi
    success "Services rebuilt and started!"
    echo ""
    info "Web App: http://localhost:5173"
    info "API:     http://localhost:3000/healthz"
}

show_logs() {
    info "Showing logs (Ctrl+C to exit)..."
    if [[ -n "$SERVICE" ]]; then
        run_compose logs -f "$SERVICE"
    else
        run_compose logs -f
    fi
}

show_status() {
    info "Service Status:"
    run_compose ps
}

clean_services() {
    warning "WARNING: This will stop all services and DELETE all data (database, storage)!"
    read -rp "Are you sure? Type 'yes' to confirm: " confirmation
    if [[ "$confirmation" == "yes" ]]; then
        info "Cleaning up MemoriaHub services and volumes..."
        run_compose down -v
        success "Cleanup complete! All data has been removed."
    else
        info "Cleanup cancelled."
    fi
}

# Main execution
case "$ACTION" in
    start)   start_services ;;
    stop)    stop_services ;;
    restart) restart_services ;;
    rebuild) rebuild_services ;;
    logs)    show_logs ;;
    status)  show_status ;;
    clean)   clean_services ;;
    help)    show_help ;;
    *)       show_help ;;
esac
