@echo off
setlocal EnableDelayedExpansion

REM ===========================================================================
REM  Rebuild the Fire Test Plan Editor desktop executable.
REM
REM      build.bat                  web bundle -> exe -> selftest
REM      build.bat clean            discard PyInstaller artefacts first
REM      build.bat test             run both test suites before building
REM      build.bat console          build the console variant (selftest visible)
REM      build.bat noverify         skip the post-build selftest
REM
REM  Arguments combine:  build.bat clean test
REM
REM  The first run makes python\shell\.venv from Python 3.11 or later (releases
REM  use 3.14): FIREPLAN_PYTHON if set, else `py -3.14`, else python on PATH.
REM
REM  The exe carries web/dist/index.html as bundled data, so the web bundle is
REM  rebuilt first every time -- an exe packaged around a stale bundle is the
REM  one failure mode that looks like the code change simply did not work.
REM ===========================================================================

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

set "WEB=%REPO%\web"
set "SHELL_DIR=%REPO%\python\shell"
set "VENV_PY=%SHELL_DIR%\.venv\Scripts\python.exe"
set "EXE=%SHELL_DIR%\dist\FireTestPlanner.exe"
set "SELFTEST_LOG=%SHELL_DIR%\selftest-exe.log"

set "DO_CLEAN="
set "DO_TESTS="
set "DO_CONSOLE="
set "DO_VERIFY=1"

:parse
if "%~1"=="" goto parsed
if /I "%~1"=="clean"    ( set "DO_CLEAN=1"   & shift & goto parse )
if /I "%~1"=="test"     ( set "DO_TESTS=1"   & shift & goto parse )
if /I "%~1"=="tests"    ( set "DO_TESTS=1"   & shift & goto parse )
if /I "%~1"=="console"  ( set "DO_CONSOLE=1" & shift & goto parse )
if /I "%~1"=="noverify" ( set "DO_VERIFY="   & shift & goto parse )
if /I "%~1"=="-h"       goto usage
if /I "%~1"=="--help"   goto usage
if /I "%~1"=="/?"       goto usage
echo [build] Unknown argument: %~1
goto usage
:parsed

echo.
echo === Fire Test Plan Editor: desktop build ===
echo     repo: %REPO%
echo.

REM -- 1. toolchain ----------------------------------------------------------

where npm >nul 2>&1
if errorlevel 1 (
  echo [build] npm not found on PATH. Install Node.js, then re-run.
  goto fail
)

REM The desktop build needs Python 3.11 or later: the current pythonnet, which
REM pywebview needs on Windows, supports 3.11 to 3.15. Releases are built with 3.14.
REM A new venv is made from FIREPLAN_PYTHON (the full path of a python.exe) when it
REM is set, else from the py launcher's 3.14, else from python on PATH.

if exist "%VENV_PY%" goto venv_ready

echo [build] No venv at python\shell\.venv -- creating it.
if defined FIREPLAN_PYTHON (
  set BASE_PY="%FIREPLAN_PYTHON:"=%"
  goto base_found
)
py -3.14 -c "pass" >nul 2>&1
if not errorlevel 1 (
  set "BASE_PY=py -3.14"
  goto base_found
)
where python >nul 2>&1
if errorlevel 1 (
  echo [build] No Python found. Install Python 3.14, or set FIREPLAN_PYTHON to a python.exe.
  goto fail
)
set "BASE_PY=python"

:base_found
%BASE_PY% -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>&1
if errorlevel 1 (
  echo [build] %BASE_PY% is not Python 3.11 or later, which the desktop build needs.
  echo [build] Install Python 3.14, or set FIREPLAN_PYTHON to a newer python.exe.
  goto fail
)
pushd "%SHELL_DIR%" || goto fail
%BASE_PY% -m venv .venv
if errorlevel 1 ( popd & goto fail )
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 ( popd & goto fail )
popd
echo.

:venv_ready
"%VENV_PY%" -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>&1
if errorlevel 1 (
  echo [build] python\shell\.venv is older than Python 3.11, which the desktop build needs.
  echo [build] Delete python\shell\.venv and re-run; build.bat makes a new one.
  goto fail
)
for /f "delims=" %%V in ('"%VENV_PY%" --version') do echo [build] Build venv: %%V

