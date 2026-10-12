/* 界面文案：简体中文原文即键；英文与繁体中文在 locales.ts。缺失时回退到简体中文。 */
import { LOCALES } from "./locales";

export type Lang = "zh-Hans" | "zh-Hant" | "en";
const KEY = "chatgit.lang";

function detect(): Lang {
  const saved = localStorage.getItem(KEY) as Lang | null;
  if (saved === "zh-Hans" || saved === "zh-Hant" || saved === "en") return saved;
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.startsWith("zh")) return /tw|hk|mo|hant/.test(nav) ? "zh-Hant" : "zh-Hans";
  return "en";
}

export let lang: Lang = detect();
document.documentElement.lang = lang === "en" ? "en" : lang === "zh-Hant" ? "zh-Hant" : "zh-CN";

export function setLang(next: Lang) {
  localStorage.setItem(KEY, next);
  location.reload();
}

export function t(key: string, vars?: Record<string, string | number>) {
  const text = lang === "zh-Hans" ? key : LOCALES[lang][key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")) : text;
}

/* Arc 组件内置的英文提示，通过 messages 传入译文 */
export const editMessages = () => ({ activate: t("激活以编辑。"), saveCancel: t("Enter 保存，Escape 取消。"), saveNewlineCancel: t("Enter 保存，Shift + Enter 换行，Escape 取消。") });
export const copyMessages = () => ({ copied: t("已复制"), failed: t("复制失败"), couldNotCopy: t("无法复制") });
