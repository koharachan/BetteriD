@echo off
setlocal

set "VSDEVCMD=C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
if not exist "%VSDEVCMD%" (
  echo Visual Studio developer environment not found: %VSDEVCMD%
  exit /b 1
)

call "%VSDEVCMD%" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%

if not defined RUST_LOG set "RUST_LOG=info"
cargo run
