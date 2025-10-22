/* eslint-disable @typescript-eslint/no-non-null-asserted-optional-chain */
import type { PageNav, TocItem } from './types'
import { assert, deromanize } from './utils'

export function parsePageNav(text: string | null): PageNav | undefined {
  {
    // Parse normal page locations
    const match = text?.match(/page\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const page = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(page) || Number.isNaN(total)) {
        return undefined
      }

      return { page, total }
    }
  }

  {
    // Parse locations which are not part of the main book pages
    // (toc, copyright, title, etc)
    const match = text?.match(/location\s+(\d+)\s+of\s+(\d+)/i)
    if (match) {
      const location = Number.parseInt(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }

  {
    // Parse locations which use roman numerals
    const match = text?.match(/page\s+([cdilmvx]+)\s+of\s+(\d+)/i)
    if (match) {
      const location = deromanize(match?.[1]!)
      const total = Number.parseInt(match?.[2]!)
      if (Number.isNaN(location) || Number.isNaN(total)) {
        return undefined
      }

      return { location, total }
    }
  }
}

export function parseTocItems(
  tocItems: TocItem[],
  { totalNumPages }: { totalNumPages: number }
): {
  firstContentPageTocItem: TocItem
  firstPostContentPageTocItem?: TocItem
} {
  // Find the first page in the TOC which contains the main book content
  // (after the title, table of contents, copyright, etc)
  const firstContentPageTocItem = tocItems.find(
    (item) => item.page !== undefined
  )
  assert(firstContentPageTocItem, 'Unable to find first valid page in TOC')

  // Try to find the first page in the TOC after the main book content
  // (e.g. acknowledgements, about the author, etc)
  const firstPostContentPageTocItem = tocItems.find((item) => {
    if (item.page === undefined) return false
    if (item === firstContentPageTocItem) return false

    const percentage = item.page / totalNumPages
    if (percentage < 0.9) return false

    // (epilogue purposefully shortened here)
    if (/^epilog/i.test(item.label)) return false

    // heuristics for detecting post-book sections
    if (/acknowledgements/i.test(item.label)) return true
    if (/^discover more$/i.test(item.label)) return true
    if (/^extras$/i.test(item.label)) return true
    if (/about the author/i.test(item.label)) return true
    if (/meet the author/i.test(item.label)) return true
    if (/^also by /i.test(item.label)) return true
    if (/^copyright$/i.test(item.label)) return true
    if (/ teaser$/i.test(item.label)) return true
    if (/ preview$/i.test(item.label)) return true
    if (/^excerpt from/i.test(item.label)) return true
    if (/^excerpt:/i.test(item.label)) return true
    if (/^cast of characters$/i.test(item.label)) return true
    if (/^timeline$/i.test(item.label)) return true
    if (/^other titles/i.test(item.label)) return true
    if (/^other books/i.test(item.label)) return true
    if (/^other works/i.test(item.label)) return true
    if (/^newsletter/i.test(item.label)) return true

    return false
  })

  return {
    firstContentPageTocItem,
    firstPostContentPageTocItem
  }
}
