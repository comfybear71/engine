import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Engine Studio",
  description: "Local script editor and timeline for the engine worker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full min-h-screen bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
