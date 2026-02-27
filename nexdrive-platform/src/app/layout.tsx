import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'NexDrive Academy — Professional Driving Instruction, Canberra ACT',
  description: 'Learn to drive with real judgment. CBT&A certified instruction in Canberra, ACT. Book a lesson with NexDrive Academy.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en" className={inter.variable}>
        <head>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
        </head>
        <body className="bg-primary text-white antialiased overflow-x-hidden selection:bg-accent selection:text-primary">
          {/* Noise overlay */}
          <div className="noise-overlay" aria-hidden="true" />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
