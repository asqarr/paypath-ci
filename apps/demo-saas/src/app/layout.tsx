import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "PayPath Demo SaaS",
  description: "A test subscription application for PayPath CI proof of value.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
