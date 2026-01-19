<#
.SYNOPSIS
    MemoriaHub Development Script for Windows

.DESCRIPTION
    Manages the MemoriaHub development environment using Docker Compose.
    Supports starting, stopping, rebuilding, viewing logs, and running tests.

.PARAMETER Action
    The action to perform: start, stop, restart, rebuild, logs, status, clean, test

.PARAMETER Service
    Optional: Specific service to target (api, web, worker, postgres, etc.)
    For test action: run, ui, coverage, unit, integration

.EXAMPLE
    .\dev.ps1 start
    Starts all services

.EXAMPLE
    .\dev.ps1 rebuild
    Rebuilds and restarts all services

.EXAMPLE
    .\dev.ps1 logs api
    Shows logs for the API service

.EXAMPLE
    .\dev.ps1 test
    Runs all tests once

.EXAMPLE
    .\dev.ps1 test ui
    Opens Vitest UI for interactive test viewing

.EXAMPLE
    .\dev.ps1 clean
    Stops services and removes volumes (resets database)
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "restart", "rebuild", "logs", "status", "clean", "test", "help")]
    [string]$Action = "help",

    [Parameter(Position = 1)]
    [string]$Service = ""
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Info { Write-Host $args -ForegroundColor Cyan }
function Write-Success { Write-Host $args -ForegroundColor Green }
function Write-Warning { Write-Host $args -ForegroundColor Yellow }
function Write-Error { Write-Host $args -ForegroundColor Red }

# Get the repository root (parent of scripts folder)
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $RepoRoot "infra\compose\dev.compose.yml"

# Verify compose file exists
if (-not (Test-Path $ComposeFile)) {
    Write-Error "ERROR: Compose file not found at $ComposeFile"
    Write-Error "Make sure you're running this script from the MemoriaHub repository."
    exit 1
}

function Show-Help {
    Write-Host ""
    Write-Info "MemoriaHub Development Script"
    Write-Host "=============================="
    Write-Host ""
    Write-Host "Usage: .\dev.ps1 <action> [service/option]"
    Write-Host ""
    Write-Host "Actions:"
    Write-Host "  start     Start all services (or specific service)"
    Write-Host "  stop      Stop all services (or specific service)"
    Write-Host "  restart   Restart all services (or specific service)"
    Write-Host "  rebuild   Rebuild and restart all services (or specific service)"
    Write-Host "  logs      Show logs (follow mode). Optionally specify service"
    Write-Host "  status    Show status of all services"
    Write-Host "  test      Run tests. Options: run, ui, coverage, unit, integration"
    Write-Host "  clean     Stop services and remove volumes (resets database)"
    Write-Host "  help      Show this help message"
    Write-Host ""
    Write-Host "Services: api, web, worker, postgres, minio, nginx, grafana, prometheus, jaeger"
    Write-Host ""
    Write-Host "Test Options:"
    Write-Host "  .\dev.ps1 test              # Run all tests once"
    Write-Host "  .\dev.ps1 test ui           # Open Vitest UI (visual test browser)"
    Write-Host "  .\dev.ps1 test watch        # Run tests in watch mode"
    Write-Host "  .\dev.ps1 test coverage     # Run tests with coverage report"
    Write-Host "  .\dev.ps1 test unit         # Run only unit tests"
    Write-Host "  .\dev.ps1 test integration  # Run only integration tests"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\dev.ps1 start           # Start all services"
    Write-Host "  .\dev.ps1 rebuild         # Rebuild and start all services"
    Write-Host "  .\dev.ps1 rebuild api     # Rebuild only the API service"
    Write-Host "  .\dev.ps1 logs api        # Follow API logs"
    Write-Host "  .\dev.ps1 test ui         # Open test UI in browser"
    Write-Host "  .\dev.ps1 status          # Show service status"
    Write-Host "  .\dev.ps1 clean           # Reset everything (destroys data)"
    Write-Host ""
    Write-Host "URLs (after start):"
    Write-Host "  Web App:      http://localhost:5173"
    Write-Host "  API:          http://localhost:3000"
    Write-Host "  API Health:   http://localhost:3000/healthz"
    Write-Host "  Grafana:      http://localhost:3001 (admin/admin)"
    Write-Host "  Jaeger:       http://localhost:16686"
    Write-Host "  MinIO:        http://localhost:9001 (memoriahub/memoriahub_dev_secret)"
    Write-Host "  Test UI:      http://localhost:51204/__vitest__/ (when running test ui)"
    Write-Host ""
}

