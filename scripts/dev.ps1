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
    For jobs action: status, list, retry, retry-all-failed, cancel, backfill

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

.EXAMPLE
    .\dev.ps1 jobs status
    Shows job queue summary statistics

.EXAMPLE
    .\dev.ps1 jobs list --status=failed
    Lists jobs with optional status filter

.EXAMPLE
    .\dev.ps1 jobs retry <id>
    Retries a single failed job
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "restart", "rebuild", "logs", "status", "clean", "test", "jobs", "help")]
    [string]$Action = "help",

    [Parameter(Position = 1)]
    [string]$Service = "",

    [Parameter(Position = 2)]
    [string]$ExtraArg = ""
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
    Write-Host "  jobs      Manage processing jobs. Options: status, list, retry, cancel, etc."
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
    Write-Host "Jobs Commands:"
    Write-Host "  .\dev.ps1 jobs status             # Show queue summary statistics"
    Write-Host "  .\dev.ps1 jobs list               # List all jobs (paginated)"
    Write-Host "  .\dev.ps1 jobs list --status=X    # List jobs by status (pending/processing/completed/failed)"
    Write-Host "  .\dev.ps1 jobs list --type=Y      # List jobs by type (generate_thumbnail/generate_preview)"
    Write-Host "  .\dev.ps1 jobs get <id>           # Get details for a specific job"
    Write-Host "  .\dev.ps1 jobs retry <id>         # Retry a single failed job"
    Write-Host "  .\dev.ps1 jobs retry-all-failed   # Retry all failed jobs"
    Write-Host "  .\dev.ps1 jobs cancel <id>        # Cancel a pending job"
    Write-Host "  .\dev.ps1 jobs stuck              # Find jobs stuck in processing"
    Write-Host "  .\dev.ps1 jobs reset-stuck        # Reset stuck jobs to pending"
    Write-Host "  .\dev.ps1 jobs backfill           # Queue jobs for assets without derivatives"
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

function Test-TypeCheck {
    Write-Info "Running TypeScript type check..."
    npm run typecheck
    if ($LASTEXITCODE -ne 0) {
        Write-Error "TypeScript type check failed!"
        return $false
    }
    Write-Success "Type check passed!"
    return $true
}

function Run-Tests {
    Push-Location $RepoRoot
    try {
        # Skip typecheck for UI and watch modes (interactive)
        $skipTypeCheck = @("ui", "watch")
        if ($Service.ToLower() -notin $skipTypeCheck) {
            if (-not (Test-TypeCheck)) {
                exit 1
            }
            Write-Host ""
        }

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

# Job management configuration
$ApiBaseUrl = "http://localhost:3000/api"

function Get-AdminToken {
    # For development, we'll use a simple approach - get a token from the API
    # In production, you'd use proper auth
    # For now, assume an admin user exists and we can get their token
    Write-Warning "Note: Jobs commands require admin authentication."
    Write-Warning "Ensure the API is running and you have admin access."
    return $null
}

function Invoke-AdminApi {
    param(
        [string]$Method = "GET",
        [string]$Endpoint,
        [object]$Body = $null
    )

    $url = "$ApiBaseUrl$Endpoint"
    $headers = @{
        "Content-Type" = "application/json"
        "Accept" = "application/json"
    }

    # Note: In a real implementation, you'd include an auth token
    # For dev purposes, we check if the API allows unauthenticated admin access
    # or use a dev-only admin endpoint

    try {
        $params = @{
            Uri = $url
            Method = $Method
            Headers = $headers
            ContentType = "application/json"
        }

        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Depth 10)
        }

        $response = Invoke-RestMethod @params
        return $response
    } catch {
        if ($_.Exception.Response.StatusCode -eq 401 -or $_.Exception.Response.StatusCode -eq 403) {
            Write-Error "ERROR: Authentication required. Admin endpoints require admin role."
            Write-Info "Tip: Log in via the web UI and use browser dev tools to get a valid token."
        } else {
            Write-Error "ERROR: API request failed: $($_.Exception.Message)"
            if ($_.ErrorDetails.Message) {
                $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json -ErrorAction SilentlyContinue
                if ($errorBody.error.message) {
                    Write-Error "       $($errorBody.error.message)"
                }
            }
        }
        return $null
    }
}

function Show-JobsStatus {
    Write-Info "Fetching job queue statistics..."

    $stats = Invoke-AdminApi -Endpoint "/admin/jobs/stats"

    if ($stats) {
        Write-Host ""
        Write-Info "Job Queue Statistics"
        Write-Host "===================="
        Write-Host ""

        # Display overall stats
        $data = $stats.data
        if ($data.byStatus) {
            Write-Host "By Status:"
            foreach ($status in $data.byStatus.PSObject.Properties) {
                $color = switch ($status.Name) {
                    "completed" { "Green" }
                    "failed" { "Red" }
                    "processing" { "Yellow" }
                    "pending" { "Cyan" }
                    default { "White" }
                }
                Write-Host "  $($status.Name): " -NoNewline
                Write-Host "$($status.Value)" -ForegroundColor $color
            }
            Write-Host ""
        }

        if ($data.byQueue) {
            Write-Host "By Queue:"
            foreach ($queue in $data.byQueue.PSObject.Properties) {
                Write-Host "  $($queue.Name): $($queue.Value)"
            }
            Write-Host ""
        }

        if ($data.byType) {
            Write-Host "By Type:"
            foreach ($type in $data.byType.PSObject.Properties) {
                Write-Host "  $($type.Name): $($type.Value)"
            }
        }
    }
}

