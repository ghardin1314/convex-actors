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
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Convex Actors Auction Demo' },
      {
        name: 'description',
        content:
          'A real-time auction house demo showcasing durable actors, sagas, reactive state, and crash recovery on Convex.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Convex Actors' },
      { property: 'og:title', content: 'Convex Actors Auction Demo' },
      {
        property: 'og:description',
        content:
          'Explore a live auction dashboard powered by Convex actors and sagas.',
      },
      { property: 'og:image', content: '/favicon.svg' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: 'Convex Actors Auction Demo' },
      {
        name: 'twitter:description',
        content:
          'A real-time auction dashboard powered by Convex actors and sagas.',
      },
      { name: 'theme-color', content: '#020617' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png',
      },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32x32.png',
      },
      { rel: 'manifest', href: '/site.webmanifest' },
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
            auction house
          </Link>
        </div>
      </div>
    </nav>
  )
}