if not exist "%WEB%\node_modules" (
  echo [build] web\node_modules missing -- running npm install.
  pushd "%WEB%" || goto fail
  call npm install
  if errorlevel 1 ( popd & goto fail )
  popd
  echo.
)

REM -- 2. tests (opt-in) -----------------------------------------------------

if defined DO_TESTS (
  REM The main interpreter, not the shell venv: that venv carries only pywebview
  REM and pyinstaller on purpose, while fireplan's tests need numpy and pytest.
  where python >nul 2>&1
  if errorlevel 1 (
    echo [build] python not found on PATH; cannot run the Python suite.
    goto fail
  )
  echo [build] Running the Python suite...
  pushd "%REPO%" || goto fail
  python -m pytest python\tests -q
  if errorlevel 1 (
    echo [build] Python tests failed -- not packaging a broken build.
    popd & goto fail
  )
  popd

  echo.
  echo [build] Running the web suite...
  pushd "%WEB%" || goto fail
  call npm test
  if errorlevel 1 (
    echo [build] Web tests failed -- not packaging a broken build.
    popd & goto fail
  )
  popd
  echo.
)

REM -- 3. web bundle ---------------------------------------------------------
REM `npm run build` typechecks first, so a type error stops the build here
REM rather than producing an exe around a stale bundle.

echo [build] Building the single-file web bundle...
pushd "%WEB%" || goto fail
call npm run build
if errorlevel 1 (
  echo [build] Web build failed.
  popd & goto fail
)
popd

if not exist "%WEB%\dist\index.html" (
  echo [build] Expected %WEB%\dist\index.html, but it is not there.
  goto fail
)
echo.

REM -- 4. package ------------------------------------------------------------

set "PKG_ARGS="
if defined DO_CLEAN   set "PKG_ARGS=%PKG_ARGS% --clean"
if defined DO_CONSOLE set "PKG_ARGS=%PKG_ARGS% --console"

echo [build] Packaging with PyInstaller...
pushd "%SHELL_DIR%" || goto fail
"%VENV_PY%" build_exe.py%PKG_ARGS%
if errorlevel 1 (
  echo [build] PyInstaller failed.
  popd & goto fail
)
popd

if not exist "%EXE%" (
  echo [build] PyInstaller reported success but %EXE% is missing.
  goto fail
)
echo.

REM -- 5. verify -------------------------------------------------------------
REM The exe's own --selftest: it boots the real window, waits for the page to
REM call /api/ready, and reports what the app told it. A GUI milestone nobody
REM can see is not verified. The window opens and closes on its own.

if defined DO_VERIFY (
  echo [build] Verifying the packaged exe ^(a window will flash open^)...
  if exist "%SELFTEST_LOG%" del /q "%SELFTEST_LOG%"
  REM Launched from a console, even the windowed exe inherits stdout, so its own
  REM prints would duplicate the log dump below. The log is the channel that works
  REM for both build variants -- keep that one.
  "%EXE%" --selftest --log "%SELFTEST_LOG%" >nul 2>&1
  set "SELFTEST_RC=!errorlevel!"

  if exist "%SELFTEST_LOG%" (
    echo.
    type "%SELFTEST_LOG%"
    echo.
  )
  if not "!SELFTEST_RC!"=="0" (
    echo [build] SELFTEST FAILED ^(exit !SELFTEST_RC!^) -- see %SELFTEST_LOG%
    goto fail
  )
)

echo.
echo === Build OK ===
for %%F in ("%EXE%") do echo     %%~fF  (%%~zF bytes)
echo.
echo     Run it:      "%EXE%"
echo     With a plan: "%EXE%" fixtures\pool-fire-camera-row.ftp.json
echo.
endlocal
exit /b 0

:usage
echo.
echo Usage: build.bat [clean] [test] [console] [noverify]
echo.
echo   clean      discard previous PyInstaller build/ and dist/ first
echo   test       run the Python and web suites before packaging
echo   console    build the console variant, so --selftest prints to a terminal
echo   noverify   skip the post-build selftest
echo.
endlocal
exit /b 2

:fail
echo.
echo === Build FAILED ===
endlocal
exit /b 1
