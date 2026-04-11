import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import * as React from 'react'
import type { QueryClient } from '@tanstack/react-query'
import appCss from '~/styles/app.css?url'

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'TanStack Start Starter',
      },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32x32.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/favicon-16x16.png',
      },
      { rel: 'manifest', href: '/site.webmanifest', color: '#fffff' },
      { rel: 'icon', href: '/favicon.ico' },
    ],
  }),
  notFoundComponent: () => <div>Route not found</div>,
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        <TopNav />
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function TopNav() {
  return (
    <nav className="bg-gray-950 border-b border-gray-800 text-gray-300 text-sm">
      <div className="max-w-5xl mx-auto px-4 h-10 flex items-center gap-5">
        <span className="font-mono font-semibold text-gray-200">
          convex-actors
        </span>
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className="hover:text-gray-100"
            activeOptions={{ exact: true }}
            activeProps={{ className: 'text-emerald-300 font-semibold' }}
          >
            framework demos
          </Link>
          <Link
            to="/auctions"
            className="hover:text-gray-100"
            activeProps={{ className: 'text-emerald-300 font-semibold' }}
          >
            auction house
          </Link>
        </div>
      </div>
    </nav>
  )
}
