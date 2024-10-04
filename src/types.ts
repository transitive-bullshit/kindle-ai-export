export type ResourceType = 'EBOOK' | 'EBOOK_SAMPLE' | (string & {})
export type BookType = 'owned' | 'sample' | 'unknown'
export type OriginType = 'KINDLE_UNLIMITED' | 'PRIME' | 'COMICS_UNLIMITED'
export type SortType =
  | 'recency'
  | 'title'
  | 'author'
  | 'acquisition_desc'
  | 'acquisition_asc'

export interface Book {
  title: string
  asin: string
  authors: string[]
  mangaOrComicAsin: boolean
  resourceType: ResourceType
  originType: string
  productUrl: string
  webReaderUrl: string
}

export interface BookLightDetails {
  title: string
  bookType: BookType
  mangaOrComicAsin: boolean
  formatVersion: string
  progress: {
    reportedOnDevice: string
    position: number
    syncDate: Date
  }
  asin: string
  originType: string
  authors: string[]
  largeCoverUrl: string
  webReaderUrl: string
  srl: number
  metadataUrl: string
}

export interface BookDetails extends BookLightDetails {
  publisher?: string
  releaseDate: string
  startPosition: number
  endPosition: number
  percentageRead: number
}

export interface BooksQueryOptions {
  /**
   * Defines the order of the results.
   * The default is "recency".
   */
  sortType?: SortType

  originType?: OriginType

  /**
   * Request the next page of results.
   */
  paginationToken?: string

  /**
   * Set the number of results to return.
   * Default is 50.
   */
  querySize?: number

  /**
   * The results of the kindle api are paginated, by default only the first page is fetched.
   * When true, all results will be fetched if neccessary.
   * This will result in multiple requests to the kindle api (one for each page).
   * The default value is false.
   */
  fetchAllPages?: boolean
}

export type StartReadingBookResponse = {
  YJFormatVersion: string
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
  karamelToken: KaramelToken
  kindleSessionId: string
  lastPageReadData: {
    deviceName: string
    position: number
    syncTime: number
  }
  manifestUrl: any
  metadataUrl: string
  originType: string
  pageNumberUrl: any
  requestedAsin: string
  srl: number
}

export interface KaramelToken {
  token: string
  expiresAt: number
}

export interface BookMetadataResponse {
  ACR: string
  asin: string
  startPosition: number
  endPosition: number
  releaseDate: string
  title: string
  version: string
  sample: boolean
  authorList: string[]
  publisher: string
}

export interface DeviceInfo {
  clientHashId: string
  deviceName: string
  deviceSessionToken: string
  eid: string
}

export type RequiredCookies = {
  ubidMain: string
  atMain: string
  sessionId: string
  xMain: string
}

export type TLSClientConfig = {
  url: string
  apiKey: string
}

export type TLSClientRequestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface TLSClientRequestPayload {
  requestUrl: string
  requestMethod: TLSClientRequestMethod
  requestBody?: string
  requestCookies?: { [key: string]: string }[]
  tlsClientIdentifier?: string
  followRedirects?: boolean
  insecureSkipVerify?: boolean
  isByteResponse?: boolean
  withoutCookieJar?: boolean
  withDebug?: true
  withRandomTLSExtensionOrder?: boolean
  timeoutSeconds?: number
  sessionId?: string
  proxyUrl?: string
  headers?: Record<string, string>
  headerOrder?: string[]
  customTlsClient?: {
    ja3String: string
    h2Settings: {
      HEADER_TABLE_SIZE: number
      MAX_CONCURRENT_STREAMS: number
      INITIAL_WINDOW_SIZE: number
      MAX_HEADER_LIST_SIZE: number
    }
    h2SettingsOrder: string[]
    supportedSignatureAlgorithms: string[]
    supportedVersions: string[]
    keyShareCurves: string[]
    certCompressionAlgo: string
    pseudoHeaderOrder: string[]
    connectionFlow: number
    priorityFrames: string[]
  }
}

export interface TLSClientResponseData {
  status: number
  target: string
  body: string
  headers: Record<string, string[]>
  cookies: Record<string, string>
  sessionId?: string
}