function Show-JobsList {
    param([string]$Filter)

    $endpoint = "/admin/jobs?limit=20"

    # Parse filter arguments
    if ($Filter -match "--status=(\w+)") {
        $endpoint += "&status=$($Matches[1])"
    }
    if ($Filter -match "--type=(\w+)") {
        $endpoint += "&jobType=$($Matches[1])"
    }
    if ($Filter -match "--queue=(\w+)") {
        $endpoint += "&queue=$($Matches[1])"
    }

    Write-Info "Fetching jobs..."

    $result = Invoke-AdminApi -Endpoint $endpoint

    if ($result) {
        $jobs = $result.data
        $meta = $result.meta

        Write-Host ""
        Write-Info "Jobs (Page $($meta.page) of $($meta.totalPages), Total: $($meta.total))"
        Write-Host "=" * 80
        Write-Host ""

        if ($jobs.Count -eq 0) {
            Write-Host "No jobs found."
        } else {
            foreach ($job in $jobs) {
                $statusColor = switch ($job.status) {
                    "completed" { "Green" }
                    "failed" { "Red" }
                    "processing" { "Yellow" }
                    "pending" { "Cyan" }
                    "cancelled" { "DarkGray" }
                    default { "White" }
                }

                Write-Host "ID: $($job.id)"
                Write-Host "  Type:    $($job.jobType)"
                Write-Host "  Queue:   $($job.queue)"
                Write-Host "  Status:  " -NoNewline
                Write-Host "$($job.status)" -ForegroundColor $statusColor
                Write-Host "  Asset:   $($job.assetId)"
                Write-Host "  Created: $($job.createdAt)"
                if ($job.lastError) {
                    Write-Host "  Error:   " -NoNewline
                    Write-Host "$($job.lastError)" -ForegroundColor Red
                }
                Write-Host ""
            }
        }
    }
}

function Get-JobDetails {
    param([string]$JobId)

    if (-not $JobId) {
        Write-Error "ERROR: Job ID required. Usage: .\dev.ps1 jobs get <id>"
        return
    }

    Write-Info "Fetching job details..."

    $result = Invoke-AdminApi -Endpoint "/admin/jobs/$JobId"

    if ($result) {
        $job = $result.data

        Write-Host ""
        Write-Info "Job Details"
        Write-Host "==========="
        Write-Host ""
        Write-Host "ID:          $($job.id)"
        Write-Host "Type:        $($job.jobType)"
        Write-Host "Queue:       $($job.queue)"
        Write-Host "Priority:    $($job.priority)"
        Write-Host "Status:      $($job.status)"
        Write-Host "Asset ID:    $($job.assetId)"
        Write-Host "Worker ID:   $($job.workerId)"
        Write-Host "Attempts:    $($job.attempts) / $($job.maxAttempts)"
        Write-Host "Created:     $($job.createdAt)"
        Write-Host "Started:     $($job.startedAt)"
        Write-Host "Completed:   $($job.completedAt)"
        Write-Host "Trace ID:    $($job.traceId)"

        if ($job.lastError) {
            Write-Host ""
            Write-Host "Last Error:" -ForegroundColor Red
            Write-Host "  $($job.lastError)" -ForegroundColor Red
        }

        if ($job.result) {
            Write-Host ""
            Write-Host "Result:"
            Write-Host ($job.result | ConvertTo-Json -Depth 5)
        }

        if ($job.payload) {
            Write-Host ""
            Write-Host "Payload:"
            Write-Host ($job.payload | ConvertTo-Json -Depth 5)
        }
    }
}

function Invoke-JobRetry {
    param([string]$JobId)

    if (-not $JobId) {
        Write-Error "ERROR: Job ID required. Usage: .\dev.ps1 jobs retry <id>"
        return
    }

    Write-Info "Retrying job $JobId..."

    $result = Invoke-AdminApi -Method "POST" -Endpoint "/admin/jobs/$JobId/retry"

    if ($result) {
        Write-Success "Job queued for retry!"
        Write-Host "  Status: $($result.data.status)"
        Write-Host "  Message: $($result.data.message)"
    }
}

function Invoke-RetryAllFailed {
    Write-Info "Retrying all failed jobs..."

    $result = Invoke-AdminApi -Method "POST" -Endpoint "/admin/jobs/batch/retry"

    if ($result) {
        Write-Success "$($result.data.retriedCount) job(s) queued for retry!"
    }
}

