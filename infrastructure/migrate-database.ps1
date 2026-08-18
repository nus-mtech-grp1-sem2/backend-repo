# MySQL Database Migration Script for OneStage
# This script drops all existing tables and recreates them from schema

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "OneStage Database Migration Script" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Load environment variables from .env file
if (Test-Path ".env") {
    Write-Host "Loading environment variables from .env file..." -ForegroundColor Green
    Get-Content ".env" | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]*?)\s*=\s*(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($key, $value, [System.EnvironmentVariableTarget]::Process)
        }
    }
} else {
    Write-Host "ERROR: .env file not found!" -ForegroundColor Red
    Write-Host "Please create a .env file with your RDS connection details." -ForegroundColor Yellow
    Write-Host "Example: cp .env.example .env" -ForegroundColor Yellow
    exit 1
}

# Get database credentials from environment variables
$DB_HOST = $env:DB_HOST
$DB_PORT = $env:DB_PORT
$DB_NAME = $env:DB_NAME
$DB_USER = $env:DB_USER
$DB_PASSWORD = $env:DB_PASSWORD
$DB_SSL = $env:DB_SSL

if (-not $DB_HOST -or -not $DB_USER -or -not $DB_PASSWORD -or -not $DB_NAME) {
    Write-Host "ERROR: Missing required environment variables!" -ForegroundColor Red
    Write-Host "Required: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME" -ForegroundColor Yellow
    exit 1
}

Write-Host "Database Configuration:" -ForegroundColor Cyan
Write-Host "  Host: $DB_HOST" -ForegroundColor White
Write-Host "  Port: $DB_PORT" -ForegroundColor White
Write-Host "  Database: $DB_NAME" -ForegroundColor White
Write-Host "  User: $DB_USER" -ForegroundColor White
Write-Host ""

# Confirm before proceeding
Write-Host "WARNING: This will DROP ALL EXISTING TABLES in '$DB_NAME'!" -ForegroundColor Yellow
$confirmation = Read-Host "Are you sure you want to continue? (yes/no)"
if ($confirmation -ne "yes") {
    Write-Host "Operation cancelled." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Starting migration..." -ForegroundColor Green
Write-Host ""

# Check if mysql command is available
$mysqlCmd = Get-Command mysql -ErrorAction SilentlyContinue
if (-not $mysqlCmd) {
    Write-Host "ERROR: MySQL client not found!" -ForegroundColor Red
    Write-Host "Please install MySQL client:" -ForegroundColor Yellow
    Write-Host "  - Download from: https://dev.mysql.com/downloads/mysql/" -ForegroundColor White
    Write-Host "  - Or install via package manager (winget, chocolatey)" -ForegroundColor White
    exit 1
}

# Build mysql connection string
$sslArg = if ($DB_SSL -eq "true") { "--ssl-mode=REQUIRED" } else { "" }
$mysqlArgs = @(
    "-h", $DB_HOST,
    "-P", $DB_PORT,
    "-u", $DB_USER,
    "-p$DB_PASSWORD",
    $DB_NAME
)
if ($sslArg) { $mysqlArgs += $sslArg }

# Step 1: Drop all existing tables
Write-Host "[1/2] Dropping all existing tables..." -ForegroundColor Cyan
$dropScript = "infrastructure\sql\01-drop-all-tables.sql"
if (Test-Path $dropScript) {
    Get-Content $dropScript | mysql $mysqlArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ All tables dropped successfully" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Error dropping tables (Exit code: $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  ✗ Drop script not found: $dropScript" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Step 2: Create all tables
Write-Host "[2/2] Creating all tables from schema..." -ForegroundColor Cyan
$createScript = "infrastructure\sql\02-create-all-tables.sql"
if (Test-Path $createScript) {
    Get-Content $createScript | mysql $mysqlArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ All 19 tables created successfully" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Error creating tables (Exit code: $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  ✗ Create script not found: $createScript" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Green
Write-Host "Migration completed successfully! ✓" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Green
Write-Host ""

# Show table list
Write-Host "Verifying tables in database..." -ForegroundColor Cyan
$tableQuery = "SHOW TABLES;"
echo $tableQuery | mysql $mysqlArgs

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Review the created tables" -ForegroundColor White
Write-Host "  2. Add seed data if needed" -ForegroundColor White
Write-Host "  3. Test database connections from your services" -ForegroundColor White
Write-Host ""
