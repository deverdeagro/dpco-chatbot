'use strict';

const XLSX = require('xlsx');

function excelDateToDDMMYYYY(value) {
  if (value instanceof Date) {
    const d = String(value.getDate()).padStart(2, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const y = value.getFullYear();
    return `${d}-${m}-${y}`;
  }
  return value == null ? '' : String(value).trim();
}

function readMrpRevRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets['MRP Rev'];
  if (!ws) throw new Error('Sheet "MRP Rev" not found in workbook');

  const raw = XLSX.utils.sheet_to_json(ws, { range: 1, defval: '' });

  const rows = [];
  for (const r of raw) {
    const brandName = String(r['Brand Name'] || '').trim();
    if (!brandName) continue;

    rows.push({
      srNo: r['Sr. No'],
      brandName,
      composition: String(r['Drug (Composition DCA)'] || '').trim(),
      dosage: String(r['Dosage (Product Type)'] || '').trim(),
      size: String(r['Size (Unit Pack)'] || '').trim(),
      manufacturer: String(r['Manufacturer'] || '').trim(),
      gstPct: r['GST %'],
      prevMrp: r[' Previous MRP'] !== undefined ? r[' Previous MRP'] : r['Previous MRp '],
      ptd: r['PTD Without GST'],
      ptr: r['PTR Without GST'],
      mrp: r['Revised MRP'],
      batchNo: String(r['Batch No'] || '').trim(),
      effectiveDate: excelDateToDDMMYYYY(r['Effective Date']),
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
