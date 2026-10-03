@echo off
title Vaporzr Visualizer
cd /d "%~dp0"

echo.
echo   VAPORZR VISUALIZER - broadcast mode
echo   -----------------------------------
echo   A clean window will open (no borders, no cursor).
echo.
echo   Hover the mouse over it to reveal the controls,
echo   or press Esc to close it.
echo.
echo   Leave this black window open while you use it.
echo   Closing this window stops the visualizer.
echo.

npm --prefix apps/player run broadcast -- --ws=wss://vaporzr.duckdns.org/ws

echo.
echo   The visualizer has stopped.
pause