function Invoke-DockerCompose {
    param([string[]]$Arguments)
    $cmd = "docker compose -f `"$ComposeFile`" $($Arguments -join ' ')"
    Write-Info "Running: $cmd"
    Invoke-Expression $cmd
}

function Start-Services {
    Write-Info "Starting MemoriaHub services..."
    if ($Service) {
        Invoke-DockerCompose @("up", "-d", $Service)
    } else {
        Invoke-DockerCompose @("up", "-d")
    }
    Write-Success "Services started!"
    Write-Host ""
    Write-Info "Web App: http://localhost:5173"
    Write-Info "API:     http://localhost:3000/healthz"
}

function Stop-Services {
    Write-Info "Stopping MemoriaHub services..."
    if ($Service) {
        Invoke-DockerCompose @("stop", $Service)
    } else {
        Invoke-DockerCompose @("down")
    }
    Write-Success "Services stopped!"
}

function Restart-Services {
    Write-Info "Restarting MemoriaHub services..."
    if ($Service) {
        Invoke-DockerCompose @("restart", $Service)
    } else {
        Invoke-DockerCompose @("down")
        Invoke-DockerCompose @("up", "-d")
    }
    Write-Success "Services restarted!"
}

function Rebuild-Services {
    Write-Info "Rebuilding MemoriaHub services..."
    if ($Service) {
        Invoke-DockerCompose @("up", "-d", "--build", $Service)
    } else {
        Invoke-DockerCompose @("up", "-d", "--build")
    }
    Write-Success "Services rebuilt and started!"
    Write-Host ""
    Write-Info "Web App: http://localhost:5173"
    Write-Info "API:     http://localhost:3000/healthz"
}

function Show-Logs {
    Write-Info "Showing logs (Ctrl+C to exit)..."
    if ($Service) {
        Invoke-DockerCompose @("logs", "-f", $Service)
    } else {
        Invoke-DockerCompose @("logs", "-f")
    }
}

function Show-Status {
    Write-Info "Service Status:"
    Invoke-DockerCompose @("ps")
}

function Clean-Services {
    Write-Warning "WARNING: This will stop all services and DELETE all data (database, storage)!"
    $confirmation = Read-Host "Are you sure? Type 'yes' to confirm"
    if ($confirmation -eq "yes") {
        Write-Info "Cleaning up MemoriaHub services and volumes..."
        Invoke-DockerCompose @("down", "-v")
        Write-Success "Cleanup complete! All data has been removed."
    } else {
        Write-Info "Cleanup cancelled."
    }
}

function Run-Tests {
    Push-Location $RepoRoot
    try {
        switch ($Service.ToLower()) {
            "ui" {
                Write-Info "Opening Vitest UI..."
                Write-Info "Test UI will be available at: http://localhost:51204/__vitest__/"
                npm run test:ui
            }
            "watch" {
                Write-Info "Running tests in watch mode..."
                npm run test
            }
            "coverage" {
                Write-Info "Running tests with coverage..."
                npm run test:coverage
                Write-Success "Coverage report generated in ./coverage/"
            }
            "unit" {
                Write-Info "Running unit tests..."
                npm run test:unit
            }
            "integration" {
                Write-Info "Running integration tests..."
                npm run test:integration
            }
            default {
                Write-Info "Running all tests..."
                npm run test:unit
            }
        }
    } finally {
        Pop-Location
    }
}

# Main execution
switch ($Action) {
    "start"   { Start-Services }
    "stop"    { Stop-Services }
    "restart" { Restart-Services }
    "rebuild" { Rebuild-Services }
    "logs"    { Show-Logs }
    "status"  { Show-Status }
    "test"    { Run-Tests }
    "clean"   { Clean-Services }
    "help"    { Show-Help }
    default   { Show-Help }
}