function Invoke-JobCancel {
    param([string]$JobId)

    if (-not $JobId) {
        Write-Error "ERROR: Job ID required. Usage: .\dev.ps1 jobs cancel <id>"
        return
    }

    Write-Info "Cancelling job $JobId..."

    $result = Invoke-AdminApi -Method "POST" -Endpoint "/admin/jobs/$JobId/cancel"

    if ($result) {
        Write-Success "Job cancelled!"
        Write-Host "  Status: $($result.data.status)"
    }
}

function Show-StuckJobs {
    Write-Info "Finding stuck jobs (processing > 30 minutes)..."

    $result = Invoke-AdminApi -Endpoint "/admin/jobs/stuck"

    if ($result) {
        $jobs = $result.data

        Write-Host ""
        Write-Info "Stuck Jobs (Count: $($result.meta.count))"
        Write-Host "=" * 60
        Write-Host ""

        if ($jobs.Count -eq 0) {
            Write-Success "No stuck jobs found!"
        } else {
            foreach ($job in $jobs) {
                Write-Host "ID: $($job.id)"
                Write-Host "  Type:    $($job.jobType)"
                Write-Host "  Worker:  $($job.workerId)"
                Write-Host "  Started: $($job.startedAt)"
                Write-Host ""
            }

            Write-Warning "Run '.\dev.ps1 jobs reset-stuck' to reset these jobs to pending."
        }
    }
}

function Invoke-ResetStuck {
    Write-Info "Resetting stuck jobs to pending..."

    $result = Invoke-AdminApi -Method "POST" -Endpoint "/admin/jobs/stuck/reset"

    if ($result) {
        Write-Success "$($result.data.resetCount) job(s) reset to pending!"
    }
}

function Invoke-Backfill {
    Write-Info "Backfill functionality creates jobs for assets without derivatives."
    Write-Warning "This feature requires direct database access."
    Write-Host ""
    Write-Host "To backfill manually, run this SQL via psql:"
    Write-Host ""
    Write-Host @"
INSERT INTO processing_jobs (asset_id, job_type, queue, priority, payload, trace_id)
SELECT
    ma.id,
    'generate_thumbnail',
    CASE WHEN ma.file_size > 104857600 THEN 'large_files' ELSE 'default' END,
    10,
    jsonb_build_object('assetId', ma.id, 'libraryId', ma.library_id),
    gen_random_uuid()::text
FROM media_assets ma
WHERE ma.thumbnail_key IS NULL
  AND ma.status NOT IN ('deleted', 'error')
  AND NOT EXISTS (
    SELECT 1 FROM processing_jobs pj
    WHERE pj.asset_id = ma.id
      AND pj.job_type = 'generate_thumbnail'
      AND pj.status IN ('pending', 'processing')
  );
"@
    Write-Host ""
    Write-Info "Connect with: docker compose -f infra/compose/dev.compose.yml exec postgres psql -U memoriahub"
}

function Manage-Jobs {
    switch ($Service.ToLower()) {
        "status" { Show-JobsStatus }
        "list" { Show-JobsList -Filter $ExtraArg }
        "get" { Get-JobDetails -JobId $ExtraArg }
        "retry" { Invoke-JobRetry -JobId $ExtraArg }
        "retry-all-failed" { Invoke-RetryAllFailed }
        "cancel" { Invoke-JobCancel -JobId $ExtraArg }
        "stuck" { Show-StuckJobs }
        "reset-stuck" { Invoke-ResetStuck }
        "backfill" { Invoke-Backfill }
        default {
            Write-Host ""
            Write-Info "Jobs Management Commands"
            Write-Host "========================"
            Write-Host ""
            Write-Host "Usage: .\dev.ps1 jobs <command> [args]"
            Write-Host ""
            Write-Host "Commands:"
            Write-Host "  status           Show queue summary statistics"
            Write-Host "  list [filters]   List jobs (--status=X, --type=Y, --queue=Z)"
            Write-Host "  get <id>         Get details for a specific job"
            Write-Host "  retry <id>       Retry a single failed job"
            Write-Host "  retry-all-failed Retry all failed jobs"
            Write-Host "  cancel <id>      Cancel a pending job"
            Write-Host "  stuck            Find jobs stuck in processing"
            Write-Host "  reset-stuck      Reset stuck jobs to pending"
            Write-Host "  backfill         Instructions to create jobs for assets without derivatives"
            Write-Host ""
            Write-Host "Examples:"
            Write-Host "  .\dev.ps1 jobs status"
            Write-Host "  .\dev.ps1 jobs list --status=failed"
            Write-Host "  .\dev.ps1 jobs retry abc-123-def"
            Write-Host ""
        }
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
    "jobs"    { Manage-Jobs }
    "clean"   { Clean-Services }
    "help"    { Show-Help }
    default   { Show-Help }
}
