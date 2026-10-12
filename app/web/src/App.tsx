import { useEffect, useState, type MouseEvent } from "react";
import { Workflow, Plus, Settings, Pencil, Trash2, KeyRound } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { ThemeSwitch, type Theme } from "@/components/arc/theme-switch/theme-switch";
import { ToastStack, ToastStackProvider, useToastStack } from "@/components/arc/toast-stack/toast-stack";
import { Select } from "@/components/arc/select/select";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { ContextMenu } from "@/components/arc/context-menu/context-menu";
import { InlineEdit } from "@/components/arc/inline-edit/inline-edit";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Canvas } from "./Canvas";
import { Chat } from "./Chat";
import { SettingsDialog } from "./Settings";
import { editMessages, t } from "./i18n";
import type { View } from "./model";
import * as A from "./store";

function NotifyBridge() {
  const { toast } = useToastStack();
  useEffect(() => {
    A.setNotify((o) => { toast({ type: o.type ?? "info", title: o.title, description: o.description, action: o.action && { label: o.action.label, onClick: () => o.action!.onClick() } }); });
  }, [toast]);
  return null;
}

const root = document.documentElement;
const THEME_KEY = "chatgit.theme";
function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const S = A.useApp();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => { root.dataset.theme = theme; }, [theme]);
  useEffect(() => { void A.boot(); }, []);
  const onTheme = (next: Theme) => { localStorage.setItem(THEME_KEY, next); setTheme(next); };

  return <ToastStackProvider>
    <NotifyBridge />
    {S.session === "ready" ? <Workspace theme={theme} onTheme={onTheme} /> : <Gate />}
    <ToastStack position="bottom-left" label={t("通知")} />
  </ToastStackProvider>;
}

/* 未登录：本机模式需要通过启动器进入；账号模式去登录页 */
function Gate() {
  const S = A.useApp();
  if (S.session === "loading") return <div className="cg-gate" aria-busy="true"><span className="cg-muted">{t("正在打开 ChatGit…")}</span></div>;
  return <div className="cg-gate">
    {S.session === "signed-out-local"
      ? <EmptyState title={t("从本机启动器打开 ChatGit")} description={t("在运行 ChatGit 的这台设备上执行 npm run open，会自动打开你的私人工作区，不需要注册或密码。")} icon={<KeyRound size={20} />} />
      : <EmptyState title={t("需要登录")} description={t("这个 ChatGit 运行在账号模式。登录后会回到这里。")} icon={<KeyRound size={20} />}
          action={<Button onClick={() => { location.href = "/login"; }}>{t("去登录")}</Button>} />}
  </div>;
}

