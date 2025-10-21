import type { Locator } from 'patchright'
import type { Simplify, SimplifyDeep } from 'type-fest'

export interface BookMetadata {
  info: BookInfo
  meta: BookMeta
  toc: TocItem[]
  pages: PageChunk[]
}

export interface PageChunk {
  index: number
  page: number
  total: number
  screenshot: string
}

export interface ContentChunk {
  index: number
  page: number
  text: string
  screenshot: string
}

export interface PageNav {
  page?: number
  location?: number
  total: number
}

export type TocItem = SimplifyDeep<
  PageNav & {
    label: string
    tocPositionId?: number
    entries?: Simplify<Omit<TocItem, 'entries'>>[]
  }
>

export type $TocItem = Simplify<TocItem & { locator?: Locator }>

/** Amazon's YT Metadata */
export interface BookMeta {
  ACR: string
  asin: string
  authorList: Array<string>
  bookSize: string
  bookType: string
  cover: string
  language: string
  positions: {
    cover: number
    srl: number
    toc: number
  }
  publisher: string
  refEmId: string
  releaseDate: string
  sample: boolean
  title: string
  /** A hash unique to the book's version */
  version: string
  startPosition: number
  endPosition: number
}

/** Amazon's Karamel Book Metadata */
export interface BookInfo {
  clippingLimit: number
  contentChecksum: any
  contentType: string
  contentVersion: string
  deliveredAsin: string
  downloadRestrictionReason: any
  expirationDate: any
  format: string
  formatVersion: string
  fragmentMapUrl: any
  hasAnnotations: boolean
  isOwned: boolean
  isSample: boolean
  kindleSessionId: string
  lastPageReadData: {
    deviceName: string
    position: number
    syncTime: number
  }
  manifestUrl: any
  originType: string
  pageNumberUrl: any
  requestedAsin: string
  srl: number
}
