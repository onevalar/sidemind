"use client";

import { useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check, ChevronDown, Columns3, Download, EyeOff, FileSpreadsheet, FileText, Group, ListFilter, Minus, Pin, PinOff, Rows2, Rows3, Rows4, Search, Ungroup, X } from "lucide-react";
import type { DataGridColumn, DataGridDensity } from "./data-grid-model";
import styles from "./data-grid.module.css";

const icon = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

/** A compact square checkbox. The grid owns keyboard selection, so row boxes stay out of the tab order. */
export function GridCheckbox({ checked, label, onToggle, tabbable = false }: { checked: boolean | "mixed"; label: string; onToggle: (e: ReactMouseEvent<HTMLButtonElement>) => void; tabbable?: boolean }) {
  return <button type="button" role="checkbox" aria-checked={checked === "mixed" ? "mixed" : checked} aria-label={label} tabIndex={tabbable ? 0 : -1}
    className={styles.checkbox} data-state={checked === "mixed" ? "mixed" : checked ? "on" : "off"}
    onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggle(e); }}>
    <span className={styles.checkboxMark} aria-hidden="true">{checked === "mixed" ? <Minus size={12} strokeWidth={2.25} /> : <Check size={12} strokeWidth={2.25} />}</span>
  </button>;
}

