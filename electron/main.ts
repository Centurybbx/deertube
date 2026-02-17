import { app, BrowserWindow, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import inspector from 'node:inspector'
import { createIPCHandler } from 'electron-trpc-experimental/main'
import { createTRPCContext } from './trpc/init'
import { appRouter } from './trpc/routers/_app'
import { getPreviewController } from './trpc/preview'
import { getBrowserViewController } from './browserview'
import { getCdpBrowserController } from './cdp-browser'
import { ensureBuiltinSearchSkillsSeeded } from "./skills/registry";

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST
const isDev = Boolean(VITE_DEV_SERVER_URL)
const MAIN_INSPECT_PORT = 9229

let win: BrowserWindow | null
let mainDevtoolsWindow: BrowserWindow | null = null
let isQuitting = false

app.once('before-quit', () => {
  isQuitting = true
})

const openMainDevTools = () => {
  if (!isDev) {
    return
  }
  if (!inspector.url()) {
    inspector.open(MAIN_INSPECT_PORT)
  }
  const wsUrl = inspector.url()
  if (!wsUrl) {
    console.warn('Inspector is not active. Please run with --inspect.')
    return
  }

  if (mainDevtoolsWindow && !mainDevtoolsWindow.isDestroyed()) {
    mainDevtoolsWindow.show()
    mainDevtoolsWindow.focus()
    return
  }

  const rawURL = new URL(wsUrl)
  const socketURL = `${rawURL.host}${rawURL.pathname}`
  const devtoolsUrl =
    `devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=` +
    socketURL

  mainDevtoolsWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  void mainDevtoolsWindow.loadURL(devtoolsUrl)
  mainDevtoolsWindow.once('ready-to-show', () => {
    mainDevtoolsWindow?.show()
  })
  mainDevtoolsWindow.on('close', (event) => {
    if (isQuitting) {
      return
    }
    event.preventDefault()
    mainDevtoolsWindow?.hide()
  })
  mainDevtoolsWindow.on('closed', () => {
    mainDevtoolsWindow = null
  })
}

const registerDevDockMenu = () => {
  if (!isDev || process.platform !== 'darwin') {
    return
  }
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Main DevTools',
      click: () => {
        openMainDevTools()
      },
    },
  ])
  app.dock.setMenu(menu)
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
    },
  })

  getPreviewController().attachWindow(win)
  getBrowserViewController().attachWindow(win)
  getCdpBrowserController().attachWindow(win)
  createIPCHandler({
    router: appRouter,
    windows: [win],
    createContext: ({ event }) => Promise.resolve(createTRPCContext({ event })),
  })

  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    void win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

void app.whenReady().then(async () => {
  await ensureBuiltinSearchSkillsSeeded();
  registerDevDockMenu()
  createWindow()
})
