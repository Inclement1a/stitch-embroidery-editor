import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Стежок — редактор схемы вышивки",
  description: "Приватный интерактивный редактор схемы вышивки.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