export function HeaderMenu({ column, sorted, pinned, canHide, grouped = false, onSort, onFilter, onGroup = null, onPin, onHide }: {
  column: DataGridColumn; sorted: "asc" | "desc" | null; pinned: boolean; canHide: boolean; grouped?: boolean;
  onSort: (dir: "asc" | "desc" | null) => void; onFilter: (() => void) | null; onGroup?: (() => void) | null; onPin: () => void; onHide: () => void;
}) {
  const sortable = column.sortable !== false;
  return <Menu.Root modal={false}>
    <Menu.Trigger className={styles.headMenuButton} aria-label={`${column.label} column options`} onPointerDown={e => e.stopPropagation()}>
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className={styles.menu} align="end" sideOffset={4} collisionPadding={10} onCloseAutoFocus={e => e.preventDefault()}>
        {sortable && <>
          <Menu.Item className={styles.menuItem} data-active={sorted === "asc" || undefined} onSelect={() => onSort("asc")}><ArrowUpNarrowWide {...icon} />Sort ascending</Menu.Item>
          <Menu.Item className={styles.menuItem} data-active={sorted === "desc" || undefined} onSelect={() => onSort("desc")}><ArrowDownWideNarrow {...icon} />Sort descending</Menu.Item>
          {sorted && <Menu.Item className={styles.menuItem} onSelect={() => onSort(null)}><X {...icon} />Clear sort</Menu.Item>}
          <Menu.Separator className={styles.menuSeparator} />
        </>}
        {onFilter && <Menu.Item className={styles.menuItem} onSelect={onFilter}><ListFilter {...icon} />Filter</Menu.Item>}
        {onGroup && <Menu.Item className={styles.menuItem} onSelect={onGroup}>{grouped ? <Ungroup {...icon} /> : <Group {...icon} />}{grouped ? "Stop grouping" : `Group by ${column.label}`}</Menu.Item>}
        <Menu.Item className={styles.menuItem} onSelect={onPin}>{pinned ? <PinOff {...icon} /> : <Pin {...icon} />}{pinned ? "Unpin column" : "Pin column"}</Menu.Item>
        <Menu.Item className={styles.menuItem} disabled={!canHide} onSelect={onHide}><EyeOff {...icon} />Hide column</Menu.Item>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

export function ColumnsMenu({ columns, hidden, pinned, onToggle, onShowAll }: { columns: DataGridColumn[]; hidden: Set<string>; pinned: Set<string>; onToggle: (key: string) => void; onShowAll: () => void }) {
  const visibleCount = columns.length - columns.filter(c => hidden.has(c.key)).length;
  return <Menu.Root modal={false}>
    <Menu.Trigger className={styles.toolButton} aria-label="Columns">
      <Columns3 {...icon} /><span className={styles.toolLabel}>Columns</span>
      {hidden.size > 0 && <span className={styles.toolCount}>{visibleCount}/{columns.length}</span>}
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className={styles.menu} align="end" sideOffset={6} collisionPadding={10}>
        <div className={styles.menuScroll}>
          {columns.map(column => {
            const shown = !hidden.has(column.key);
            return <Menu.CheckboxItem key={column.key} className={styles.menuItem} checked={shown} disabled={shown && visibleCount === 1}
              onSelect={e => e.preventDefault()} onCheckedChange={() => onToggle(column.key)}>
              <span className={styles.menuCheck} data-on={shown || undefined} aria-hidden="true"><Check size={12} strokeWidth={2.25} /></span>
              <span className={styles.menuText}>{column.label}</span>
              {pinned.has(column.key) && <Pin size={14} strokeWidth={1.75} className={styles.menuMeta} aria-label="Pinned" />}
            </Menu.CheckboxItem>;
          })}
        </div>
        <Menu.Separator className={styles.menuSeparator} />
        <Menu.Item className={styles.menuItem} disabled={hidden.size === 0} onSelect={e => { e.preventDefault(); onShowAll(); }}>Show all columns</Menu.Item>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

export type DataGridExportFormat = "csv" | "xlsx";
const exportLabels: Record<DataGridExportFormat, { label: string; icon: ReactNode }> = {
  csv: { label: "CSV", icon: <FileText {...icon} /> },
  xlsx: { label: "Excel workbook", icon: <FileSpreadsheet {...icon} /> },
};

/** Export: one button for one format, or a menu that names each format. */
export function ExportMenu({ formats, disabled = false, onExport }: { formats: DataGridExportFormat[]; disabled?: boolean; onExport: (format: DataGridExportFormat) => void }) {
  const only = formats.length === 1 ? formats[0] : undefined;
  if (only) return <button type="button" className={styles.toolButton} aria-label={`Export ${only === "csv" ? "CSV" : "Excel workbook"}`} onClick={() => onExport(only)} disabled={disabled}>
    <Download {...icon} /><span className={styles.toolLabel}>Export</span>
  </button>;
  return <Menu.Root modal={false}>
    <Menu.Trigger className={styles.toolButton} aria-label="Export" disabled={disabled}><Download {...icon} /><span className={styles.toolLabel}>Export</span></Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className={styles.menu} align="end" sideOffset={6} collisionPadding={10}>
        {formats.map(format => <Menu.Item key={format} className={styles.menuItem} onSelect={() => onExport(format)}>
          {exportLabels[format].icon}<span className={styles.menuText}>{exportLabels[format].label}</span><span className={styles.menuMeta}>.{format}</span>
        </Menu.Item>)}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

const densities: { value: DataGridDensity; label: string; icon: ReactNode }[] = [
  { value: "compact", label: "Compact", icon: <Rows4 {...icon} /> },
  { value: "standard", label: "Standard", icon: <Rows3 {...icon} /> },
  { value: "comfortable", label: "Comfortable", icon: <Rows2 {...icon} /> },
];

export function DensityMenu({ density, onChange }: { density: DataGridDensity; onChange: (density: DataGridDensity) => void }) {
  const current = densities.find(d => d.value === density) ?? densities[1];
  return <Menu.Root modal={false}>
    <Menu.Trigger className={styles.toolButton} aria-label={`Row density, ${current.label.toLowerCase()}`}>{current.icon}</Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className={styles.menu} align="end" sideOffset={6} collisionPadding={10}>
        <Menu.RadioGroup value={density} onValueChange={value => onChange(value as DataGridDensity)}>
          {densities.map(d => <Menu.RadioItem key={d.value} value={d.value} className={styles.menuItem}>
            {d.icon}<span className={styles.menuText}>{d.label}</span>
            <Menu.ItemIndicator className={styles.menuMeta}><Check size={14} strokeWidth={2} /></Menu.ItemIndicator>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

/** The filter for a select column: a checklist of values, searchable when the list is long. */
export function SelectFilter({ column, options, value, onChange }: { column: DataGridColumn; options: string[]; value: string[] | undefined; onChange: (value: string[] | undefined) => void }) {
  const [query, setQuery] = useState("");
  const kept = useMemo(() => new Set(value ?? options), [value, options]);
  const shown = useMemo(() => { const q = query.trim().toLowerCase(); return q ? options.filter(o => (o || "Empty").toLowerCase().includes(q)) : options; }, [options, query]);
  const summary = value === undefined ? "All" : value.length === 0 ? "None" : value.length === 1 ? (value[0] || "Empty") : `${value.length} of ${options.length}`;
  const toggle = (option: string) => {
    const next = new Set(kept);
    if (next.has(option)) next.delete(option); else next.add(option);
    onChange(next.size === options.length ? undefined : options.filter(o => next.has(o)));
  };
  return <Popover.Root onOpenChange={open => { if (!open) setQuery(""); }}>
    <Popover.Trigger className={styles.filterSelect} data-filter-key={column.key} data-active={value !== undefined || undefined} aria-label={`Filter ${column.label}, ${summary}`}>
      <span className={styles.filterSelectText}>{summary}</span><ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className={styles.menu} align="start" sideOffset={4} collisionPadding={10} aria-label={`Filter ${column.label}`}>
        {options.length > 7 && <label className={styles.menuSearch}>
          <Search size={14} strokeWidth={1.75} aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search values" aria-label="Search values" spellCheck={false} />
        </label>}
        <div className={styles.menuScroll} role="group" aria-label={`${column.label} values`}>
          {shown.map(option => {
            const on = kept.has(option);
            return <button key={option || "\u0000"} type="button" role="checkbox" aria-checked={on} className={styles.menuItem} onClick={() => toggle(option)}>
              <span className={styles.menuCheck} data-on={on || undefined} aria-hidden="true"><Check size={12} strokeWidth={2.25} /></span>
              <span className={styles.menuText} data-muted={!option || undefined}>{option || "Empty"}</span>
            </button>;
          })}
          {!shown.length && <p className={styles.menuEmpty}>No matching values</p>}
        </div>
        <div className={styles.menuFooter}>
          <button type="button" className={styles.menuLink} disabled={value === undefined} onClick={() => onChange(undefined)}>Select all</button>
          <button type="button" className={styles.menuLink} disabled={value !== undefined && value.length === 0} onClick={() => onChange([])}>Clear</button>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
