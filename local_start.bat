@echo off
setlocal

set "BACKEND_DIR=%~dp0"
set "FRONTEND_DIR=%~dp0..\core-frontend"

if not exist "%FRONTEND_DIR%\package.json" (
  echo Frontend repository not found: %FRONTEND_DIR%
  pause
  exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
  echo Docker is required but was not found on PATH.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm is required but was not found on PATH.
  pause
  exit /b 1
)

where aws >nul 2>&1
if errorlevel 1 (
  echo AWS CLI not found. Attempting install via winget...
  where winget >nul 2>&1
  if not errorlevel 1 (
    winget install --id Amazon.AWSCLI -e --silent --accept-package-agreements --accept-source-agreements
  )
)

set "AWS_MYSQL_IP="
where aws >nul 2>&1
if errorlevel 1 (
  echo AWS CLI still not available - leaving .env DB_HOST unchanged ^(local mysql container will be used^).
  goto :skip_aws_ip
)

aws sts get-caller-identity >nul 2>&1
if errorlevel 1 (
  echo AWS CLI not configured with credentials - leaving .env DB_HOST unchanged.
  goto :skip_aws_ip
)

echo Fetching current AWS mysql task public IP...
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%BACKEND_DIR%scripts\mysql-public-ip.ps1" 2^>nul`) do set "AWS_MYSQL_IP=%%I"

echo %AWS_MYSQL_IP%| findstr /r "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo Could not determine AWS mysql IP ^(got: "%AWS_MYSQL_IP%"^) - leaving .env DB_HOST unchanged.
) else (
  echo Updating .env DB_HOST to %AWS_MYSQL_IP%...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw '%BACKEND_DIR%.env') -replace '(?m)^DB_HOST=.*$', 'DB_HOST=%AWS_MYSQL_IP%' | Set-Content -NoNewline '%BACKEND_DIR%.env'"
)

:skip_aws_ip

echo Stopping previous OneStage launchers and backend containers...
taskkill /FI "WINDOWTITLE eq OneStage Backend*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq OneStage Frontend*" /T /F >nul 2>&1
docker compose -f "%BACKEND_DIR%infrastructure\docker-compose.yml" --env-file "%BACKEND_DIR%.env" down --remove-orphans >nul 2>&1

start "OneStage Backend" powershell -NoExit -ExecutionPolicy Bypass -Command ^
  "Set-Location -LiteralPath '%BACKEND_DIR%'; $env:COGNITO_USER_POOL_ID='ap-southeast-1_cgmx4fpO2'; $env:COGNITO_CLIENT_ID='gh94lqsterju3qoffje1grep8'; $env:AWS_REGION='ap-southeast-1'; docker compose -f infrastructure/docker-compose.yml --env-file .env up --build"

start "OneStage Frontend" powershell -NoExit -ExecutionPolicy Bypass -Command ^
  "Set-Location -LiteralPath '%FRONTEND_DIR%'; npm start"

echo Backend and frontend are starting in separate windows.
echo Frontend: http://localhost:4200
endlocal