function Workspace({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  const S = A.useApp();
  const tp = S.topic;
  const live = tp ? [...tp.nodes.values()].filter((n) => n.status === "streaming").length : 0;
  const choices = A.availableModels();
  const current = A.currentModel();
  const value = current ? `${current.endpoint}\u0000${current.model}` : "";
  return <div className="cg-app" data-view={S.view}>
    <Sidebar />
    <main className="cg-main">
      <header className="cg-top">
        <div className="cg-title">
          {tp ? <h1><InlineEdit messages={editMessages()} value={tp.name} placeholder={t("未命名画布")} label={t("画布名称")} onSave={(v) => A.renameCanvas(tp.id, v)} /></h1> : <h1>ChatGit</h1>}
          {tp && tp.nodes.size > 0 && <span className="cg-meta">{t("{n} 个问题", { n: tp.nodes.size }) + (live ? t(" · {n} 个生成中", { n: live }) : "")}</span>}
        </div>
        <div className="cg-top-actions">
          {choices.length
            ? <div className="cg-model"><Select label={t("模型")} value={value} onValueChange={(v) => { const [endpoint, model] = v.split("\u0000"); void A.setModel({ endpoint, model }); }}
                options={choices.map((c) => ({ value: `${c.endpoint}\u0000${c.model}`, label: Object.keys(S.models).length > 1 ? `${c.model} · ${c.endpoint}` : c.model }))} /></div>
            : <Button size="sm" variant="secondary" onClick={() => A.openSettings()}><KeyRound size={14} aria-hidden="true" />{t("连接模型")}</Button>}
          <SegmentedControl label={t("视图")} value={S.view} onValueChange={(v) => A.setView(v as View)}
            options={[{ value: "canvas", label: t("画布") }, { value: "split", label: t("画布＋对话") }, { value: "chat", label: t("对话") }]} />
          <Tooltip content={t("模型连接与设置")} side="bottom"><Button size="sm" variant="ghost" aria-label={t("模型连接与设置")} onClick={() => A.openSettings()}><Settings size={16} /></Button></Tooltip>
          <ThemeSwitch theme={theme} iconOnly label={theme === "dark" ? t("切换到浅色外观") : t("切换到深色外观")} onThemeChange={(next) => onTheme(next)} />
        </div>
      </header>
      <div className="cg-work">
        {tp ? <>
          {S.view !== "chat" && <Canvas key={tp.id} />}
          {S.view !== "canvas" && <Chat key={tp.id} />}
        </> : <div className="cg-gate"><span className="cg-muted">{S.loadingTopic ? t("正在打开…") : ""}</span></div>}
      </div>
    </main>
    <SettingsDialog />
  </div>;
}

function Sidebar() {
  const S = A.useApp();
  const [doomed, setDoomed] = useState<{ id: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  return <aside className="cg-side" aria-label={t("研究画布")}>
    <div className="cg-brand">ChatGit</div>
    <Button variant="secondary" size="sm" className="cg-side-new" onClick={() => void A.newCanvas()}><Plus size={15} aria-hidden="true" />{t("新建画布")}</Button>
    <div className="cg-side-label">{t("画布")}</div>
    <nav className="cg-topics" aria-label={t("画布列表")}>
      {S.canvases.map((c) => renaming === c.id
        ? <div key={c.id} className="cg-row cg-topic" data-editing><InlineEdit messages={editMessages()} value={c.name} label={t("画布名称")} placeholder={t("未命名画布")} onSave={(v) => { setRenaming(null); return A.renameCanvas(c.id, v); }} /></div>
        : <ContextMenu key={c.id} label={t("画布操作：{name}", { name: c.name || t("未命名画布") })} items={[
            { id: "rename", label: t("重命名"), icon: <Pencil size={15} />, onSelect: () => setRenaming(c.id) },
            { id: "delete", label: t("删除…"), icon: <Trash2 size={15} />, destructive: true, onSelect: () => setDoomed({ id: c.id, name: c.name }) },
          ]}>
            <button type="button" className="cg-row cg-topic" tabIndex={-1} aria-current={c.id === S.topic?.id ? "page" : undefined} title={c.name || t("未命名画布")}
              onClick={(e: MouseEvent) => { e.stopPropagation(); if (c.id !== S.topic?.id) void A.openCanvas(c.id); }}>
              <Workflow size={15} aria-hidden="true" /><span className="cg-row-label">{c.name || t("未命名画布")}</span></button>
          </ContextMenu>)}
    </nav>
    <Dialog open={!!doomed} onOpenChange={(o) => { if (!o) setDoomed(null); }}>
      {doomed && <DialogContent className="cg-dialog" title={t("删除这张画布？")} description={t("「{name}」里的所有问答和草稿都会被删除，无法恢复。", { name: doomed.name || t("未命名画布") })}>
        <div className="cg-dialog-actions">
          <Button variant="secondary" onClick={() => setDoomed(null)}>{t("取消")}</Button>
          <Button variant="danger" onClick={() => { void A.removeCanvas(doomed.id); setDoomed(null); }}>{t("删除")}</Button>
        </div>
      </DialogContent>}
    </Dialog>
  </aside>;
}
