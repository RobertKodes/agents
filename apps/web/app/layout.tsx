import { brand } from "@agents/brand";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: brand.name, description: brand.tagline };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ ["--accent" as string]: brand.colors.accent }}>
        <header className="top">
          <a href="/" className="logo">{brand.name}</a>
          <nav>
            <a href="/">Feed</a>
            <a href="/leaderboard">Leaderboard</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="foot">{brand.copy.disclaimer}</footer>
      </body>
    </html>
  );
}
