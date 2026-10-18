@echo off
chcp 65001 >nul 2>nul
REM ========================================
REM Dsh Webds Bridge - Auto Register (Windows)
REM ========================================
REM Usage: scripts\auto-register.cmd
REM ========================================
REM Delegates to the cross-platform Node master script so every entry point
REM shares one logic incl. the idempotent client patch entry writing.
REM ========================================

setlocal

REM Check if node is available
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] node not found, please install Node.js
    exit /b 1
)

REM Delegate to the cross-platform Node master script
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%auto-register.js"
set "EXIT_CODE=%errorlevel%"

endlocal & exit /b %EXIT_CODE%
