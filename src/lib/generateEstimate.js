// ─── Estimate PDF Generator ─────────────────────────────────────────────────
// Generates a formatted quote PDF matching L&A Stucco's existing quote format.
// Uses jsPDF — no external API calls.

import { jsPDF } from 'jspdf'

/**
 * generateEstimatePDF({ company, project, estimate, subtotal, gst, total })
 * Returns a jsPDF doc — caller can .save() or .output('bloburl')
 */
export function generateEstimatePDF({ company, project, estimate, subtotal, gst, total }) {
  const doc   = new jsPDF({ unit: 'pt', format: 'letter' })
  const W     = doc.internal.pageSize.getWidth()
  const PAGE_BOTTOM = 720

  // ── Colors ────────────────────────────────────────────────────────────────
  const DARK   = [15, 15, 30]
  const MUTED  = [120, 120, 140]
  const AMBER  = [245, 165, 36]
  const BORDER = [220, 220, 230]
  const WHITE  = [255, 255, 255]

  let y = 40

  // ── Header: company logo block ────────────────────────────────────────────
  doc.setFillColor(...AMBER)
  doc.rect(40, y, 4, 60, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(...DARK)
  doc.text(company?.name || 'L&A Stucco Ltd', 54, y + 20)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  const companyMeta = [
    company?.address || '925 Kapelus Dr, West St. Paul MB',
    company?.email   || 'cavy@lastucco.ca',
    `GST/HST: ${company?.gst_number || '813435252 RT0001'}`,
  ]
  companyMeta.forEach((line, i) => doc.text(line, 54, y + 34 + i * 12))

  // ── Quote badge ────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(...AMBER)
  doc.text('QUOTE', W - 40, y + 20, { align: 'right' })

  const quoteNum = `Q-${new Date().getFullYear()}-${String(project?.id || '').slice(-4).toUpperCase() || Math.floor(Math.random() * 9000 + 1000)}`
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(`# ${quoteNum}`, W - 40, y + 34, { align: 'right' })
  doc.text(`Date: ${new Date().toLocaleDateString('en-CA')}`, W - 40, y + 46, { align: 'right' })
  doc.text('Valid for 30 days', W - 40, y + 58, { align: 'right' })

  y += 80

  // ── Divider ───────────────────────────────────────────────────────────────
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.5)
  doc.line(40, y, W - 40, y)
  y += 16

  // ── Bill to ────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('PROJECT', 40, y)
  doc.text('ADDRESS', W / 2, y)

  y += 12
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(...DARK)
  doc.text(project?.client_name || '—', 40, y)
  doc.text(project?.name || '—', W / 2, y)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  if (project?.address) {
    y += 12
    doc.text(project.address, W / 2, y)
  }

  y += 30

  // ── Line items table ───────────────────────────────────────────────────────
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.5)
  doc.line(40, y, W - 40, y)
  y += 2

  // Table header
  doc.setFillColor(245, 245, 250)
  doc.rect(40, y, W - 80, 20, 'F')
  y += 14

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)

  const COL = { qty: 340, unit: 390, rate: 460, amount: W - 40 }
  doc.text('DESCRIPTION', 48, y)
  doc.text('QTY', COL.qty, y, { align: 'right' })
  doc.text('UNIT', COL.unit, y, { align: 'right' })
  doc.text('RATE', COL.rate, y, { align: 'right' })
  doc.text('AMOUNT', COL.amount, y, { align: 'right' })

  y += 10
  doc.setDrawColor(...BORDER)
  doc.line(40, y, W - 40, y)
  y += 4

  // Line items
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...DARK)

  estimate.forEach((line, idx) => {
    if (y > PAGE_BOTTOM) { doc.addPage(); y = 60 }

    if (idx % 2 === 0) {
      doc.setFillColor(252, 252, 255)
      doc.rect(40, y - 2, W - 80, 18, 'F')
    }

    doc.setFont('helvetica', 'bold')
    doc.text(line.item, 48, y + 10)

    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...MUTED)
    doc.setFontSize(9)

    const qty = line.qty.toLocaleString('en', { maximumFractionDigits: 1 })
    doc.text(qty,                       COL.qty,    y + 10, { align: 'right' })
    doc.text(line.unit,                 COL.unit,   y + 10, { align: 'right' })
    doc.text(`$${line.rate.toFixed(2)}`, COL.rate,  y + 10, { align: 'right' })

    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...DARK)
    doc.setFontSize(10)
    doc.text(
      `$${line.amount.toLocaleString('en', { minimumFractionDigits: 2 })}`,
      COL.amount, y + 10, { align: 'right' }
    )

    y += 20
    doc.setDrawColor(...BORDER)
    doc.setLineWidth(0.25)
    doc.line(40, y - 2, W - 40, y - 2)
  })

  y += 12

  // ── Totals block ──────────────────────────────────────────────────────────
  const TOTALS_X = COL.rate + 10
  const VAL_X    = COL.amount

  const fmt = (n) => `$${n.toLocaleString('en', { minimumFractionDigits: 2 })}`

  // Subtotal
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...MUTED)
  doc.text('Subtotal', TOTALS_X, y)
  doc.text(fmt(subtotal), VAL_X, y, { align: 'right' })
  y += 16

  // GST
  doc.text('GST @ 5%', TOTALS_X, y)
  doc.text(fmt(gst), VAL_X, y, { align: 'right' })
  y += 6

  doc.setDrawColor(...AMBER)
  doc.setLineWidth(1)
  doc.line(TOTALS_X, y, VAL_X, y)
  y += 14

  // Total
  doc.setFillColor(...AMBER)
  doc.roundedRect(TOTALS_X - 8, y - 10, VAL_X - TOTALS_X + 16, 26, 4, 4, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(255, 255, 255)
  doc.text('TOTAL', TOTALS_X, y + 8)
  doc.text(fmt(total), VAL_X, y + 8, { align: 'right' })

  y += 40

  // ── Notes / Terms ─────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  const notes = [
    'Quotes are valid for 30 days unless otherwise noted.',
    'Invoices past 30 days are subject to 12% per annum interest, calculated monthly.',
    'Water and hydro to be supplied by GC / owner.',
    'All permits related to street use to be paid by General Contractor.',
  ]
  notes.forEach(n => {
    doc.text(`• ${n}`, 40, y)
    y += 12
  })

  y += 20

  // ── Acceptance ────────────────────────────────────────────────────────────
  if (y < PAGE_BOTTOM - 60) {
    doc.setDrawColor(...BORDER)
    doc.setLineWidth(0.5)
    doc.line(40, y, 200, y)
    doc.line(300, y, 460, y)
    y += 12
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text('Accepted By', 40, y)
    doc.text('Accepted Date', 300, y)
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  const PAGE_H = doc.internal.pageSize.getHeight()
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('Thank you for your business!', W / 2, PAGE_H - 24, { align: 'center' })
  doc.setTextColor(...AMBER)
  doc.text(company?.website || 'www.lastucco.ca', W / 2, PAGE_H - 12, { align: 'center' })

  return doc
}
