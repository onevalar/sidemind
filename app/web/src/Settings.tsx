import { useEffect, useState, type FormEvent } from "react";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { PasswordField } from "@/components/arc/password-field/password-field";
import { Badge } from "@/components/arc/badge/badge";
import { Select } from "@/components/arc/select/select";
import * as api from "./api";
import { lang, setLang, t, type Lang } from "./i18n";
import * as A from "./store";

/* 模型连接与界面设置：与打开 ChatGit 本身无关，按需配置 */
export function SettingsDialog() {
  const S = A.useApp();
  const names = Object.keys(S.endpoints).sort((a, b) => (S.endpoints[a].order ?? 0) - (S.endpoints[b].order ?? 0));
  return <Dialog open={S.settingsOpen} onOpenChange={(o) => A.openSettings(o)}>
    <DialogContent title={t("模型连接与设置")} description={t("ChatGit 把你选定的上下文发给这里连接的模型服务。")} className="cg-dialog cg-settings">
      <div className="cg-settings-body">
        {names.length === 0 && <p className="cg-muted">{t("服务端没有配置任何模型连接。")}</p>}
        {names.map((name) => {
          const info = S.endpoints[name];
          if (info.authMode === "chatgpt") return <ChatGPTConnection key={name} name={name} />;
          if (info.userProvide || info.userProvideURL) return <KeyConnection key={name} name={name} info={info} />;
          return <section key={name} className="cg-conn"><header><h3>{name}</h3><Badge size="sm" tone="success">{t("已由服务端配置")}</Badge></header>
            <p className="cg-muted">{t("可用模型：{n} 个", { n: S.models[name]?.length ?? 0 })}</p></section>;
        })}
        <section className="cg-conn">
          <header><h3>{t("界面语言")}</h3></header>
          <div className="cg-hide-label"><Select label={t("界面语言")} value={lang} onValueChange={(v) => setLang(v as Lang)}
            options={[{ value: "zh-Hans", label: "简体中文" }, { value: "zh-Hant", label: "繁體中文" }, { value: "en", label: "English" }]} /></div>
        </section>
      </div>
    </DialogContent>
  </Dialog>;
}

function KeyConnection({ name, info }: { name: string; info: api.EndpointInfo }) {
  const S = A.useApp();
  const [saved, setSaved] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => api.getKeyExpiry(name).then((r) => setSaved(r.expiresAt != null)).catch(() => setSaved(null));
  useEffect(() => { void load(); }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!apiKey.trim()) { setError(t("请填写 API Key。")); return; }
    if (info.userProvideURL && !/^https?:\/\/\S+$/.test(baseURL.trim())) { setError(t("服务地址需要以 http:// 或 https:// 开头，例如 https://api.example.com/v1")); return; }
    setBusy(true);
    try {
      await api.saveKey(name, { apiKey: apiKey.trim(), ...(info.userProvideURL ? { baseURL: baseURL.trim() } : {}) });
      setApiKey("");
      await load();
      await A.loadModels();
      A.notify({ type: "success", title: t("已保存“{name}”的连接", { name }) });
    } catch (err) {
      setError((err as Error).message || t("保存没有成功，请重试。"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.deleteKey(name); await load(); await A.loadModels(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <section className="cg-conn">
    <header><h3>{info.modelDisplayLabel || name}</h3>
      {saved === true && <Badge size="sm" tone="success">{t("已连接 · {n} 个模型", { n: S.models[name]?.length ?? 0 })}</Badge>}
      {saved === false && <Badge size="sm">{t("未连接")}</Badge>}</header>
    <p className="cg-muted">{t("任何兼容 OpenAI 接口的服务（含本地模型）。密钥加密保存在运行 ChatGit 的设备上。")}</p>
    <form className="cg-conn-form" onSubmit={submit} noValidate>
      {info.userProvideURL && <Input label={t("服务地址")} placeholder="https://api.example.com/v1" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} autoComplete="url" inputMode="url" spellCheck={false} />}
      <PasswordField label="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false}
        description={saved ? t("已保存的密钥不会显示；填写新的会替换它。") : undefined} aria-invalid={error ? true : undefined} aria-describedby={error ? `${name}-error` : undefined}
        messages={{ showPassword: t("显示密钥"), hidePassword: t("隐藏密钥") }} />
      {error && <p id={`${name}-error`} className="cg-field-error" role="alert">{error}</p>}
      <div className="cg-dialog-actions">
        {saved && <Button type="button" variant="ghost" disabled={busy} onClick={remove}>{t("移除连接")}</Button>}
        <Button type="submit" loading={busy}>{saved ? t("替换并保存") : t("保存连接")}</Button>
      </div>
    </form>
  </section>;
}

function ChatGPTConnection({ name }: { name: string }) {
  const [status, setStatus] = useState<api.ChatGPTStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.chatgptStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (status?.state !== "pending") return;
    const id = window.setInterval(async () => {
      const next = await api.chatgptStatus().catch(() => null);
      if (next) { setStatus(next); if (next.state === "connected") { window.clearInterval(id); await A.loadModels(); } }
    }, 2000);
    return () => window.clearInterval(id);
  }, [status?.state]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await load(); await A.loadModels(); } catch (err) { A.notify({ type: "error", title: t("操作没有完成"), description: (err as Error).message }); } finally { setBusy(false); } };
  const label = { connected: t("已连接"), disconnected: t("未连接"), pending: t("等待你在浏览器里完成授权"), reauth_required: t("需要重新授权"), disabled: t("不可用") } as const;
  return <section className="cg-conn">
    <header><h3>{name}</h3>{status && <Badge size="sm" tone={status.state === "connected" ? "success" : status.state === "reauth_required" ? "warning" : "neutral"}>{label[status.state]}</Badge>}</header>
    <p className="cg-muted">{t("使用你的 ChatGPT 订阅（与 Codex 相同的账号）。授权在 OpenAI 官方页面完成；不会改用 API 计费。")}</p>
    {status?.email && <p className="cg-muted">{status.email}</p>}
    {!status && <p className="cg-muted">{t("只有在本机模式下运行时才能连接 ChatGPT。")}</p>}
    {status && status.state !== "disabled" && <div className="cg-dialog-actions">
      {status.state === "connected"
        ? <Button variant="ghost" loading={busy} onClick={() => run(api.chatgptDisconnect)}>{t("断开连接")}</Button>
        : status.state === "pending"
          ? <Button variant="ghost" loading={busy} onClick={() => run(api.chatgptCancel)}>{t("取消授权")}</Button>
          : <Button loading={busy} onClick={() => run(async () => { const { authorizationUrl } = await api.chatgptLogin(); window.open(authorizationUrl, "_blank", "noopener"); })}>{t("用 ChatGPT 账号连接")}</Button>}
    </div>}
  </section>;
}
