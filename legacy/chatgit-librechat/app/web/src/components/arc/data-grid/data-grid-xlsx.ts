/**
 * A small .xlsx writer for the data grid, with no dependencies. It writes one worksheet with typed cells, Excel number formats for
 * number, currency, percent, and date columns, column widths, a bold frozen header row, outlined group rows with SUBTOTAL formulas,
 * and a bold totals row. Files are stored without compression, so they open everywhere but run larger than files Excel saves itself.
 * No React in here, so it also runs on the server.
 */
import { aggregate, defaultAggregate, isDate, isIsoDay, isNumeric, type DataGridAggregate, type DataGridColumn, type DataGridRow } from "./data-grid-model";

/** A group in an export: a heading row with subtotals, then its rows or nested groups. */
export interface DataGridExportGroup { label: string; children: DataGridExportNode[] }
export type DataGridExportNode = DataGridRow | DataGridExportGroup;

export interface DataGridXlsxOptions {
  /** Worksheet name. Defaults to "Sheet1". Excel allows 31 characters and no : \ / ? * [ ]. */
  sheetName?: string;
  /** Columns to freeze on the left, usually the pinned columns. Defaults to 0. */
  freezeColumns?: number;
  /** Adds a bold totals row under the data with SUBTOTAL formulas. Defaults to true. */
  totals?: boolean;
  /** Column widths in px, keyed by column key. Defaults to each column's width, or 140. */
  widths?: Record<string, number>;
}

const isGroup = (node: DataGridExportNode): node is DataGridExportGroup => Array.isArray((node as DataGridExportGroup).children);

/* SpreadsheetML */

const escapeXml = (text: string) => text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const colName = (index: number) => {
  let n = index + 1, out = "";
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
};

/** Excel counts days from 1899-12-30, so an ISO day becomes a whole serial number with no time zone in play. */
const serial = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5 + 25569;

/** SUBTOTAL skips other SUBTOTAL cells, so group subtotals and the grand total never count each other. */
const SUBTOTAL: Record<Exclude<DataGridAggregate, "none">, number> = { average: 1, count: 3, max: 4, min: 5, sum: 9 };

function numberFormat(column: DataGridColumn, kind?: DataGridAggregate) {
  if (kind === "count") return "#,##0";
  if (isDate(column)) return "mmm d, yyyy";
  const decimals = column.type === "percent" && kind === "average" ? Math.max(1, column.decimals ?? 0) : column.decimals ?? 0;
  const fraction = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
  if (column.type === "currency") return `"$"#,##0${fraction};-"$"#,##0${fraction}`;
  if (column.type === "percent") return `0${fraction}%`;
  return `#,##0${fraction}`;
}

/** Collects cell styles as they are used: a number format plus bold, deduplicated into cellXfs. */
function styleSheet() {
  const formats: string[] = [];
  const xfs: { fmt: number; bold: boolean }[] = [{ fmt: 0, bold: false }, { fmt: 0, bold: true }];
  const get = (code: string | null, bold: boolean) => {
    let fmt = 0;
    if (code) { let i = formats.indexOf(code); if (i < 0) { formats.push(code); i = formats.length - 1; } fmt = 164 + i; }
    let index = xfs.findIndex(x => x.fmt === fmt && x.bold === bold);
    if (index < 0) { xfs.push({ fmt, bold }); index = xfs.length - 1; }
    return index;
  };
  const xml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${formats.length ? `<numFmts count="${formats.length}">${formats.map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escapeXml(code)}"/>`).join("")}</numFmts>` : ""}<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.map(x => `<xf numFmtId="${x.fmt}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${x.fmt ? ' applyNumberFormat="1"' : ""}${x.bold ? ' applyFont="1"' : ""}/>`).join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return { get, xml };
}

