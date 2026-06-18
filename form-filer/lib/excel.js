'use strict';

const XLSX = require('xlsx');

function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Maps each field to a list of normalized header name patterns (first match wins).
const COLUMN_MAP = [
  { field: 'srNo',          patterns: ['sr. no', 'sr no', 's.no', 'sno', 'serial no', 'serial number'] },
  { field: 'brandName',     patterns: ['brand name', 'product name', 'brand'] },
  { field: 'composition',   patterns: ['drug (composition dca)', 'drug composition', 'composition', 'drug'] },
  { field: 'dosage',        patterns: ['dosage (product type)', 'dosage', 'product type', 'form'] },
  { field: 'size',          patterns: ['size (unit pack)', 'pack size', 'unit pack', 'size'] },
  { field: 'manufacturer',  patterns: ['manufacturer', 'manufacturer name', 'mfg name', 'mfg'] },
  { field: 'gstPct',        patterns: ['gst %', 'gst%', 'gst rate', 'gst'] },
  { field: 'prevMrp',       patterns: ['previous mrp', 'prev mrp', 'old mrp', 'previous mrp'] },
  { field: 'ptd',           patterns: ['ptd without gst', 'ptd'] },
  { field: 'ptr',           patterns: ['ptr without gst', 'ptr'] },
  { field: 'mrp',           patterns: ['revised mrp', 'new mrp', 'revised mrp (incl. gst)', 'mrp'] },
  { field: 'batchNo',       patterns: ['batch no', 'batch no.', 'batch number', 'batch'] },
  { field: 'effectiveDate', patterns: ['effective date', 'eff. date', 'eff date'] },
];

function excelDateToDDMMYYYY(value) {
  if (value instanceof Date) {
    const d = String(value.getDate()).padStart(2, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const y = value.getFullYear();
    return `${d}-${m}-${y}`;
  }
  return value == null ? '' : String(value).trim();
}

function findHeaderRowAndBuildMap(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const normalized = rawRows[i].map(normalizeHeader);
    if (!normalized.includes('brand name')) continue;

    // Header row found — build field → column-index map (first match per field)
    const colIdx = {};
    for (const { field, patterns } of COLUMN_MAP) {
      for (const pattern of patterns) {
        const idx = normalized.indexOf(pattern);
        if (idx !== -1) {
          colIdx[field] = idx;
          break;
        }
      }
    }

    const missing = COLUMN_MAP
      .filter(({ field }) => !(field in colIdx))
      .map(({ field }) => field);
    if (missing.length) {
      console.warn(`[WARN] Excel: could not map columns: ${missing.join(', ')}`);
    }

    return { headerRowIdx: i, colIdx };
  }
  throw new Error('Could not find header row — no "Brand Name" column found in the first 15 rows');
}

function readMrpRevRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets['MRP Rev'];
  if (!ws) throw new Error('Sheet "MRP Rev" not found in workbook');

  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
  const { headerRowIdx, colIdx } = findHeaderRowAndBuildMap(rawRows);

  const get = (row, field) => row[colIdx[field]] ?? '';

  const rows = [];
  for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const brandName = String(get(r, 'brandName')).trim();
    if (!brandName) continue;

    rows.push({
      srNo:          get(r, 'srNo'),
      brandName,
      composition:   String(get(r, 'composition')).trim(),
      dosage:        String(get(r, 'dosage')).trim(),
      size:          String(get(r, 'size')).trim(),
      manufacturer:  String(get(r, 'manufacturer')).trim(),
      gstPct:        get(r, 'gstPct'),
      prevMrp:       get(r, 'prevMrp'),
      ptd:           get(r, 'ptd'),
      ptr:           get(r, 'ptr'),
      mrp:           get(r, 'mrp'),
      batchNo:       String(get(r, 'batchNo')).trim(),
      effectiveDate: excelDateToDDMMYYYY(get(r, 'effectiveDate')),
    });
  }
  return rows;
}

function groupByManufacturer(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.manufacturer.toLowerCase().trim();
    if (!groups.has(key)) groups.set(key, { manufacturer: row.manufacturer, rows: [] });
    groups.get(key).rows.push(row);
  }
  return Array.from(groups.values());
}

module.exports = { readMrpRevRows, groupByManufacturer };
