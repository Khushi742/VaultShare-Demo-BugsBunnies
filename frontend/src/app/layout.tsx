import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VaultShare | Private file transfer",
  description: "Share files privately with client-side encryption.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