function sheetXml(columns: DataGridColumn[], nodes: DataGridExportNode[], options: DataGridXlsxOptions, styles: ReturnType<typeof styleSheet>) {
  const rowsXml: string[] = [];
  let rowNumber = 0, maxLevel = 0;
  const kinds = columns.map(c => defaultAggregate(c));
  const text = (ref: string, value: string, bold = false) => `<c r="${ref}" t="inlineStr"${bold ? ` s="1"` : ""}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  const cell = (c: number, row: DataGridRow) => {
    const column = columns[c]!, ref = `${colName(c)}${rowNumber}`, v = row[column.key];
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${styles.get(isNumeric(column) ? numberFormat(column) : null, false)}"><v>${column.type === "percent" ? v / 100 : v}</v></c>`;
    if (isDate(column) && isIsoDay(v)) return `<c r="${ref}" s="${styles.get(numberFormat(column), false)}"><v>${serial(v)}</v></c>`;
    return text(ref, String(v));
  };
  const summary = (c: number, first: number, last: number, rows: DataGridRow[], bold: boolean) => {
    const column = columns[c]!, kind = kinds[c]!;
    if (kind === "none" || last < first) return "";
    const value = aggregate(rows, column, kind);
    const cached = value === null ? "" : `<v>${column.type === "percent" && kind !== "count" ? value / 100 : value}</v>`;
    const range = `${colName(c)}${first}:${colName(c)}${last}`;
    return `<c r="${colName(c)}${rowNumber}" s="${styles.get(numberFormat(column, kind), bold)}"><f>SUBTOTAL(${SUBTOTAL[kind]},${range})</f>${cached}</c>`;
  };
  const leaves = (node: DataGridExportNode): DataGridRow[] => isGroup(node) ? node.children.flatMap(leaves) : [node];
  const row = (cells: string, attrs = "") => `<row r="${rowNumber}"${attrs}>${cells}</row>`;

  rowNumber = 1;
  rowsXml.push(row(columns.map((column, c) => text(`${colName(c)}1`, column.label, true)).join("")));

  const write = (node: DataGridExportNode, level: number) => {
    if (!isGroup(node)) {
      rowNumber++;
      rowsXml.push(row(columns.map((_, c) => cell(c, node)).join(""), level ? ` outlineLevel="${Math.min(7, level)}"` : ""));
      return;
    }
    maxLevel = Math.max(maxLevel, level + 1);
    rowNumber++;
    const at = rowsXml.length, headerRow = rowNumber;
    rowsXml.push("");
    node.children.forEach(child => write(child, level + 1));
    const last = rowNumber, saved = rowNumber, rows = leaves(node);
    rowNumber = headerRow;
    const cells = columns.map((_, c) => c === 0 ? text(`A${headerRow}`, node.label, true) : summary(c, headerRow + 1, last, rows, true)).join("");
    rowsXml[at] = row(cells, level ? ` outlineLevel="${Math.min(7, level)}"` : "");
    rowNumber = saved;
  };
  nodes.forEach(node => write(node, 0));

  const lastData = rowNumber;
  if (options.totals !== false && columns.some((_, c) => kinds[c] !== "none")) {
    rowNumber++;
    const rows = nodes.flatMap(leaves);
    rowsXml.push(row(columns.map((_, c) => c === 0 && kinds[0] === "none" ? text(`A${rowNumber}`, "Total", true) : summary(c, 2, lastData, rows, true)).join("")));
  }

  const widths = columns.map(column => options.widths?.[column.key] ?? column.width ?? 140);
  const cols = `<cols>${widths.map((px, c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.max(4, Math.round(px / 7 * 100) / 100)}" customWidth="1"/>`).join("")}</cols>`;
  const freeze = Math.max(0, Math.min(columns.length - 1, options.freezeColumns ?? 0));
  const topLeft = `${colName(freeze)}2`;
  const pane = `<pane${freeze ? ` xSplit="${freeze}"` : ""} ySplit="1" topLeftCell="${topLeft}" activePane="${freeze ? "bottomRight" : "bottomLeft"}" state="frozen"/><selection pane="${freeze ? "bottomRight" : "bottomLeft"}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
  const dimension = `A1:${colName(Math.max(0, columns.length - 1))}${Math.max(1, rowNumber)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><outlinePr summaryBelow="0"/></sheetPr><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"${maxLevel ? ` outlineLevelRow="${Math.min(7, maxLevel)}"` : ""}/>${cols}<sheetData>${rowsXml.join("")}</sheetData></worksheet>`;
}

/* Zip, stored without compression */

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: { name: string; data: Uint8Array }[]) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), crc = crc32(file.data), size = file.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, 0, true); local.setUint16(12, 0x21, true); local.setUint32(14, crc, true); local.setUint32(18, size, true);
    local.setUint32(22, size, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, file.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true); entry.setUint16(12, 0, true); entry.setUint16(14, 0x21, true); entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true); entry.setUint32(24, size, true); entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Builds an .xlsx workbook with one sheet. Pass rows, or groups of rows to write outlined group rows with subtotals. */
export function toXlsx(columns: DataGridColumn[], nodes: DataGridExportNode[], options: DataGridXlsxOptions = {}): Uint8Array {
  const styles = styleSheet();
  const sheet = sheetXml(columns, nodes, options, styles);
  const name = escapeXml((options.sheetName ?? "Sheet1").replace(/[:\\/?*[\]]/g, " ").slice(0, 31).trim() || "Sheet1");
  const encoder = new TextEncoder();
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return zip([
    { name: "[Content_Types].xml", data: encoder.encode(`${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: "_rels/.rels", data: encoder.encode(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: encoder.encode(`${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheet) },
    { name: "xl/styles.xml", data: encoder.encode(styles.xml()) },
  ]);
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
