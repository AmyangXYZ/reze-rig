import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import { Analytics } from "@vercel/analytics/next"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Reze Rig — FBX to VMD",
  description:
    "Convert humanoid skeletal animations to MMD VMD in the browser. Auto rig detection (Mixamo, UE, Unity), any bind pose, any target PMX model.",
  keywords: ["MMD", "VMD", "FBX", "Animation", "Retarget", "Mixamo", "Unity", "WebGPU", "3D"],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark w-full m-0 p-0">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased w-full m-0 p-0`}
        style={{ backgroundColor: "#46ecd5" }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  )
}