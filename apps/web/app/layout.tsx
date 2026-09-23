import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { DialogProvider } from "@/components/dialogs";

export const metadata: Metadata = {
  title: "Palisade",
  description: "Self-hosted control panel for game dedicated servers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AppHeader />
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </AuthProvider>
        <DialogProvider />
      </body>
    </html>
  );
}
