import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { ContentChunk } from './types'
import { assert, getEnv } from './utils'

interface ValidationIssue {
  index: number
  page: number
  type: string
  severity: 'error' | 'warning'
  message: string
  preview?: string
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const contentPath = path.join(outDir, 'content.json')

  console.log('Reading content.json...')
  const contentJson = await fs.readFile(contentPath, 'utf-8')
  const content: ContentChunk[] = JSON.parse(contentJson)

  console.log(`Validating ${content.length} pages...\n`)

  const issues: ValidationIssue[] = []

  for (const chunk of content) {
    const { index, page, text } = chunk

    // 1. Check for repetitive sentences (3+ times)
    const sentences = text.match(/[^.!?]+[.!?]+/g) || []
    const sentenceCounts = new Map<string, number>()
    for (const sentence of sentences) {
      const trimmed = sentence.trim()
      if (trimmed.length > 20) {
        sentenceCounts.set(trimmed, (sentenceCounts.get(trimmed) || 0) + 1)
        if (sentenceCounts.get(trimmed)! >= 3) {
          issues.push({
            index,
            page,
            type: 'repetitive_sentence',
            severity: 'error',
            message: `Sentence repeated ${sentenceCounts.get(trimmed)} times`,
            preview: trimmed.substring(0, 80)
          })
        }
      }
    }

    // 2. Check for excessive dashes or ellipsis (model looping on punctuation)
    const dashCount = (text.match(/—/g) || []).length
    const ellipsisCount = (text.match(/\.\.\./g) || []).length

    if (dashCount > 50) {
      issues.push({
        index,
        page,
        type: 'excessive_dashes',
        severity: 'error',
        message: `Contains ${dashCount} em-dashes (likely model loop)`,
        preview: text.substring(text.indexOf('—'), text.indexOf('—') + 100)
      })
    }

    if (ellipsisCount > 20) {
      issues.push({
        index,
        page,
        type: 'excessive_ellipsis',
        severity: 'error',
        message: `Contains ${ellipsisCount} ellipsis (likely model loop)`,
        preview: text.substring(text.indexOf('...'), text.indexOf('...') + 100)
      })
    }

    // 3. Check for very short text (possible OCR failure)
    if (text.length < 50) {
      issues.push({
        index,
        page,
        type: 'very_short_text',
        severity: 'warning',
        message: `Only ${text.length} characters`,
        preview: text
      })
    }

    // 4. Check for duplicate consecutive lines
    const lines = text.split('\n')
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === lines[i - 1] && lines[i]!.trim().length > 10) {
        issues.push({
          index,
          page,
          type: 'duplicate_line',
          severity: 'warning',
          message: 'Contains duplicate consecutive lines',
          preview: lines[i]!.substring(0, 80)
        })
        break // Only report once per page
      }
    }

    // 5. Check for duplicate consecutive words
    const duplicateWordMatch = text.match(/\b(\w+)\s+\1\b/)
    if (duplicateWordMatch) {
      issues.push({
        index,
        page,
        type: 'duplicate_word',
        severity: 'warning',
        message: `Duplicate word: "${duplicateWordMatch[1]}"`,
        preview: text.substring(duplicateWordMatch.index!, duplicateWordMatch.index! + 100)
      })
    }

    // 6. Check for unusual character patterns (gibberish)
    const gibberishPattern = /([a-z])\1{4,}/i // Same letter 5+ times in a row
    if (gibberishPattern.test(text)) {
      const match = text.match(gibberishPattern)
      issues.push({
        index,
        page,
        type: 'possible_gibberish',
        severity: 'warning',
        message: `Unusual character pattern detected`,
        preview: text.substring(match!.index!, match!.index! + 100)
      })
    }

    // 7. Check for very long text (possible repetition that's not sentence-based)
    if (text.length > 5000) {
      issues.push({
        index,
        page,
        type: 'unusually_long',
        severity: 'warning',
        message: `Text is ${text.length} characters (avg is ~800)`,
        preview: text.substring(0, 100)
      })
    }

    // 8. Check for incomplete sentences at the end (cut off mid-word)
    const lastSentence = sentences[sentences.length - 1]?.trim() || ''
    if (lastSentence.length > 0 && !lastSentence.match(/[.!?]$/)) {
      // Only warn if it doesn't end with common incomplete patterns like ellipsis
      if (!lastSentence.endsWith('...') && lastSentence.length > 50) {
        issues.push({
          index,
          page,
          type: 'incomplete_sentence',
          severity: 'warning',
          message: 'Last sentence appears incomplete',
          preview: lastSentence.substring(Math.max(0, lastSentence.length - 80))
        })
      }
    }
  }

  // Group and display issues
  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')

  console.log('=== VALIDATION REPORT ===\n')

  if (errors.length > 0) {
    console.log(`\n🔴 ERRORS (${errors.length}):`)
    console.log('These likely need manual review or re-processing:\n')

    for (const issue of errors) {
      console.log(`Page ${issue.page} (index ${issue.index}) - ${issue.type}`)
      console.log(`  ${issue.message}`)
      if (issue.preview) {
        console.log(`  Preview: ${issue.preview}...`)
      }
      console.log()
    }
  }

  if (warnings.length > 0) {
    console.log(`\n⚠️  WARNINGS (${warnings.length}):`)
    console.log('These might be fine, but worth checking:\n')

    // Group warnings by type
    const warningsByType = new Map<string, ValidationIssue[]>()
    for (const warning of warnings) {
      const existing = warningsByType.get(warning.type) || []
      existing.push(warning)
      warningsByType.set(warning.type, existing)
    }

    for (const [type, typeWarnings] of warningsByType) {
      console.log(`${type} (${typeWarnings.length} pages):`)
      for (const warning of typeWarnings.slice(0, 5)) { // Show first 5
        console.log(`  Page ${warning.page}: ${warning.message}`)
      }
      if (typeWarnings.length > 5) {
        console.log(`  ... and ${typeWarnings.length - 5} more`)
      }
      console.log()
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===')
  console.log(`Total pages: ${content.length}`)
  console.log(`Pages with errors: ${new Set(errors.map(i => i.index)).size}`)
  console.log(`Pages with warnings: ${new Set(warnings.map(i => i.index)).size}`)
  console.log(`Clean pages: ${content.length - new Set([...errors, ...warnings].map(i => i.index)).size}`)

  const successRate = ((content.length - new Set(errors.map(i => i.index)).size) / content.length * 100).toFixed(1)
  console.log(`\nSuccess rate (no errors): ${successRate}%`)

  // Save detailed report
  const reportPath = path.join(outDir, 'validation-report.json')
  await fs.writeFile(reportPath, JSON.stringify({ errors, warnings }, null, 2))
  console.log(`\nDetailed report saved to: ${reportPath}`)

  // List pages that need attention
  const problematicPages = [...new Set(errors.map(i => i.index))].sort((a, b) => a - b)
  if (problematicPages.length > 0) {
    console.log(`\nPages that need attention: ${problematicPages.join(', ')}`)
  }
}

await main()
