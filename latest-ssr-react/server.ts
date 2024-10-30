import express, { Request, Response } from 'express'
import fs from 'node:fs/promises'
import { Transform, TransformCallback } from 'node:stream'
import type { ViteDevServer } from 'vite'

// Types
interface RenderOptions {
  onShellError: () => void
  onShellReady: () => void
  onError: (error: Error) => void
}

interface RenderResult {
  pipe: (destination: Transform) => void
  abort: () => void
}

interface SSRModule {
  render: (
    url: string,
    manifest: string | undefined,
    options: RenderOptions
  ) => RenderResult
}

// Constants
const isProduction = process.env.NODE_ENV === 'production'
const port = process.env.PORT || 5173
const base = process.env.BASE || '/'
const ABORT_DELAY = 10000

// Cached production assets
const templateHtml = isProduction
  ? await fs.readFile('./dist/client/index.html', 'utf-8')
  : ''
const ssrManifest = isProduction
  ? await fs.readFile('./dist/client/.vite/ssr-manifest.json', 'utf-8')
  : undefined

// Create http server
const app = express()

// Add Vite or respective production middlewares
let vite: ViteDevServer | undefined
if (!isProduction) {
  const { createServer } = await import('vite')
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    base,
  })
  app.use(vite.middlewares)
} else {
  const compression = (await import('compression')).default
  const sirv = (await import('sirv')).default
  app.use(compression())
  app.use(base, sirv('./dist/client', { extensions: [] }))
}

// Serve HTML
app.use('*', async (req: Request, res: Response) => {
  try {
    const url = req.originalUrl.replace(base, '')

    let template: string
    let render: SSRModule['render']

    if (!isProduction) {
      // Always read fresh template in development
      template = await fs.readFile('./index.html', 'utf-8')
      template = await vite!.transformIndexHtml(url, template)
      const mod = await vite!.ssrLoadModule('/src/entry-server.tsx') as SSRModule
      render = mod.render
    } else {
      template = templateHtml
      const mod = await import('./dist/server/entry-server.js') as SSRModule
      render = mod.render
    }

    let didError = false

    const { pipe, abort } = render(url, ssrManifest, {
      onShellError() {
        res.status(500)
        res.set({ 'Content-Type': 'text/html' })
        res.send('<h1>Something went wrong</h1>')
      },
      onShellReady() {
        res.status(didError ? 500 : 200)
        res.set({ 'Content-Type': 'text/html' })

        const transformStream = new Transform({
          transform(
            chunk: Buffer,
            encoding: BufferEncoding,
            callback: TransformCallback
          ) {
            res.write(chunk, encoding)
            callback()
          },
        })

        const [htmlStart, htmlEnd] = template.split(`<!--app-html-->`)

        res.write(htmlStart)

        transformStream.on('finish', () => {
          res.end(htmlEnd)
        })

        pipe(transformStream)
      },
      onError(error: Error) {
        didError = true
        console.error(error)
      },
    })

    setTimeout(() => {
      abort()
    }, ABORT_DELAY)
  } catch (e: any) {
    vite?.ssrFixStacktrace(e)
    console.log(e.stack)
    res.status(500).end(e.stack)
  }
})

// Start http server
app.listen(port, () => {
  console.log(`Server started at http://localhost:${port}`)
})