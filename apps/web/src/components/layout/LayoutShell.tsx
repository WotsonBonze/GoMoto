'use client'

import { type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { useSidebar } from './SidebarContext'

interface LayoutShellProps {
  children: ReactNode
  userName?: string
  userEmail?: string
}

export function LayoutShell({ children, userName, userEmail }: LayoutShellProps) {
  const { expanded } = useSidebar()

  return (
    <div className="flex h-screen bg-bg">
      <Sidebar />
      <div
        className="flex-1 flex flex-col min-w-0 transition-[margin-left] duration-300 ease-in-out"
        style={{ marginLeft: expanded ? 256 : 64 }}
      >
        <Topbar userName={userName} userEmail={userEmail} />
        <main className="relative flex-1 min-h-0 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
