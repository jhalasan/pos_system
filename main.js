import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POCKETBASE_HOST = '127.0.0.1';
const POCKETBASE_PORT = 8090;
const POCKETBASE_URL = `http://${POCKETBASE_HOST}:${POCKETBASE_PORT}`;
const STARTUP_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 5_000;

let mainWindow = null;
let pocketBaseProcess = null;
let isQuitting = false;

function getPocketBaseExecutablePath() {
  const executableName =
    process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase';
  const basePath = app.isPackaged ? process.resourcesPath : __dirname;

  return path.join(basePath, 'bin', executableName);
}

function getRendererPath() {
  const basePath = app.isPackaged ? app.getAppPath() : __dirname;
  return path.join(basePath, 'dist', 'index.html');
}

async function isPocketBaseHealthy() {
  return new Promise((resolve) => {
    const request = http.get(
      `${POCKETBASE_URL}/api/health`,
      { timeout: 1_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 300);
      },
    );

    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForPocketBase(childProcess) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null || childProcess.killed) {
      throw new Error(
        `PocketBase exited before becoming ready (exit code: ${childProcess.exitCode}).`,
      );
    }

    if (await isPocketBaseHealthy()) {
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS),
    );
  }

  throw new Error(
    `PocketBase did not become ready within ${STARTUP_TIMEOUT_MS / 1_000} seconds.`,
  );
}

async function startPocketBase() {
  const executablePath = getPocketBaseExecutablePath();
  const dataDirectory = path.join(app.getPath('userData'), 'pb_data');

  await access(executablePath);
  await mkdir(dataDirectory, { recursive: true });

  const childProcess = spawn(
    executablePath,
    [
      'serve',
      '--http',
      `${POCKETBASE_HOST}:${POCKETBASE_PORT}`,
      '--dir',
      dataDirectory,
    ],
    {
      cwd: path.dirname(executablePath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  pocketBaseProcess = childProcess;

  childProcess.stdout.on('data', (data) => {
    console.log(`[PocketBase] ${data.toString().trimEnd()}`);
  });

  childProcess.stderr.on('data', (data) => {
    console.error(`[PocketBase] ${data.toString().trimEnd()}`);
  });

  childProcess.on('error', (error) => {
    console.error('PocketBase process error:', error);
  });

  childProcess.once('exit', (code, signal) => {
    console.log(`PocketBase stopped (code: ${code}, signal: ${signal}).`);

    if (pocketBaseProcess === childProcess) {
      pocketBaseProcess = null;
    }

    if (!isQuitting && app.isReady()) {
      dialog.showErrorBox(
        'PocketBase stopped',
        'The local database process stopped unexpectedly. The application will close.',
      );
      app.quit();
    }
  });

  await waitForPocketBase(childProcess);
}

async function stopPocketBase() {
  const childProcess = pocketBaseProcess;

  if (!childProcess || childProcess.exitCode !== null) {
    pocketBaseProcess = null;
    return;
  }

  await new Promise((resolve) => {
    const forceKillTimer = setTimeout(() => {
      if (childProcess.exitCode === null) {
        childProcess.kill('SIGKILL');
      }
    }, SHUTDOWN_TIMEOUT_MS);

    childProcess.once('exit', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    if (!childProcess.kill('SIGTERM')) {
      clearTimeout(forceKillTimer);
      resolve();
    }
  });

  pocketBaseProcess = null;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(getRendererPath());
  }
}

app.whenReady().then(async () => {
  try {
    await startPocketBase();
    await createMainWindow();
  } catch (error) {
    console.error('Application startup failed:', error);
    dialog.showErrorBox(
      'Application startup failed',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0 && pocketBaseProcess) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  isQuitting = true;

  void stopPocketBase()
    .catch((error) => {
      console.error('Failed to stop PocketBase cleanly:', error);
    })
    .finally(() => {
      app.quit();
    });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in the Electron main process:', error);
  app.quit();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in the Electron main process:', reason);
  app.quit();
});
