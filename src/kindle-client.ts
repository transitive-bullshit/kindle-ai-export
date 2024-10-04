import fs from 'node:fs/promises'

import defaultKy, { type KyInstance } from 'ky'
import pThrottle from 'p-throttle'

import type {
  Book,
  BookDetails,
  BookMetadataResponse,
  BooksQueryOptions,
  DeviceInfo,
  KaramelToken,
  RequiredCookies,
  StartReadingBookResponse,
  TLSClientRequestPayload,
  TLSClientResponseData
} from './types'
import {
  assert,
  deserializeCookies,
  getEnv,
  normalizeAuthors,
  parseJsonpResponse,
  serializeCookies,
  toLargeImage
} from './utils'

// Allow up to 3 requests per second by default.
const defaultThrottle = pThrottle({
  limit: 3,
  interval: 1000
})

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'

export class KindleClient {
  protected readonly deviceToken: string
  protected readonly baseUrl: string
  protected readonly clientVersion: string
  protected readonly cookies: RequiredCookies
  protected readonly tlsServerUrl: string
  protected readonly tlsServerApiKey: string
  protected readonly ky: KyInstance

  protected sessionId?: string
  protected adpSessionId?: string
  protected karamelToken?: KaramelToken

  public books: Book[] = []

  constructor({
    cookies = getEnv('KINDLE_COOKIES'),
    deviceToken = getEnv('KINDLE_DEVICE_TOKEN'),
    tlsServerUrl = getEnv('TLS_SERVER_URL'),
    tlsServerApiKey = getEnv('TLS_SERVER_API_KEY'),
    clientVersion = '20000100',
    baseUrl = 'https://read.amazon.com',
    throttle = true,
    ky = defaultKy
  }: {
    cookies?: RequiredCookies | string
    deviceToken?: string
    tlsServerUrl?: string
    tlsServerApiKey?: string
    clientVersion?: string
    baseUrl?: string
    throttle?: boolean
    ky?: KyInstance
  } = {}) {
    assert(
      cookies,
      'KindleClient missing required "cookies" (defaults to "KINDLE_COOKIES")'
    )
    assert(
      deviceToken,
      'KindleClient missing required "deviceToken" (defaults to "KINDLE_DEVICE_TOKEN")'
    )
    assert(
      tlsServerUrl,
      'KindleClient missing required "tlsServerUrl" (defaults to "TLS_SERVER_URL")'
    )
    assert(
      tlsServerApiKey,
      'KindleClient missing required "tlsServerApiKey" (defaults to "TLS_SERVER_API_KEY")'
    )

    this.baseUrl = baseUrl
    this.deviceToken = deviceToken
    this.clientVersion = clientVersion
    this.tlsServerUrl = tlsServerUrl
    this.tlsServerApiKey = tlsServerApiKey
    this.ky = ky.extend({
      hooks: {
        ...(throttle
          ? {
              beforeRequest: [
                // Enforce a default rate-limit to help evade detection.
                defaultThrottle(() => Promise.resolve(undefined))
              ]
            }
          : undefined)
      }
    })

    this.cookies =
      typeof cookies === 'string' ? deserializeCookies(cookies) : cookies
    this.sessionId = this.cookies.sessionId
  }

  async init() {
    const { sessionId, books } = await this._getAllBooks()
    this.books = books
    this.sessionId = sessionId

    await this.updateDeviceInfo()
  }

  async updateDeviceInfo(): Promise<DeviceInfo> {
    const params = new URLSearchParams({
      serialNumber: this.deviceToken,
      deviceType: this.deviceToken
    })
    const url = `${this.baseUrl}/service/web/register/getDeviceToken?${params.toString()}`
    const res = await this._request(url)
    const deviceInfo: DeviceInfo = JSON.parse(res.body)
    this.adpSessionId = deviceInfo.deviceSessionToken
    return deviceInfo
  }

  protected async _getAllBooks(opts: BooksQueryOptions = {}): Promise<{
    books: Book[]
    sessionId: string
  }> {
    const params: BooksQueryOptions = {
      sortType: 'recency',
      querySize: 50,
      fetchAllPages: false,
      ...opts
    }

    let allBooks: Book[] = []
    let latestSessionId: string | undefined

    do {
      const { books, sessionId, paginationToken } = await this._getBooks(params)

      latestSessionId = sessionId
      allBooks = allBooks.concat(books)

      if (
        !params.fetchAllPages ||
        !paginationToken ||
        (params.querySize !== undefined && allBooks.length > params.querySize)
      ) {
        break
      }

      params.paginationToken = paginationToken
    } while (true)

    return {
      books: allBooks,
      sessionId: latestSessionId
    }
  }

