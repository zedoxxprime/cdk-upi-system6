import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UPI QR Extractor",
  description: "Extract UPI QR code from ChatGPT session credential.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
