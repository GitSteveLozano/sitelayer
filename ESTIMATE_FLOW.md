# SiteLayer Estimate Generator — User Flow

## The Happy Path (Cavy's workflow)

### 1. Project Setup (one-time)

```
Settings > Pricing Rates
├─ Stucco:          $4.50 / sqft
├─ Cultured Stone:  $12.00 / sqft
├─ Parging:         $2.50 / sqft
├─ Envelope Seal:   $75.00 / lf
└─ Trim & Flashing: $3.00 / sqft
```

Save rates → stored in company.metadata.rates

### 2. Project Creation

```
Projects > New Project
├─ Client: Gino's Homes
├─ Project: 215 Cinnamon Teal
├─ Address: [address from GC]
└─ Status: Bid (default)
```

### 3. Blueprint Upload & Measurement

```
Project > Documents Tab
└─ Upload Blueprint PDF (drag-drop or click)
   └─ Store in Supabase Storage
      └─ Open Measurement Canvas
         
         (Canvas opens with:
         - PDF rendered multi-page
         - Zoom + pan controls
         - Scale calibration (px/ft)
         - Color-coded scope items on left
         )
```

### 4. Draw Zones

```
Canvas Left Panel
├─ 🟧 Stucco
├─ 🟪 Cultured Stone
├─ 🟦 Parging
├─ 🟩 Envelope Seal
└─ 🟥 Trim & Flashing

User: Click scope item → click points on PDF → double-click to close
→ Polygon calculated (Shoelace formula)
→ Added to list below scope item with sqft
```

**Example drawing:**
```
Stucco (total: 1,250 sqft)
  └─ Zone 1 (p1): 850 sqft  [×]
  └─ Zone 2 (p2): 400 sqft  [×]

Cultured Stone (total: 450 sqft)
  └─ Zone 1 (p1): 450 sqft  [×]

Parging (total: 200 sqft)
  └─ Zone 1 (p1): 200 sqft  [×]
```

### 5. Live Estimate Preview (right panel)

```
Estimate Preview
──────────────────────────────────
Item                Qty    Rate    Amt
──────────────────────────────────
Stucco          1,250 sqft  $4.50  $5,625.00
Cultured Stone    450 sqft $12.00  $5,400.00
Parging           200 sqft  $2.50    $500.00
Envelope Seal      85 lf   $75.00  $6,375.00
Trim & Flashing   150 sqft  $3.00    $450.00
──────────────────────────────────
Subtotal:                        $18,350.00
GST (5%):                          $917.50
══════════════════════════════════
TOTAL:                           $19,267.50
```

(Updates as zones are drawn)

### 6. Apply to Project

Click "Generate Estimate →"

Backend:
```javascript
await projects.update(projectId, {
  sqft: 2185,  // total sqft
  metadata: {
    blueprint_measurements: {
      applied_at: "2026-04-04T10:45:00Z",
      summary: { Stucco: 1250, "Cultured Stone": 450, ... },
      totalSqft: 2185,
      estimate: [
        { item: "Stucco", qty: 1250, unit: "sqft", rate: 4.50, amount: 5625.00 },
        ...
      ],
      subtotal: 18350.00,
      gst: 917.50,
      total: 19267.50,
    }
  }
})
```

Canvas closes → Documents tab shows summary

### 7. Documents Tab (post-measurement)

```
Documents Tab
├─ Blueprint: blueprint.pdf
│  ├─ Last measured: Apr 4, 2026
│  └─ [✏️ Open Measurement Canvas]  [Replace]
│
├─ Generated Estimate
│  ├─ [⬇ Download PDF]
│  │
│  ├─ Item / Qty / Rate / Amount
│  ├─ Stucco / 1,250 sqft / $4.50 / $5,625.00
│  ├─ Cultured Stone / 450 sqft / $12.00 / $5,400.00
│  ├─ Parging / 200 sqft / $2.50 / $500.00
│  ├─ Envelope Seal / 85 lf / $75.00 / $6,375.00
│  ├─ Trim & Flashing / 150 sqft / $3.00 / $450.00
│  │
│  ├─ Subtotal: $18,350.00
│  ├─ GST (5%): $917.50
│  └─ Total: $19,267.50
```

