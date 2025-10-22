export interface BookMetadata {
  meta: AmazonBookMeta
  info: AmazonBookInfo
  nav: Nav
  toc: TocItem[]
  pages: PageChunk[]
  locationMap: AmazonRenderLocationMap
}

export interface Nav {
  startPosition: number // inclusive
  endPosition: number // inclusive?

  startContentPosition: number // inclusive
  startContentPage: number // inclusive

  endContentPosition: number // exclusive
  endContentPage: number // exclusive?

  totalNumPages: number
  totalNumContentPages: number
}

export interface PageChunk {
  index: number
  page: number
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

export type TocItem = {
  label: string
  positionId: number
  page?: number
  location?: number
  depth: number
} & (
  | {
      page: number
      location?: never
    }
  | {
      page?: never
      location: number
    }
)

/** Amazon's YT Metadata */
export interface AmazonBookMeta {
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
export interface AmazonBookInfo {
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

export interface AmazonRenderLocationMap {
  locations: number[]
  navigationUnit: Array<{
    startPosition: number
    page: number // derived
    label: string
  }>
}

export type AmazonRenderToc = Array<AmazonRenderTocItem>

export type AmazonRenderTocItem = {
  label: string
  tocPositionId: number
  entries?: AmazonRenderTocItem[]
}
