import type { ReactNode } from 'react';
import '@/ui/styles/photo-portfolio.css';
import { SiteHeader } from '@/ui/components/photo-portfolio/site-header';
import { SiteFooter } from '@/ui/components/photo-portfolio/site-footer';

export const metadata = {
  title: '林间 · 摄影作品集',
  description:
    '林间 — 摄影作品集。精选人像、风光、街头、建筑与生态摄影作品，安静地拍，慢慢地发。',
  openGraph: {
    title: '林间 · 摄影作品集',
    description: '精选人像、风光、街头、建筑与生态摄影作品。',
    type: 'website',
  },
};

export default function PhotoPortfolioLayout({ children }: { children: ReactNode }) {
  return (
    <div data-pp-scope className="pp-page">
      <SiteHeader />
      <main>{children}</main>
      <SiteFooter />
    </div>
  );
}
