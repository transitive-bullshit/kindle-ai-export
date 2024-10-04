#!/usr/bin/env node
import 'dotenv/config'

import { KindleClient } from '../src'

async function main() {
  const kindle = new KindleClient()

  await kindle.init()
  console.log(JSON.stringify(kindle.books, null, 2))

  const bookDetails = await kindle.getBookDetails('B0819W19WD')
  console.log(JSON.stringify(bookDetails, null, 2))

  await kindle.getBookContent('B0819W19WD')
}

try {
  await main()
} catch (err) {
  console.error('error', err)
  process.exit(1)
}