  protected async _getBooks(opts: BooksQueryOptions = {}): Promise<{
    books: Book[]
    sessionId: string
    paginationToken?: string
  }> {
    const url = new URL(
      `${this.baseUrl}/kindle-library/search?query=&libraryType=BOOKS&sortType=recency&querySize=50`
    )
    for (const [key, value] of Object.entries(opts)) {
      if (key === 'fetchAllPages') {
        continue // pagination handling is internal only and not part of the kindle api
      }

      if (value !== undefined) {
        url.searchParams.set(key, value.toString())
      } else {
        url.searchParams.delete(key)
      }
    }

    const res = await this._request(url.toString())
    if (!res.body) {
      throw new Error(
        'Failed to fetch books: you likely need to refresh your cookies'
      )
    }

    const sessionId = res.cookies['session-id']!

    const body = JSON.parse(res.body) as {
      itemsList: Array<Book & { percentageRead?: number }>
      paginationToken: string
    }

    return {
      books: body.itemsList.map(({ percentageRead: _, ...book }) => ({
        ...book,
        authors: normalizeAuthors(book.authors)
      })),
      sessionId,
      paginationToken: body.paginationToken
    }
  }

  async getBookDetails(asinOrBook: string | Book): Promise<BookDetails> {
    const book =
      typeof asinOrBook === 'string'
        ? ({
            asin: asinOrBook,
            ...this.books.find((b) => b.asin === asinOrBook)
          } as Book)
        : asinOrBook
    assert(book.asin)

    const res0 = await this._request(
      `${this.baseUrl}/service/mobile/reader/startReading?asin=${
        book.asin
      }&clientVersion=${this.clientVersion}`
    )
    const info = JSON.parse(res0.body) as StartReadingBookResponse
    this.karamelToken = info.karamelToken

    const res1 = await this._request(info.metadataUrl)
    const meta = parseJsonpResponse<BookMetadataResponse>(res1)
    assert(meta, `Failed to fetch metadata for book ${book.asin}`)

    const roughDecimal =
      ((meta.startPosition ?? 0) + info.lastPageReadData.position) /
      meta.endPosition

    // rounding 0.996 to 1
    const percentageRead = Number(roughDecimal.toFixed(3)) * 100

    return {
      ...book,
      bookType: info.isSample ? 'sample' : info.isOwned ? 'owned' : 'unknown',
      formatVersion: info.formatVersion,
      largeCoverUrl: toLargeImage(book.productUrl),
      metadataUrl: info.metadataUrl,
      progress: {
        reportedOnDevice: info.lastPageReadData.deviceName,
        position: info.lastPageReadData.position,
        syncDate: new Date(info.lastPageReadData.syncTime)
      },
      srl: info.srl,
      percentageRead,
      releaseDate: meta.releaseDate,
      startPosition: meta.startPosition,
      endPosition: meta.endPosition,
      publisher: meta.publisher
    }
  }

  async getBookContent(asin: string): Promise<void> {
    const params = {
      version: 3.0,
      asin,
      contentType: 'FullBook',
      revision: 'da38557c', // TODO?
      fontFamily: 'Bookerly',
      fontSize: 8.91,
      lineHeight: 1.4,
      dpi: 160,
      height: 222,
      width: 1384,
      marginBottom: 0,
      marginLeft: 9,
      marginRight: 9,
      marginTop: 0,
      maxNumberColumns: 2,
      theme: 'default',
      locationMap: true,
      packageType: 'TAR',
      encryptionVersion: 'NONE',
      numPage: 6,
      skipPageCount: 0,
      startingPosition: 162_515,
      bundleImages: false,
      token: this.karamelToken?.token
    }

    const url = new URL(`${this.baseUrl}/renderer/render`)

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, value.toString())
      } else {
        url.searchParams.delete(key)
      }
    }

    const { body, ...res } = await this._request(url.toString())
    console.log(res)

    if (!body) {
      throw new Error(
        'Failed to fetch book content: you likely need to refresh your cookies'
      )
    }

    await fs.writeFile(`out/${asin}.tar`, body)
  }

  /**
   * Sends a request to the Amazon Kindle API proxied through the TLS server.
   */
  protected async _request(
    url: string,
    payload?: TLSClientRequestPayload
  ): Promise<TLSClientResponseData> {
    const headers: Record<string, string> = {
      Cookie: serializeCookies(this.cookies),
      'Accept-Language': 'en-US,en;q=0.9,ko-KR;q=0.8,ko;q=0.7',
      'User-Agent': USER_AGENT,
      ...payload?.headers
    }

    if (this.sessionId) {
      headers['x-amzn-sessionid'] = this.sessionId
    }

    if (this.adpSessionId) {
      headers['x-adp-session-token'] = this.adpSessionId
    }

    const tlsPayload = {
      tlsClientIdentifier: 'chrome_112', // TODO: update & make configurable
      requestUrl: url,
      requestMethod: 'GET',
      withDebug: true,
      headers
    } satisfies TLSClientRequestPayload

    return this.ky
      .post(`${this.tlsServerUrl}/api/forward`, {
        json: tlsPayload,
        headers: {
          'x-api-key': this.tlsServerApiKey
        }
      })
      .json<TLSClientResponseData>()
  }
}
