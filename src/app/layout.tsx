import type { Metadata, Viewport } from 'next';
import { SiteNav } from '@/components/site-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Plataforma de Video',
  description: 'Plataforma privada de video en español',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <SiteNav />
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
