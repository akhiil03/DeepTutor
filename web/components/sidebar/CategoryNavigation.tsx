'use client'

import { useId, useState, startTransition, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { m, useReducedMotion } from 'framer-motion'
import { CalendarDays, Columns3, MessageCircle, PenLine } from 'lucide-react'
import {
  HomeShelfIcon,
  LearningShelfIcon,
  PartnersShelfIcon,
  PersonalizationShelfIcon,
  ResourcesShelfIcon,
} from './ShelfIcons'
import { useTranslation } from 'react-i18next'
import Tooltip from '@/shared/ui/Tooltip'
import { categoryForPath, type NavigationCategory } from '@/lib/navigation'
import { navVisibleUnderPolicy } from './nav-entries'
import { useAuthStatus } from '@/hooks/useAuthStatus'
import { navigateTask } from '@/lib/workspace-scope'
import { OverviewRow } from './NavigationPrimitives'
import { SHORTCUTS } from '@/lib/shortcuts'
import type { LearningSessions } from './LearningNavigation'

// Feature libraries load when their category opens, not in every workspace.
const LearningNavigation = dynamic(() =>
  import('./LearningNavigation').then(module => module.LearningNavigation)
)
const PartnerNavigation = dynamic(() =>
  import('./PartnerNavigation').then(module => module.PartnerNavigation)
)
const ResourcesNavigation = dynamic(() =>
  import('./ResourcesNavigation').then(module => module.ResourcesNavigation)
)
const PersonalizationNavigation = dynamic(() =>
  import('./ResourcesNavigation').then(module => module.PersonalizationNavigation)
)

/**
 * The shelves, workspace content first. Partners and personalization belong
 * to the account — the same in every workspace — and sit past a divider so
 * the bar itself says which half a switch of workspace changes.
 */
export const CATEGORIES = [
  { id: 'home', label: 'navigation.home', icon: HomeShelfIcon, href: '/chat', account: false },
  { id: 'learning', label: 'navigation.learning', icon: LearningShelfIcon, href: '/learning', account: false },
  { id: 'resources', label: 'navigation.resources', icon: ResourcesShelfIcon, href: '/space', account: false },
  { id: 'partners', label: 'navigation.partners', icon: PartnersShelfIcon, href: '/partners', account: true },
  {
    id: 'personalization',
    label: 'navigation.personalization',
    icon: PersonalizationShelfIcon,
    href: '/personalization',
    account: true,
  },
] as const

/**
 * The workspace tools that sit in the rail beside the shelves. They own a page
 * rather than a shelf, so choosing one navigates but leaves the Home shelf —
 * and its conversation list — in the panel.
 */
export const WORKSPACE_TOOLS = [
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/kanban', label: 'Task Board', icon: Columns3 },
  { href: '/co-writer', label: 'Co-Writer', icon: PenLine },
] as const

export function useCategoryNavigation() {
  const pathname = usePathname()
  const { learningPolicy } = useAuthStatus()
  const categories = CATEGORIES.filter(item =>
    navVisibleUnderPolicy(item.href, learningPolicy?.allowedSurfaces ?? null)
  )
  const [visited, setVisited] = useState<NavigationCategory[]>([])
  const [selection, setSelection] = useState<{
    pathname: string
    category: NavigationCategory
  } | null>(null)
  const desired = selection?.pathname === pathname ? selection.category : categoryForPath(pathname)
  const category = categories.find(item => item.id === desired)?.id ?? categories[0]?.id ?? 'home'
  return {
    category,
    categories,
    visited,
    select: (next: NavigationCategory) => {
      startTransition(() => {
        setVisited(previous => [...new Set([...previous, category, next])])
        setSelection({ pathname, category: next })
      })
    },
    allowedSurfaces: learningPolicy?.allowedSurfaces ?? null,
  }
}
type Navigation = ReturnType<typeof useCategoryNavigation>

/**
 * The shelves, always drawn as the far-left rail: every shelf stacked in
 * icon form, account shelves below a divider. Choosing one both switches the
 * panel beside the rail and opens that shelf's page — the two never disagree
 * about where the learner is.
 */
export function CategoryTabs({ nav, onNavigate }: { nav: Navigation; onNavigate?: () => void }) {
  const { t } = useTranslation()
  const router = useRouter()
  const pathname = usePathname()
  const id = useId()
  const reduced = useReducedMotion()
  const select = (category: (typeof CATEGORIES)[number]) => {
    nav.select(category.id)
    navigateTask(category.href, router.push)
    onNavigate?.()
  }
  const workspace = nav.categories.filter(item => !item.account)
  const account = nav.categories.filter(item => item.account)
  const tools = WORKSPACE_TOOLS.filter(item =>
    navVisibleUnderPolicy(item.href, nav.allowedSurfaces)
  )
  const tool = (item: (typeof WORKSPACE_TOOLS)[number]) => {
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
    return (
      <Tooltip key={item.href} label={t(item.label)} side="right">
        <Link
          href={item.href}
          prefetch={false}
          aria-label={t(item.label)}
          aria-current={active ? 'page' : undefined}
          onClick={event => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey) onNavigate?.()
          }}
          className={`dt-rail-tool ${active ? 'is-active' : ''}`}
        >
          <item.icon size={20} strokeWidth={1.6} />
        </Link>
      </Tooltip>
    )
  }
  const tab = (item: (typeof CATEGORIES)[number]) => {
    const index = nav.categories.indexOf(item)
    const active = nav.category === item.id
    return (
      <Tooltip
        key={item.id}
        className={`dt-category-tab ${active ? 'is-active' : ''}`}
        label={t(item.label)}
        description={item.account ? t('navigation.accountShelf') : undefined}
        side="right"
        shortcut={SHORTCUTS.category(index)}
      >
        <button
          id={`category-${item.id}`}
          type="button"
          role="tab"
          aria-controls="category-content"
          aria-label={t(item.label)}
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          onKeyDown={event => {
            // Arrows move focus through the rail; the shelf opens on Enter or
            // Space, so arrowing past a shelf never navigates away from the
            // page the learner is reading.
            const delta = ['ArrowRight', 'ArrowDown'].includes(event.key)
              ? 1
              : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                ? -1
                : 0
            if (!delta && !['Home', 'End'].includes(event.key)) return
            event.preventDefault()
            // Account shelves live in their own tablist, so cycle within the
            // group the focused shelf belongs to rather than the whole rail.
            const group = Array.from(
              event.currentTarget
                .closest('[role="tablist"]')
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
            )
            const current = group.indexOf(event.currentTarget)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? group.length - 1
                  : (current + delta + group.length) % group.length
            group[next]?.focus()
          }}
          onClick={() => select(item)}
          className={active ? 'is-active' : ''}
        >
          {active && (
            <m.span
              layoutId={`category-pill-${id}`}
              className="dt-category-pill"
              transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            />
          )}
          <item.icon size={20} strokeWidth={1.6} />
          <span>{t(item.label)}</span>
        </button>
      </Tooltip>
    )
  }
  return (
    <div className="dt-category-bar is-collapsed dt-category-rail">
      <div
        role="tablist"
        aria-label={t('navigation.categories')}
        aria-orientation="vertical"
        className="dt-rail-shelves"
      >
        {workspace.map(tab)}
      </div>
      {tools.length > 0 && (
        <nav className="dt-rail-tools" aria-label={t('navigation.workspace')}>
          {tools.map(tool)}
        </nav>
      )}
      {account.length > 0 && (
        <>
          <span aria-hidden className="dt-rail-spacer" />
          {workspace.length > 0 && <span aria-hidden className="dt-category-divider" />}
          <div
            role="tablist"
            aria-label={t('navigation.accountShelf')}
            aria-orientation="vertical"
            className="dt-account-tabs"
          >
            {account.map(tab)}
          </div>
        </>
      )}
    </div>
  )
}

