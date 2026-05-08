// Minimal root layout. KochHeute is an API-only Next.js app — there are
// no pages, only route handlers under /api/*. Next.js still requires this
// file to exist for the App Router to boot.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "KochHeute API",
  description: "Backend API for the KochHeute iOS app.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