Click "Download PDF" → saves as `215-Cinnamon-Teal-quote.pdf`

### 8. PDF Output

Professional quote ready to send to builder/customer:

```
[AMBER LOGO BAR] L&A Stucco Ltd
                                        QUOTE
925 Kapelus Dr, West St. Paul MB      # Q-2026-ABC1
cavy@lastucco.ca                       Date: Apr 4, 2026
GST: 813435252 RT0001                 Valid for 30 days
─────────────────────────────────────────────────────
PROJECT: 215 Cinnamon Teal      ADDRESS: [...]

DESCRIPTION          QTY      UNIT    RATE      AMOUNT
─────────────────────────────────────────────────────
Stucco            1,250.0    sqft    $4.50    $5,625.00
Cultured Stone      450.0    sqft   $12.00    $5,400.00
Parging             200.0    sqft    $2.50      $500.00
Envelope Seal        85.0     lf    $75.00    $6,375.00
Trim & Flashing     150.0    sqft    $3.00      $450.00
─────────────────────────────────────────────────────
                                Subtotal  $18,350.00
                                GST (5%)     $917.50
                                ═════════════════════
                                TOTAL      $19,267.50

NOTES:
• Quotes valid for 30 days unless otherwise noted
• Invoices past 30 days subject to 12% per annum interest
• Water and hydro to be supplied by GC / owner
• All street permits to be paid by General Contractor

────────────────────────────────────────────────────
Accepted By: _______________  Date: _______________

Thank you for your business!
www.lastucco.ca
```

## Edit Workflow (if rates change or need remeasurement)

### Scenario A: Change pricing rates

```
Settings > Pricing Rates
├─ Update Stucco: $4.50 → $5.00
└─ Save Rates
   └─ Stored in company.metadata

→ Go back to Project > Documents
→ Click [⬇ Download PDF]
→ New PDF has updated amounts (Stucco: 1250 × $5.00 = $6,250)
```

No need to remeasure — rates apply to saved sqft.

### Scenario B: Remeasure (builder added scope)

```
Project > Documents Tab
└─ [✏️ Open Measurement Canvas]
   └─ Load existing PDF + scale (cached)
   └─ Modify/add zones
   └─ [Generate Estimate →]
   └─ Overwrite project.sqft + measurements
   └─ New PDF generated

Documents tab shows updated summary + download
```

## Data Persistence

```
Database (Supabase)
├─ projects
│  ├─ id
│  ├─ blueprint_url (Supabase Storage signed URL)
│  ├─ sqft (total from measurements)
│  └─ metadata.blueprint_measurements
│     ├─ applied_at
│     ├─ summary (sqft per item)
│     ├─ totalSqft
│     ├─ estimate (line items)
│     ├─ subtotal
│     ├─ gst
│     └─ total
│
└─ companies
   ├─ id
   └─ metadata.rates
      ├─ Stucco: 4.50
      ├─ "Cultured Stone": 12.00
      ├─ Parging: 2.50
      ├─ "Envelope Seal": 75.00
      └─ "Trim & Flashing": 3.00
```

## Error Handling

| Scenario | Message | Action |
|----------|---------|--------|
| PDF too large (>50MB) | "File too large. Max 50MB." | Try smaller blueprint or split into sections |
| Wrong file type | "Please upload a PDF file." | Check file format |
| Scale not set | "Set scale before drawing" | Click 2 points, enter feet |
| No zones drawn | "Draw zones to generate estimate" | Click scope item + draw polygon |
| Rates not set | Uses defaults | Go to Settings to customize |

## Mobile/On-Site Considerations (Tier 2)

For now, canvas works best on desktop (large PDF, precise clicking). Tier-2 will add:

- **Tablet-optimized canvas** — larger touch targets
- **Measure tool** — integrate device camera for photo-based zones
- **Offline mode** — cache PDF for job sites without connection
- **Voice notes** — Cavy can record notes per zone

---

**Current Status:** MVP ready for Cavy testing  
**Deploy:** SiteLayer-v2 on GitHub Pages or Vercel  
**Next:** Gather feedback on PDF layout, rate suggestions, missing scope items
