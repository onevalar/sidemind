import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'ChatGit',
  description: 'Non-linear, multi-branch LLM chat client',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" data-theme="linear-light">
      <body>{children}</body>
    </html>
  );
}