export function CategoryBody({
  nav,
  collapsed,
  sessions,
  learningSessions,
}: {
  nav: Navigation
  collapsed: boolean
  /** The home shelf's conversation records. */
  sessions: ReactNode
  /** Learning conversations, filed by the learning shelf under their records. */
  learningSessions?: LearningSessions
}) {
  const { t } = useTranslation()
  if (collapsed) return null
  return (
    <div
      id="category-content"
      role="tabpanel"
      aria-labelledby={`category-${nav.category}`}
      className={`dt-category-content ${['partners', 'learning'].includes(nav.category) ? 'dt-category-content-fixed' : ''}`}
    >
      {nav.category === 'home' && (
        <>
          {/* The tutor itself leads the shelf; workspace tools live in the rail. */}
          {navVisibleUnderPolicy('/chat', nav.allowedSurfaces) && (
            <OverviewRow href="/chat" label={t('navigation.chat')} icon={MessageCircle} />
          )}
          {sessions}
        </>
      )}
      {(nav.category === 'learning' || nav.visited.includes('learning')) && (
        <div hidden={nav.category !== 'learning'} className="dt-category-panel">
          <LearningNavigation active={nav.category === 'learning'} sessions={learningSessions} />
        </div>
      )}
      {(nav.category === 'partners' || nav.visited.includes('partners')) && (
        <div hidden={nav.category !== 'partners'} className="dt-category-panel">
          <PartnerNavigation active={nav.category === 'partners'} />
        </div>
      )}
      {(nav.category === 'resources' || nav.visited.includes('resources')) && (
        <div hidden={nav.category !== 'resources'}>
          <ResourcesNavigation />
        </div>
      )}
      {(nav.category === 'personalization' || nav.visited.includes('personalization')) && (
        <div hidden={nav.category !== 'personalization'}>
          <PersonalizationNavigation allowedSurfaces={nav.allowedSurfaces} />
        </div>
      )}
    </div>
  )
}
