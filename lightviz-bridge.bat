@echo off
REM Launch the lightviz Art-Net bridge on Windows (reads the project from WSL).
REM Captures Soundswitch's Localhost Art-Net Node output on 6454 and serves the
REM WebSocket/HTTP for the browser client on 7777.
title lightviz bridge
echo Starting lightviz bridge...  (Ctrl+C to stop)
node "\\wsl.localhost\Ubuntu-26.04\home\grays\lightviz\server\index.js"
pause
