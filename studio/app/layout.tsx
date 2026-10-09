import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Engine Studio",
  description: "Local Assets and Stage for the engine worker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full min-h-screen bg-studio-bg text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
